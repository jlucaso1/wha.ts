import {
	bytesToBase64,
	Curve,
	concatBytes,
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
			return;
		}

		const preKeyPair =
			typeof message.preKeyId === "number"
				? await this.storage.loadPreKey(message.preKeyId)
				: undefined;

		const signedPreKeyPair =
			typeof message.signedPreKeyId === "number"
				? await this.storage.loadSignedPreKey(message.signedPreKeyId)
				: undefined;

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
		const ourIdentityKey = await this.storage.getOurIdentity();
		const sharedSecretPrefix = new Uint8Array(32).fill(0xff);

		const localOurSignedKey = isInitiator ? ourEphemeralKey : ourSignedKey;
		const effectiveTheirSignedPubKey = isInitiator
			? theirSignedPubKey
			: theirEphemeralPubKey;

		if (!localOurSignedKey || !effectiveTheirSignedPubKey) {
			throw new Error(
				"Cannot establish session: missing required keys for handshake.",
			);
		}

		const baseKeyForSession = theirEphemeralPubKey ?? theirSignedPubKey;
		if (!baseKeyForSession) {
			throw new Error(
				"Cannot establish session: no base key from remote party available.",
			);
		}

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

		const agreements = [agreement1, agreement2, agreement3];

		if (ourEphemeralKey && theirEphemeralPubKey) {
			console.trace(
				"Using ephemeral keys for session establishment",
				"ourEphemeralKey:",
				ourEphemeralKey.publicKey,
				"theirEphemeralPubKey:",
				theirEphemeralPubKey,
			);
			const agreement4 = Curve.sharedKey(
				ourEphemeralKey.privateKey,
				theirEphemeralPubKey,
			);
			agreements.push(agreement4);
		}

		let masterKeyInput: Uint8Array;
		const baseAgreements = (
			isInitiator
				? [agreements[0], agreements[1], agreements[2]]
				: [agreements[1], agreements[0], agreements[2]]
		) as Uint8Array[];

		if (ourEphemeralKey && theirEphemeralPubKey) {
			const agreement4 = Curve.sharedKey(
				ourEphemeralKey.privateKey,
				theirEphemeralPubKey,
			);
			masterKeyInput = concatBytes(
				sharedSecretPrefix,
				...baseAgreements,
				agreement4,
			);
		} else {
			masterKeyInput = concatBytes(sharedSecretPrefix, ...baseAgreements);
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
				baseKey: baseKeyForSession,
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
