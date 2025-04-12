import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { IAuthStateProvider, ILogger } from "@wha.ts/core/src/client";
import {
	type PreKeySignalMessage,
	PreKeySignalMessageSchema,
	type SignalMessage,
	SignalMessageSchema,
} from "@wha.ts/proto/gen/signal_pb";
import {
	bytesToBase64,
	bytesToUtf8,
	concatBytes,
	utf8ToBytes,
} from "@wha.ts/utils/src/bytes-utils";
import {
	aesDecryptGCM,
	aesEncryptGCM,
	hkdf,
	hmacSign,
} from "@wha.ts/utils/src/crypto";
import { Curve } from "@wha.ts/utils/src/curve";
import { BufferJSON } from "@wha.ts/utils/src/serializer";
import type { KeyPair } from "@wha.ts/utils/src/types";
import { Mutex } from "async-mutex";
import type {
	EncryptedSignalMessage,
	ISignalProtocolManager,
} from "./interface";

// --- Constants (Adapt from libsignal-node/crypto) ---
const HKDF_INFO_MESSAGE_KEYS = "WhisperMessageKeys";
const HKDF_INFO_DERIVED_SECRETS = "WhisperText"; // For initial session setup
const HKDF_INFO_RATCHET = "WhisperRatchet";
const MAX_MESSAGE_KEYS = 2000; // Limit lookahead

// --- Internal State Structures (Simplified from SessionRecord/SessionEntry) ---
interface SignalSession {
	registrationId: number; // Remote registration ID
	currentRatchet: {
		rootKey: Uint8Array;
		ephemeralKeyPair: KeyPair; // Our current ephemeral key for sending/last one for receiving
		lastRemoteEphemeralKey: Uint8Array;
		previousCounter: number; // For receiving chain
	};
	sendingChain?: SignalChain;
	receivingChains: { [ephemeralKeyB64: string]: SignalChain }; // Map base64 of remote ephemeral key to chain
	// Simplified: We only store the *current* active session state.
	// libsignal-node's SessionRecord stores history, which adds complexity.
	// We'll rely on the state provider to persist this whole object as a blob.
	pendingPreKey?: {
		// Only set immediately after initOutgoing before first message received
		preKeyId?: number;
		signedKeyId: number;
		baseKey: Uint8Array; // Our base key used for setup
	};
}

interface SignalChain {
	messageKeys: { [counter: number]: Uint8Array }; // Map counter to message key
	chainKey: {
		counter: number;
		key?: Uint8Array; // Undefined if chain is finished
	};
	// chainType: ChainType.SENDING | ChainType.RECEIVING; // Implicit based on where it's stored in SignalSession
}

export class SignalManager implements ISignalProtocolManager {
	private sessionLocks: Map<string, Mutex> = new Map();

	constructor(
		private authState: IAuthStateProvider,
		private logger: ILogger,
	) {}

	// --- Concurrency Helper ---
	private async runWithSessionLock<T>(
		jid: string,
		action: (
			session: SignalSession | null,
		) => Promise<{ result: T; updatedSession?: SignalSession | null }>,
	): Promise<T> {
		let lock = this.sessionLocks.get(jid);
		if (!lock) {
			lock = new Mutex();
			this.sessionLocks.set(jid, lock);
		}

		return lock.runExclusive(async () => {
			const existingData = await this.authState.keys.get("session", [jid]);
			let currentSession: SignalSession | null = null;
			if (existingData[jid]) {
				// TODO: Robust deserialization needed if session is stored complexly.
				// Assuming it's stored as a JSON blob for now (needs BufferJSON reviver logic)
				try {
					currentSession = JSON.parse(
						bytesToUtf8(existingData[jid]),
						BufferJSON.reviver,
					);
				} catch (e) {
					this.logger.error(
						{ err: e, jid },
						"Failed to parse existing session state",
					);
					currentSession = null; // Treat as no session
				}
			}

			const { result, updatedSession } = await action(currentSession);

			if (updatedSession !== undefined) {
				// Allows explicit deletion by returning null
				if (updatedSession === null) {
					await this.authState.keys.set({ session: { [jid]: null } });
					this.logger.debug({ jid }, "Deleted session state");
				} else {
					// TODO: Robust serialization (needs BufferJSON replacer logic)
					await this.authState.keys.set({
						session: {
							[jid]: utf8ToBytes(
								JSON.stringify(updatedSession, BufferJSON.replacer),
							),
						},
					});
					this.logger.debug({ jid }, "Updated session state");
				}
			}
			// Clean up lock if no longer needed? Maybe not necessary.
			return result;
		});
	}

	// --- Core Ratchet Logic (Adapted from SessionCipher) ---

	private calculateDerivedKeys(masterKey: Uint8Array): {
		rootKey: Uint8Array;
		chainKey: Uint8Array;
	} {
		// Use HKDF (SHA256) from @wha.ts/utils
		const derived = hkdf(masterKey, 64, { info: HKDF_INFO_RATCHET });
		return { rootKey: derived.slice(0, 32), chainKey: derived.slice(32) };
	}

	private calculateMessageKeys(chainKey: Uint8Array): {
		messageKey: Uint8Array;
		nextChainKey: Uint8Array;
	} {
		// Use HMAC (SHA256) from @wha.ts/utils
		const messageKey = hmacSign(Uint8Array.from([1]), chainKey);
		const nextChainKey = hmacSign(Uint8Array.from([2]), chainKey);
		return { messageKey, nextChainKey };
	}

	private advanceChainKey(chain: SignalChain): void {
		if (!chain.chainKey.key) {
			this.logger.warn("Attempting to advance a finished chain key");
			return;
		}
		const { messageKey, nextChainKey } = this.calculateMessageKeys(
			chain.chainKey.key,
		);
		chain.chainKey.counter++;
		chain.messageKeys[chain.chainKey.counter] = messageKey;
		chain.chainKey.key = nextChainKey;
	}

	private fillMessageKeys(chain: SignalChain, targetCounter: number): void {
		if (chain.chainKey.counter >= targetCounter) {
			return; // Already have the key
		}
		if (targetCounter - chain.chainKey.counter > MAX_MESSAGE_KEYS) {
			throw new Error(
				`Message counter gap too large: ${targetCounter - chain.chainKey.counter}`,
			);
		}
		if (!chain.chainKey.key) {
			throw new Error(
				"Cannot fill message keys, chain key is missing (chain finished?)",
			);
		}

		while (chain.chainKey.counter < targetCounter) {
			this.advanceChainKey(chain);
		}
	}

	// --- Session Initialization (Adapted from SessionBuilder) ---

	private async initializeSession(
		isInitiator: boolean,
		ourEphemeralKey: KeyPair, // Can be prekey or identity key depending on flow
		ourIdentityKey: KeyPair,
		theirIdentityKey: Uint8Array,
		theirSignedKey: Uint8Array,
		theirOneTimePreKey: Uint8Array | undefined,
		theirBaseKey: Uint8Array, // The key used for the initial DH ratchets (their signed or OT prekey)
	): Promise<SignalSession> {
		const agreement1 = Curve.sharedKey(
			ourIdentityKey.privateKey,
			theirSignedKey,
		);
		const agreement2 = Curve.sharedKey(
			ourEphemeralKey.privateKey,
			theirIdentityKey,
		);
		const agreement3 = Curve.sharedKey(
			ourEphemeralKey.privateKey,
			theirSignedKey,
		);
		let agreement4: Uint8Array | undefined; // DH(ourEphemeral, theirOneTimePreKey)

		if (theirOneTimePreKey) {
			agreement4 = Curve.sharedKey(
				ourEphemeralKey.privateKey,
				theirOneTimePreKey,
			);
		}

		const sharedSecret = concatBytes(
			new Uint8Array(32).fill(0xff), // Padding
			agreement1,
			agreement2,
			agreement3,
			agreement4 ?? new Uint8Array(0), // Include agreement4 only if OT prekey was used
		);

		// Use HKDF from @wha.ts/utils
		const derived = hkdf(sharedSecret, 64, { info: HKDF_INFO_DERIVED_SECRETS });
		const rootKey = derived.slice(0, 32);
		const chainKey = derived.slice(32);

		const session: SignalSession = {
			registrationId: 0, // Will be set later for incoming
			currentRatchet: {
				rootKey: rootKey,
				ephemeralKeyPair: isInitiator
					? Curve.generateKeyPair()
					: ourEphemeralKey, // Generate new ephemeral for sender
				lastRemoteEphemeralKey: theirBaseKey,
				previousCounter: 0,
			},
			receivingChains: {},
		};

		// Initialize sending chain for initiator, receiving chain for responder
		if (isInitiator) {
			const { rootKey: nextRootKey, chainKey: nextChainKey } =
				this.calculateDerivedKeys(rootKey);
			session.currentRatchet.rootKey = nextRootKey;
			session.sendingChain = {
				messageKeys: {},
				chainKey: { counter: -1, key: chainKey },
			};
			// Perform the first sending ratchet step immediately
			this.ratchetSend(session, theirBaseKey);
		} else {
			const remoteEphemeralB64 = bytesToBase64(theirBaseKey);
			session.receivingChains[remoteEphemeralB64] = {
				messageKeys: {},
				chainKey: { counter: -1, key: chainKey },
			};
		}

		return session;
	}

	// --- Ratchet Steps ---
	private ratchetSend(session: SignalSession, theirEphemeralKey: Uint8Array) {
		const ourEphemeral = session.currentRatchet.ephemeralKeyPair;
		const shared = Curve.sharedKey(ourEphemeral.privateKey, theirEphemeralKey);
		const { rootKey, chainKey } = this.calculateDerivedKeys(
			session.currentRatchet.rootKey,
		);

		session.currentRatchet.rootKey = rootKey;
		session.sendingChain = {
			messageKeys: {},
			chainKey: { counter: -1, key: chainKey },
		};
		session.currentRatchet.lastRemoteEphemeralKey = theirEphemeralKey; // Update the key we ratcheted with
	}

	private ratchetReceive(
		session: SignalSession,
		theirEphemeralKey: Uint8Array,
	) {
		const remoteKeyB64 = bytesToBase64(theirEphemeralKey);
		if (session.receivingChains[remoteKeyB64]) {
			this.logger.debug(
				"Already have receiving chain for this key, skipping ratchet",
			);
			return; // Chain already exists
		}

		const ourEphemeral = session.currentRatchet.ephemeralKeyPair;
		const shared = Curve.sharedKey(ourEphemeral.privateKey, theirEphemeralKey);
		const { rootKey, chainKey } = this.calculateDerivedKeys(
			session.currentRatchet.rootKey,
		);

		// Start new receiving chain
		session.receivingChains[remoteKeyB64] = {
			messageKeys: {},
			chainKey: { counter: -1, key: chainKey },
		};

		// Update root key and replace our ephemeral key pair for the next send
		session.currentRatchet.rootKey = rootKey;
		session.currentRatchet.ephemeralKeyPair = Curve.generateKeyPair();
		session.currentRatchet.lastRemoteEphemeralKey = theirEphemeralKey;

		// Immediately calculate the *next* sending chain based on the new keys
		this.ratchetSend(session, theirEphemeralKey);
	}

	// --- Public API Implementation ---

	async encryptMessage(
		recipientJid: string,
		plaintext: Uint8Array,
	): Promise<EncryptedSignalMessage> {
		return this.runWithSessionLock(recipientJid, async (session) => {
			let currentSession = session;
			let messageType: "pkmsg" | "msg";
			let serializedMessage: Uint8Array;

			if (!currentSession) {
				this.logger.info(
					{ jid: recipientJid },
					"No session found, initiating new session (X3DH)",
				);
				messageType = "pkmsg";
				// 1. Fetch recipient's prekey bundle (Needs implementation - complex)
				//    - Send IQ to server asking for keys for recipientJid
				//    - Requires methods like `getPreKeyBundle(jid)` which interacts with the connection
				//    - This is a placeholder, real implementation is complex.
				const bundle = await this.fetchPreKeyBundle(recipientJid); // <--- Needs implementation
				if (!bundle) {
					throw new Error(`Could not fetch prekey bundle for ${recipientJid}`);
				}

				if (!this.authState.creds.me) {
					throw new Error("Our credentials are not set");
				}

				// 2. Perform X3DH calculations
				const ourIdentityKey = await this.authState.keys.get(
					"signed-identity-key",
					[this.authState.creds.me.id],
				); // Fetch our identity
				if (!ourIdentityKey || !ourIdentityKey[this.authState.creds.me.id])
					throw new Error("Our identity key not found");

				const ourEphemeral = Curve.generateKeyPair(); // Use a fresh ephemeral key for setup

				const ourIdentityKeyMe = ourIdentityKey[this.authState.creds.me.id];
				if (!ourIdentityKeyMe) {
					throw new Error("Our identity key not found");
				}

				currentSession = await this.initializeSession(
					true, // isInitiator
					ourEphemeral,
					ourIdentityKeyMe,
					bundle.identityKey,
					bundle.signedPreKey.publicKey,
					bundle.preKey?.publicKey,
					bundle.signedPreKey.publicKey, // Base key for initiator is the signed pre-key
				);

				currentSession.registrationId = bundle.registrationId; // Store remote registration ID
				currentSession.pendingPreKey = {
					preKeyId: bundle.preKey?.keyId,
					signedKeyId: bundle.signedPreKey.keyId,
					baseKey: ourEphemeral.publicKey, // Our ephemeral is the base key for pkmsg
				};
				// Initial session is now established in memory, will be saved below.
			} else {
				this.logger.debug(
					{ jid: recipientJid },
					"Existing session found, using regular message",
				);
				messageType = "msg";
			}

			// 3. Encrypt using Double Ratchet (Send chain)
			if (
				!currentSession.sendingChain ||
				!currentSession.sendingChain.chainKey.key
			) {
				// This might happen if initialization failed or chain finished unexpectedly
				// Maybe try re-ratcheting? For now, error out.
				throw new Error("No valid sending chain available");
			}
			this.advanceChainKey(currentSession.sendingChain);
			const counter = currentSession.sendingChain.chainKey.counter;
			const messageKey = currentSession.sendingChain.messageKeys[counter];
			delete currentSession.sendingChain.messageKeys[counter]; // Remove key after use

			if (!messageKey) throw new Error("Message key generation failed");

			const derivedKeys = hkdf(messageKey, 80, {
				info: HKDF_INFO_MESSAGE_KEYS,
			});
			const aesKey = derivedKeys.slice(0, 32);
			const macKey = derivedKeys.slice(32, 64);
			const iv = derivedKeys.slice(64, 80); // IV is 16 bytes

			// Encrypt using AES-GCM (from @wha.ts/utils)
			// Note: libsignal-node used AES-CBC. WA often uses GCM now. Adjust if CBC needed.
			const ciphertext = await aesEncryptGCM(plaintext, aesKey, iv); // No AAD for basic Signal

			if (!this.authState.creds.me) {
				throw new Error("Our credentials are not set");
			}

			// Calculate MAC (HMAC-SHA256, truncated)
			// Combine public keys and ciphertext for MAC input
			const ourSigId = await this.authState.keys.get("signed-identity-key", [
				this.authState.creds.me.id,
			]);
			const theirSigId = await this.authState.keys.get("signed-identity-key", [
				recipientJid,
			]); // Need to store/retrieve remote identity

			const ourSigIdMe = ourSigId[this.authState.creds.me.id];

			if (!ourSigIdMe || !theirSigId[recipientJid]) {
				throw new Error("Cannot compute MAC: Missing identity keys");
			}
			// TODO: Verify exact MAC structure required by WA Signal impl. Usually involves identities + ciphertext.
			const macInput = concatBytes(
				ourSigIdMe.publicKey, // Our identity
				theirSigId[recipientJid].publicKey, // Their identity
				ciphertext,
			);
			const fullMac = hmacSign(macKey, macInput);
			const truncatedMac = fullMac.slice(0, 8); // Standard Signal truncation

			// 4. Construct appropriate Protobuf message
			const signalMessageProto = create(SignalMessageSchema, {
				ratchetKey: currentSession.currentRatchet.ephemeralKeyPair.publicKey,
				counter: counter,
				previousCounter: currentSession.currentRatchet.previousCounter, // Include previous counter from receiving chain
				ciphertext: ciphertext, // Just the AES-GCM output
			});

			if (messageType === "pkmsg") {
				if (!currentSession.pendingPreKey)
					throw new Error("Internal error: pendingPreKey missing for pkmsg");

				const preKeySignalMsg = create(PreKeySignalMessageSchema, {
					registrationId: this.authState.creds.registrationId, // Our registration ID
					preKeyId: currentSession.pendingPreKey.preKeyId,
					signedPreKeyId: currentSession.pendingPreKey.signedKeyId,
					baseKey: currentSession.pendingPreKey.baseKey, // Our ephemeral from X3DH
					identityKey: ourSigIdMe.publicKey, // Our identity key
					message: toBinary(SignalMessageSchema, signalMessageProto), // Inner SignalMessage
				});
				serializedMessage = toBinary(
					PreKeySignalMessageSchema,
					preKeySignalMsg,
				);
			} else {
				// Regular message: Serialize SignalMessage directly
				// Combine proto + mac
				const signalMsgBytes = toBinary(
					SignalMessageSchema,
					signalMessageProto,
				);
				serializedMessage = concatBytes(signalMsgBytes, truncatedMac); // Append MAC
			}

			// Clear pendingPreKey after first message is constructed
			currentSession.pendingPreKey = undefined;

			return {
				result: { type: messageType, ciphertext: serializedMessage },
				updatedSession: currentSession,
			};
		});
	}

	async decryptPreKeyMessage(
		senderJid: string,
		preKeyMsg: PreKeySignalMessage,
	): Promise<Uint8Array> {
		return this.runWithSessionLock(senderJid, async (existingSession) => {
			if (existingSession) {
				this.logger.warn(
					{ jid: senderJid },
					"Received PreKeySignalMessage but session already exists. Processing anyway.",
				);
				// Potentially overwrite or ignore? Overwriting seems safer if the other side restarted.
			}

			if (!this.authState.creds.me) {
				throw new Error("Our credentials are not set");
			}

			// 1. Load required keys
			const ourIdentity = await this.authState.keys.get("signed-identity-key", [
				this.authState.creds.me.id,
			]);
			const ourPreKey = preKeyMsg.preKeyId
				? await this.authState.keys.get("pre-key", [
						`${this.authState.creds.me.id}:${preKeyMsg.preKeyId}`,
					])
				: undefined;
			const ourSignedPreKey = await this.authState.keys.get("signed-pre-key", [
				`${this.authState.creds.me.id}:${preKeyMsg.signedPreKeyId}`,
			]);

			const ourIdentityMe = ourIdentity[this.authState.creds.me.id];

			if (!ourIdentityMe) {
				throw new Error("Our identity key not found");
			}
			if (
				preKeyMsg.preKeyId &&
				(!ourPreKey ||
					!ourPreKey[`${this.authState.creds.me.id}:${preKeyMsg.preKeyId}`])
			) {
				throw new Error(`PreKey ${preKeyMsg.preKeyId} not found`);
			}
			if (
				!ourSignedPreKey ||
				!ourSignedPreKey[
					`${this.authState.creds.me.id}:${preKeyMsg.signedPreKeyId}`
				]
			) {
				throw new Error(`SignedPreKey ${preKeyMsg.signedPreKeyId} not found`);
			}
			if (!preKeyMsg.identityKey || !preKeyMsg.baseKey) {
				throw new Error("PreKey message missing identity or base key");
			}

			// Use signed pre-key as our main ephemeral for session init, pre-key is for the optional OT part
			const ourSigned =
				ourSignedPreKey[
					`${this.authState.creds.me.id}:${preKeyMsg.signedPreKeyId}`
				];
			const ourOTPreKey = preKeyMsg.preKeyId
				? ourPreKey?.[`${this.authState.creds.me.id}:${preKeyMsg.preKeyId}`]
				: undefined;

			if (!ourSigned) {
				throw new Error("Our signed pre-key is missing");
			}

			// 2. Initialize session
			const newSession = await this.initializeSession(
				false, // isInitiator = false
				ourSigned.keyPair, // Our "ephemeral" is the signed prekey pair
				ourIdentityMe,
				preKeyMsg.identityKey,
				preKeyMsg.baseKey, // Their "signed" key is their base key for this setup
				undefined, // No OT key from their side in pkmsg
				preKeyMsg.baseKey, // Their base key IS their ephemeral for the first ratchet
			);
			newSession.registrationId = preKeyMsg.registrationId || 0;

			// Store the remote identity key
			await this.authState.keys.set({
				"signed-identity-key": {
					[senderJid]: {
						publicKey: preKeyMsg.identityKey,
						privateKey: new Uint8Array(),
					},
				},
			});

			// 3. Decrypt inner SignalMessage
			if (!preKeyMsg.message)
				throw new Error("Inner SignalMessage missing from PreKey message");
			const innerSignalMsg = fromBinary(SignalMessageSchema, preKeyMsg.message);

			const plaintext = await this.decryptUsingSession(
				senderJid,
				innerSignalMsg,
				newSession,
			);

			// 4. Remove OT PreKey if used
			if (preKeyMsg.preKeyId) {
				await this.authState.keys.set({
					"pre-key": {
						[`${this.authState.creds.me.id}:${preKeyMsg.preKeyId}`]: null,
					},
				});
				this.logger.info(
					{ jid: senderJid, keyId: preKeyMsg.preKeyId },
					"Removed used one-time pre-key",
				);
			}

			return { result: plaintext, updatedSession: newSession };
		});
	}

	async decryptRegularMessage(
		senderJid: string,
		signalMsg: SignalMessage,
	): Promise<Uint8Array> {
		return this.runWithSessionLock(senderJid, async (session) => {
			if (!session) {
				throw new Error(
					`No session found for ${senderJid} to decrypt regular message`,
				);
			}
			const plaintext = await this.decryptUsingSession(
				senderJid,
				signalMsg,
				session,
			);
			// Session might have been updated (ratchet step), save it back
			return { result: plaintext, updatedSession: session };
		});
	}

	// --- Internal Decryption Helper ---
	private async decryptUsingSession(
		senderJid: string,
		signalMsg: SignalMessage,
		session: SignalSession,
	): Promise<Uint8Array> {
		if (!signalMsg.ratchetKey || !signalMsg.ciphertext) {
			throw new Error("Signal message missing ratchet key or ciphertext");
		}

		// 1. Check MAC (if applicable - regular messages have MAC appended)
		//    Need to handle how MAC is appended/extracted for regular messages vs pkmsg
		const ciphertext = signalMsg.ciphertext;
		let receivedMac: Uint8Array | undefined;
		// Heuristic: If ciphertext seems too long, assume last 8 bytes are MAC
		// This needs clarification based on how `encryptMessage` appends it.
		// For now, assume `decryptRegularMessage` caller extracts MAC if needed.
		// Let's assume the MAC is *NOT* part of the proto ciphertext field itself.
		// The caller of decryptRegularMessage would need to verify it *before* parsing the proto.
		// TODO: Clarify MAC handling flow between encrypt/decrypt.

		// 2. Potentially advance receiver ratchet
		this.ratchetReceive(session, signalMsg.ratchetKey);

		// 3. Find appropriate receiving chain
		const remoteKeyB64 = bytesToBase64(signalMsg.ratchetKey);
		const chain = session.receivingChains[remoteKeyB64];
		if (!chain) {
			throw new Error(
				`No receiving chain found for ratchet key: ${remoteKeyB64}`,
			);
		}

		// 4. Ensure message keys are available
		this.fillMessageKeys(chain, signalMsg.counter || 0);

		// 5. Get message key
		const messageCounter = signalMsg.counter || 0;
		const messageKey = chain.messageKeys[messageCounter];
		if (!messageKey) {
			throw new Error(
				`Message key not found for counter ${messageCounter}. Duplicate or out of order?`,
			);
		}
		delete chain.messageKeys[messageCounter]; // Consume key

		// 6. Derive AES and IV keys
		const derivedKeys = hkdf(messageKey, 80, { info: HKDF_INFO_MESSAGE_KEYS });
		const aesKey = derivedKeys.slice(0, 32);
		// const macKey = derivedKeys.slice(32, 64); // MAC key was needed *before* parsing proto ideally
		const iv = derivedKeys.slice(64, 80);

		// 7. Decrypt
		const plaintext = await aesDecryptGCM(ciphertext, aesKey, iv); // No AAD

		// Update previous counter for sending chain (used in next outgoing message)
		session.currentRatchet.previousCounter = chain.chainKey.counter;

		// Clean up old receiving chains if necessary (optional optimization)
		this.cleanupOldChains(session, remoteKeyB64);

		return plaintext;
	}

	// --- PreKey Bundle Fetching (Placeholder) ---
	private async fetchPreKeyBundle(jid: string) {
		// THIS IS A COMPLEX PLACEHOLDER
		// It needs to:
		// 1. Construct an IQ stanza (<iq type='get'><key><user jid='...'.../></key></iq>)
		// 2. Send it using the ConnectionManager/Authenticator's sendNode mechanism
		// 3. Wait for the IQ response (<iq type='result'><list>...</list></iq>)
		// 4. Parse the response containing the keys (identity, registrationId, prekey, signedPreKey)
		// 5. Validate the signatures in the bundle.
		this.logger.warn(
			`fetchPreKeyBundle for ${jid} is not implemented - returning dummy data`,
		);
		// Dummy data structure - replace with real fetched and validated data
		// You MUST fetch the actual keys from the server via IQ for this to work.
		return {
			identityKey: new Uint8Array(32).fill(1), // Dummy remote identity key
			registrationId: 12345, // Dummy remote reg ID
			preKey: { keyId: 1, publicKey: new Uint8Array(32).fill(2) }, // Dummy OT prekey
			signedPreKey: {
				keyId: 1,
				publicKey: new Uint8Array(32).fill(3),
				signature: new Uint8Array(64).fill(4),
			}, // Dummy signed prekey
		};
		// throw new Error(`PreKey bundle fetching for ${jid} not implemented`);
	}

	// --- Chain Cleanup (Optional) ---
	private cleanupOldChains(
		session: SignalSession,
		currentChainKeyB64: string,
	): void {
		const MAX_RETAINED_CHAINS = 5; // Example: Keep only a few old chains
		const chainKeys = Object.keys(session.receivingChains);
		if (chainKeys.length > MAX_RETAINED_CHAINS) {
			// Find the oldest chain to remove (simplistic: remove one that isn't the current one)
			const keyToRemove = chainKeys.find((key) => key !== currentChainKeyB64);
			if (keyToRemove) {
				delete session.receivingChains[keyToRemove];
				this.logger.debug(
					{ jid: "session" },
					`Cleaned up old receiving chain ${keyToRemove}`,
				);
			}
		}
	}
}
