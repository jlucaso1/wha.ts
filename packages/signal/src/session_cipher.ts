import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { PreKeySignalMessageSchema, SignalMessageSchema } from "@wha.ts/proto";
import {
	aesDecrypt,
	aesEncrypt,
	bytesToBase64,
	Curve,
	concatBytes,
	hkdfSignalDeriveSecrets,
	hmacSha256Verify,
	hmacSign,
	type KeyPair,
	Mutex,
	utf8ToBytes,
} from "@wha.ts/utils";
import { ChainType } from "./chain_type";
import { ProtocolAddress } from "./protocol_address";
import { SessionBuilder } from "./session_builder";
import { SessionRecord } from "./session_record";
import type { SignalSessionStorage } from "./types";

const VERSION = 3;
const MAX_SKIPPED_MESSAGE_KEYS = 2000;

// Re-defining for local use, you might want to centralize these types
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
		baseKeyType: number; // Assuming BaseKeyType enum
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
	chainType: number; // Assuming ChainType enum
	messageKeys: { [messageNumber: number]: Uint8Array };
}

export class SessionCipher {
	private addr: ProtocolAddress;
	private storage: SignalSessionStorage;
	private mutex: Mutex;

	constructor(storage: SignalSessionStorage, protocolAddress: ProtocolAddress) {
		if (!(protocolAddress instanceof ProtocolAddress)) {
			throw new TypeError("protocolAddress must be a ProtocolAddress");
		}
		this.addr = protocolAddress;
		this.storage = storage;
		this.mutex = new Mutex();
	}

	private _encodeTupleByte(number1: number, number2: number): number {
		if (number1 > 15 || number2 > 15) {
			throw TypeError("Numbers must be 4 bits or less");
		}
		return (number1 << 4) | number2;
	}

	private _decodeTupleByte(byte: number): [number, number] {
		return [byte >> 4, byte & 0xf];
	}

	public toString(): string {
		return `<SessionCipher(${this.addr.toString()})>`;
	}

	public async getRecord(): Promise<SessionRecord | undefined> {
		const record = await this.storage.loadSession(this.addr.toString());
		if (record && !(record instanceof SessionRecord)) {
			throw new TypeError("SessionRecord type expected from loadSession");
		}
		return record === null ? undefined : record;
	}

	public async storeRecord(record: SessionRecord): Promise<void> {
		record.removeOldSessions();
		await this.storage.storeSession(this.addr.toString(), record);
	}

	public async encrypt(
		data: Uint8Array,
	): Promise<{ type: number; body: Uint8Array; registrationId: number }> {
		const ourIdentityKey = await this.storage.getOurIdentity();

		return this.mutex.runExclusive(async () => {
			const record = await this.getRecord();
			if (!record) {
				throw new Error("No sessions");
			}
			const session = record.getOpenSession();
			if (!session) {
				throw new Error("No open session");
			}

			console.log(
				"DEBUG: Using session for encryption:",
				JSON.stringify(session, null, 2),
			);

			if (!(session.currentRatchet.rootKey instanceof Uint8Array)) {
				console.error("FATAL: rootKey is NOT a Uint8Array!");
			}
			if (
				!(
					session.currentRatchet.ephemeralKeyPair.privateKey instanceof
					Uint8Array
				)
			) {
				console.error("FATAL: ephemeral privateKey is NOT a Uint8Array!");
			}

			if (!session.indexInfo) throw new Error("Session missing indexInfo");

			const { remoteIdentityKey } = session.indexInfo;
			if (
				!(await this.storage.isTrustedIdentity(
					this.addr.id,
					remoteIdentityKey,
					ChainType.SENDING,
				))
			) {
				throw new Error("Untrusted identity key");
			}
			if (!session.currentRatchet?.ephemeralKeyPair) {
				throw new Error("Session missing currentRatchet or ephemeralKeyPair");
			}

			const { publicKey } = session.currentRatchet.ephemeralKeyPair;
			const chain = session.chains[bytesToBase64(publicKey)];
			if (!chain || chain.chainType === ChainType.RECEIVING) {
				throw new Error("Tried to encrypt on a receiving chain");
			}
			if (!chain.chainKey) throw new Error("Chain missing chainKey");

			this.fillMessageKeys(chain, chain.chainKey.counter + 1);
			const keyIndex = chain.chainKey.counter;
			const keyMaterial = chain.messageKeys[keyIndex];
			if (!keyMaterial) {
				throw new Error("Missing message key for encryption");
			}

			const [cipherKey, macKey, ivPrefix] = hkdfSignalDeriveSecrets(
				keyMaterial,
				new Uint8Array(32),
				utf8ToBytes("WhisperMessageKeys"),
			);
			delete chain.messageKeys[keyIndex];

			const msg = create(SignalMessageSchema, {
				ratchetKey: publicKey,
				counter: chain.chainKey.counter,
				previousCounter: session.currentRatchet.previousCounter,
				ciphertext: aesEncrypt(data, cipherKey, ivPrefix.slice(0, 16)),
			});

			const msgBuf = toBinary(SignalMessageSchema, msg);
			const macInput = concatBytes(
				ourIdentityKey.publicKey,
				session.indexInfo.remoteIdentityKey,
				new Uint8Array([this._encodeTupleByte(VERSION, VERSION)]),
				msgBuf,
			);
			const mac = hmacSign(macKey, macInput);
			const message = concatBytes(
				new Uint8Array([this._encodeTupleByte(VERSION, VERSION)]),
				msgBuf,
				mac.slice(0, 8),
			);

			await this.storeRecord(record);

			let type: number;
			let body: Uint8Array;
			if (session.pendingPreKey) {
				type = 3;
				const preKeyMsg = create(PreKeySignalMessageSchema, {
					identityKey: ourIdentityKey.publicKey,
					registrationId: await this.storage.getOurRegistrationId(),
					baseKey: session.pendingPreKey.baseKey,
					signedPreKeyId: session.pendingPreKey.signedKeyId,
					message,
					preKeyId: session.pendingPreKey.preKeyId,
				});
				const preKeyMsgBuf = toBinary(PreKeySignalMessageSchema, preKeyMsg);
				body = concatBytes(
					new Uint8Array([this._encodeTupleByte(VERSION, VERSION)]),
					preKeyMsgBuf,
				);
			} else {
				type = 1;
				body = message;
			}
			if (typeof session.registrationId !== "number") {
				throw new Error("Session registrationId is undefined");
			}
			return {
				type,
				body,
				registrationId: session.registrationId,
			};
		});
	}

	public async decryptWithSessions(
		data: Uint8Array,
		sessions: ISessionEntry[],
	): Promise<{ session: ISessionEntry; plaintext: Uint8Array }> {
		if (!sessions.length) {
			throw new Error("No sessions available");
		}
		const errs: Error[] = [];
		for (const session of sessions) {
			try {
				const plaintext = await this.doDecryptWhisperMessage(data, session);
				if (!session.indexInfo) throw new Error("Session missing indexInfo");
				session.indexInfo.used = BigInt(Date.now());
				return { session, plaintext };
			} catch (e) {
				errs.push(e as Error);
			}
		}
		console.error("Failed to decrypt message with any known session...");
		for (const e of errs) {
			console.error(`Session error: ${e}`, (e as Error).stack);
		}
		throw new Error("No matching sessions found for message");
	}

	public async decryptWhisperMessage(data: Uint8Array): Promise<Uint8Array> {
		return this.mutex.runExclusive(async () => {
			const record = await this.getRecord();
			if (!record) {
				throw new Error("No session record");
			}
			const result = await this.decryptWithSessions(data, record.getSessions());
			if (!result.session.indexInfo) {
				throw new Error("Session missing indexInfo");
			}
			const { remoteIdentityKey } = result.session.indexInfo;
			if (
				!(await this.storage.isTrustedIdentity(
					this.addr.id,
					remoteIdentityKey,
					ChainType.RECEIVING,
				))
			) {
				throw new Error("Untrusted identity key");
			}
			if (record.isClosed(result.session)) {
				console.warn("Decrypted message with closed session.");
			}
			await this.storeRecord(record);
			return result.plaintext;
		});
	}

	public async decryptPreKeyWhisperMessage(
		data: Uint8Array,
	): Promise<Uint8Array> {
		const firstByte = data[0];
		if (typeof firstByte !== "number") {
			throw new Error("Invalid PreKeyWhisperMessage: missing version byte");
		}
		const versions = this._decodeTupleByte(firstByte);
		if (versions[1] > 3 || versions[0] < 3) {
			throw new Error("Incompatible version number on PreKeyWhisperMessage");
		}
		return this.mutex.runExclusive(async () => {
			let record = await this.getRecord();
			const preKeyProto = fromBinary(PreKeySignalMessageSchema, data.slice(1));
			if (!record) {
				if (preKeyProto.registrationId === undefined) {
					throw new Error("No registrationId");
				}
				record = new SessionRecord();
			}
			const builder = new SessionBuilder(this.storage, this.addr);
			const preKeyId = await builder.initIncoming(record, preKeyProto);
			if (preKeyId === undefined && !record.getSession(preKeyProto.baseKey)) {
				throw new Error(
					`Session establishment failed for pre-key message, likely due to missing pre-key ${preKeyProto.preKeyId}`,
				);
			}
			const session = record.getSession(preKeyProto.baseKey);
			if (!session) {
				throw new Error(
					"No session found for baseKey after session builder ran",
				);
			}
			const plaintext = await this.doDecryptWhisperMessage(
				preKeyProto.message,
				session,
			);
			await this.storeRecord(record);
			if (preKeyId !== undefined && this.storage.removePreKey) {
				await this.storage.removePreKey(preKeyId);
			}
			return plaintext;
		});
	}

	private async doDecryptWhisperMessage(
		messageBuffer: Uint8Array,
		session: ISessionEntry,
	): Promise<Uint8Array> {
		const firstByte = messageBuffer[0];
		if (typeof firstByte !== "number") {
			throw new Error("Invalid WhisperMessage: missing version byte");
		}
		const versions = this._decodeTupleByte(firstByte);
		if (versions[1] > 3 || versions[0] < 3) {
			throw new Error("Incompatible version number on WhisperMessage");
		}
		const messageProto = messageBuffer.slice(1, -8);
		const message = fromBinary(SignalMessageSchema, messageProto);

		await this.maybeStepRatchet(
			session,
			message.ratchetKey,
			message.previousCounter,
		);

		const chain = session.chains[bytesToBase64(message.ratchetKey)];
		if (!chain || chain.chainType === ChainType.SENDING) {
			throw new Error("Tried to decrypt on a sending chain");
		}
		if (!chain.chainKey) throw new Error("Chain missing chainKey");

		this.fillMessageKeys(chain, message.counter);
		const messageKey = chain.messageKeys[message.counter];
		if (!messageKey) {
			throw new Error(
				"Key used already or never filled or invalid message counter",
			);
		}
		const [cipherKey, macKey, ivPrefix] = hkdfSignalDeriveSecrets(
			messageKey,
			new Uint8Array(32),
			utf8ToBytes("WhisperMessageKeys"),
		);

		const ourIdentityKey = await this.storage.getOurIdentity();
		const macInput = concatBytes(
			session.indexInfo.remoteIdentityKey,
			ourIdentityKey.publicKey,
			new Uint8Array([this._encodeTupleByte(VERSION, VERSION)]),
			messageProto,
		);
		hmacSha256Verify(macInput, macKey, messageBuffer.slice(-8), 8);

		const plaintext = aesDecrypt(
			cipherKey,
			message.ciphertext,
			ivPrefix.slice(0, 16),
		);
		delete chain.messageKeys[message.counter];
		session.pendingPreKey = undefined;
		return plaintext;
	}

	private fillMessageKeys(chain: IChain, counter: number): void {
		if (!chain.chainKey) throw new Error("Chain missing chainKey");

		const startCounter = chain.chainKey.counter;
		if (startCounter >= counter) {
			return;
		}

		if (counter - startCounter > MAX_SKIPPED_MESSAGE_KEYS) {
			throw new Error("Too many messages skipped");
		}

		if (!chain.chainKey.key) {
			throw new Error("Chain closed, cannot derive keys");
		}

		let currentChainKey = chain.chainKey.key;
		for (let i = startCounter + 1; i <= counter; i++) {
			if (Object.keys(chain.messageKeys).length >= MAX_SKIPPED_MESSAGE_KEYS) {
				throw new Error("Skipped message keys storage limit reached");
			}
			const messageKey = hmacSign(currentChainKey, new Uint8Array([1]));
			currentChainKey = hmacSign(currentChainKey, new Uint8Array([2]));
			chain.messageKeys[i] = messageKey;
		}
		chain.chainKey.key = currentChainKey;
		chain.chainKey.counter = counter;
	}

	private async maybeStepRatchet(
		session: ISessionEntry,
		remoteKey: Uint8Array,
		previousCounter: number,
	): Promise<void> {
		if (session.chains[bytesToBase64(remoteKey)]) {
			return;
		}
		const ratchet = session.currentRatchet;
		if (!ratchet) throw new Error("Session missing currentRatchet");
		const previousRatchet =
			session.chains[bytesToBase64(ratchet.lastRemoteEphemeralKey)];
		if (previousRatchet) {
			if (!previousRatchet.chainKey) throw new Error("Chain missing chainKey");
			this.fillMessageKeys(previousRatchet, previousCounter);
			previousRatchet.chainKey.key = null;
		}
		await this.calculateRatchet(session, remoteKey, false);

		const ephemeralKeyPair = session.currentRatchet.ephemeralKeyPair;
		if (ephemeralKeyPair?.publicKey) {
			const prevCounter =
				session.chains[bytesToBase64(ephemeralKeyPair.publicKey)];
			if (prevCounter?.chainKey) {
				ratchet.previousCounter = prevCounter.chainKey.counter;
				delete session.chains[bytesToBase64(ephemeralKeyPair.publicKey)];
			}
		}

		const newKeyPair = Curve.generateKeyPair();
		ratchet.ephemeralKeyPair = newKeyPair;
		await this.calculateRatchet(session, remoteKey, true);
		ratchet.lastRemoteEphemeralKey = remoteKey;
	}

	private async calculateRatchet(
		session: ISessionEntry,
		remoteKey: Uint8Array,
		sending: boolean,
	): Promise<void> {
		const ratchet = session.currentRatchet;
		if (!ratchet?.ephemeralKeyPair?.privateKey || !ratchet.rootKey) {
			throw new Error("Incomplete ratchet state for calculation");
		}
		const sharedSecret = Curve.sharedKey(
			ratchet.ephemeralKeyPair.privateKey,
			remoteKey,
		);
		const [newRootKey, newChainKey] = hkdfSignalDeriveSecrets(
			sharedSecret,
			ratchet.rootKey,
			utf8ToBytes("WhisperRatchet"),
		);

		const chainKeyBytes = sending
			? ratchet.ephemeralKeyPair.publicKey
			: remoteKey;
		session.chains[bytesToBase64(chainKeyBytes)] = {
			messageKeys: {},
			chainKey: {
				counter: -1,
				key: newChainKey,
			},
			chainType: sending ? ChainType.SENDING : ChainType.RECEIVING,
		};
		ratchet.rootKey = newRootKey;
	}

	public async hasOpenSession(): Promise<boolean> {
		return this.mutex.runExclusive(async () => {
			const record = await this.getRecord();
			return record?.haveOpenSession() || false;
		});
	}

	public async closeOpenSession(): Promise<void> {
		return this.mutex.runExclusive(async () => {
			const record = await this.getRecord();
			if (record) {
				const openSession = record.getOpenSession();
				if (openSession) {
					record.closeSession(openSession);
					await this.storeRecord(record);
				}
			}
		});
	}
}
