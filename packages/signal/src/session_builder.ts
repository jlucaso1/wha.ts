import {
	bytesToBase64,
	Curve,
	hkdfSignalDeriveSecrets,
	type KeyPair,
	Mutex,
	utf8ToBytes,
} from "@wha.ts/utils";
import { BaseKeyType } from "./base_key_type";
import { ChainType } from "./chain_type";
import type { ProtocolAddress } from "./protocol_address";
import { SessionRecord } from "./session_record";
import type { SignalSessionStorage } from "./types";

// Note: Using the same ISessionEntry interface from session_record.ts
interface ISessionEntry {
	registrationId?: number;
	currentRatchet: {
		ephemeralKeyPair: KeyPair;
		lastRemoteEphemeralKey: Uint8Array;
		previousCounter: number;
		rootKey: Uint8Array;
	};
	indexInfo: {
		baseKey: Uint8Array;
		baseKeyType: BaseKeyType;
		closed: bigint;
		used: bigint;
		created: bigint;
		remoteIdentityKey: Uint8Array;
	};
	pendingPreKey?: {
		signedKeyId: number;
		baseKey: Uint8Array;
		preKeyId?: number;
	};
	chains: { [ephemeralKeyB64: string]: IChain };
}

interface IChain {
	chainKey: {
		counter: number;
		key: Uint8Array | null;
	};
	chainType: ChainType;
	messageKeys: { [messageNumber: number]: Uint8Array };
}

export class SessionBuilder {
	private readonly addr: string;
	private readonly storage: SignalSessionStorage;
	private readonly mutex: Mutex;

	constructor(storage: SignalSessionStorage, protocolAddress: ProtocolAddress) {
		this.addr = protocolAddress.toString();
		this.storage = storage;
		this.mutex = new Mutex();
	}

	async initOutgoing(device: {
		identityKey: Uint8Array;
		signedPreKey: {
			publicKey: Uint8Array;
			keyId: number;
			signature: Uint8Array;
		};
		preKey?: { publicKey: Uint8Array; keyId: number };
		registrationId: number;
	}): Promise<void> {
		const fqAddr = this.addr;

		return this.mutex.runExclusive(async () => {
			if (
				!(await this.storage.isTrustedIdentity(
					this.addr,
					device.identityKey,
					ChainType.SENDING,
				))
			) {
				throw new Error("Untrusted identity");
			}
			Curve.verify(
				device.identityKey,
				device.signedPreKey.publicKey,
				device.signedPreKey.signature,
			);
			const baseKey = Curve.generateKeyPair();
			const devicePreKey = device.preKey?.publicKey;
			const session = await this.initSession(
				true,
				baseKey,
				undefined,
				device.identityKey,
				devicePreKey,
				device.signedPreKey.publicKey,
				device.registrationId,
			);
			session.pendingPreKey = {
				signedKeyId: device.signedPreKey.keyId,
				baseKey: baseKey.publicKey,
				preKeyId: device.preKey?.keyId,
			};
			let record = await this.storage.loadSession(fqAddr);
			if (!record) {
				record = new SessionRecord();
			} else {
				const openSession = record.getOpenSession();
				if (openSession) {
					console.warn(
						"Closing stale open session for new outgoing prekey bundle",
					);
					record.closeSession(openSession);
				}
			}
			record.setSession(session);
			await this.storage.storeSession(fqAddr, record);
		});
	}

	async initIncoming(
		record: SessionRecord,
		message: {
			identityKey: Uint8Array;
			baseKey: Uint8Array;
			preKeyId?: number;
			signedPreKeyId?: number;
			registrationId?: number;
		},
	): Promise<number | undefined> {
		const fqAddr = this.addr.toString();
		if (
			!(await this.storage.isTrustedIdentity(
				fqAddr,
				message.identityKey,
				ChainType.RECEIVING,
			))
		) {
			throw new Error("Untrusted identity");
		}
		if (record.getSession(message.baseKey)) {
			// Session already exists, nothing to do.
			return;
		}

		// Correctly handle optional preKey and signedPreKey
		const preKeyPair =
			typeof message.preKeyId === "number"
				? await this.storage.loadPreKey(message.preKeyId)
				: undefined;

		const signedPreKeyPair =
			typeof message.signedPreKeyId === "number"
				? await this.storage.loadSignedPreKey(message.signedPreKeyId)
				: undefined;

		// Critical check: if a preKeyId was provided, we MUST have found a corresponding key.
		if (typeof message.preKeyId === "number" && !preKeyPair) {
			throw new Error(`Invalid PreKey ID: ${message.preKeyId}`);
		}

		const existingOpenSession = record.getOpenSession();
		if (existingOpenSession) {
			console.warn("Closing open session in favor of incoming prekey bundle");
			record.closeSession(existingOpenSession);
		}

		const session = await this.initSession(
			false,
			preKeyPair,
			signedPreKeyPair,
			message.identityKey,
			message.baseKey,
			undefined,
			message.registrationId,
		);

		record.setSession(session);
		return message.preKeyId;
	}

	async initSession(
		isInitiator: boolean,
		ourEphemeralKey: KeyPair | undefined,
		ourSignedKey: KeyPair | undefined,
		theirIdentityPubKey: Uint8Array,
		theirEphemeralPubKey: Uint8Array | undefined,
		theirSignedPubKey: Uint8Array | undefined,
		registrationId: number | undefined,
	): Promise<ISessionEntry> {
		let localOurSignedKey = ourSignedKey;
		let effectiveTheirSignedPubKey = theirSignedPubKey;
		if (isInitiator) {
			if (localOurSignedKey || !ourEphemeralKey) {
				throw new Error(
					"Invalid call to initSession for initiator: must have ourEphemeralKey, must not have ourSignedKey",
				);
			}
			localOurSignedKey = ourEphemeralKey;
		} else {
			if (effectiveTheirSignedPubKey || !ourEphemeralKey) {
				throw new Error(
					"Invalid call to initSession for recipient: must have ourEphemeralKey, must not have theirSignedPubKey",
				);
			}
			effectiveTheirSignedPubKey = theirEphemeralPubKey;
		}

		if (!theirEphemeralPubKey) throw new Error("Missing theirEphemeralPubKey");
		if (!localOurSignedKey) throw new Error("Missing ourSignedKey");
		if (!effectiveTheirSignedPubKey)
			throw new Error("Missing theirSignedPubKey");

		let sharedSecret: Uint8Array;
		if (!ourEphemeralKey || !theirEphemeralPubKey) {
			sharedSecret = new Uint8Array(32 * 4);
		} else {
			sharedSecret = new Uint8Array(32 * 5);
		}
		for (let i = 0; i < 32; i++) sharedSecret[i] = 0xff;

		const ourIdentityKey = await this.storage.getOurIdentity();

		const agreement1 = Curve.sharedKey(
			ourIdentityKey.privateKey,
			effectiveTheirSignedPubKey,
		);
		const agreement2 = Curve.sharedKey(
			localOurSignedKey.privateKey,
			theirIdentityPubKey,
		);
		const agreement3 = Curve.sharedKey(
			localOurSignedKey.privateKey,
			effectiveTheirSignedPubKey,
		);
		const agreement4 = Curve.sharedKey(
			ourEphemeralKey.privateKey,
			theirEphemeralPubKey,
		);

		let masterKeyInput: Uint8Array;
		if (isInitiator) {
			masterKeyInput = new Uint8Array([
				...sharedSecret.subarray(0, 32),
				...agreement1,
				...agreement2,
				...agreement3,
				...agreement4,
			]);
		} else {
			masterKeyInput = new Uint8Array([
				...sharedSecret.subarray(0, 32),
				...agreement2,
				...agreement1,
				...agreement3,
				...agreement4,
			]);
		}

		const masterKey = hkdfSignalDeriveSecrets(
			masterKeyInput,
			new Uint8Array(32),
			utf8ToBytes("WhisperText"),
		);

		const session: ISessionEntry = {
			registrationId,
			currentRatchet: {
				rootKey: masterKey[0],
				ephemeralKeyPair: isInitiator
					? Curve.generateKeyPair()
					: localOurSignedKey,
				lastRemoteEphemeralKey: effectiveTheirSignedPubKey,
				previousCounter: 0,
			},
			indexInfo: {
				created: BigInt(Date.now()),
				used: BigInt(Date.now()),
				remoteIdentityKey: theirIdentityPubKey,
				baseKey: isInitiator ? ourEphemeralKey.publicKey : theirEphemeralPubKey,
				baseKeyType: isInitiator ? BaseKeyType.OURS : BaseKeyType.THEIRS,
				closed: -1n,
			},
			chains: {},
		};

		if (isInitiator && effectiveTheirSignedPubKey) {
			this.calculateSendingRatchet(session, effectiveTheirSignedPubKey);
		}
		return session;
	}
	calculateSendingRatchet(session: ISessionEntry, remoteKey: Uint8Array) {
		if (!session.currentRatchet) {
			throw new Error("Missing currentRatchet in session");
		}
		if (!remoteKey) throw new Error("Missing remoteKey for ratchet");

		const { ephemeralKeyPair, rootKey } = session.currentRatchet;
		if (!ephemeralKeyPair?.privateKey || !ephemeralKeyPair.publicKey) {
			throw new Error("Missing key pair in ratchet");
		}

		const sharedSecret = Curve.sharedKey(
			ephemeralKeyPair.privateKey,
			remoteKey,
		);
		const [newRootKey, newChainKey] = hkdfSignalDeriveSecrets(
			sharedSecret,
			rootKey,
			utf8ToBytes("WhisperRatchet"),
		);

		session.chains[bytesToBase64(ephemeralKeyPair.publicKey)] = {
			messageKeys: {},
			chainKey: { counter: -1, key: newChainKey },
			chainType: ChainType.SENDING,
		};
		session.currentRatchet.rootKey = newRootKey;
	}
}
