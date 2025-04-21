import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { PreKeySignalMessageSchema, SignalMessageSchema } from "@wha.ts/proto";
import { concatBytes, utf8ToBytes } from "@wha.ts/utils/src/bytes-utils";
import {
	aesDecrypt,
	aesEncrypt,
	hkdfSignalDeriveSecrets,
	hmacSha256Verify,
	hmacSign,
} from "@wha.ts/utils/src/crypto";
import { Curve } from "@wha.ts/utils/src/curve";
import { Mutex } from "@wha.ts/utils/src/mutex-utils";
import { ChainType } from "./chain_type";
import { ProtocolAddress } from "./protocol_address";
import { SessionBuilder } from "./session_builder";
import { type SessionEntry, SessionRecord } from "./session_record";
import type { SignalSessionStorage } from "./types";

const VERSION = 3;

const MAX_SKIPPED_MESSAGE_KEYS = 2000;

export class SessionCipher {
	private addr: ProtocolAddress;
	private storage: SignalSessionStorage;
	private mutex: Mutex;

	// Fix: Use correct type for storage parameter
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

		return await this.mutex.runExclusive(async () => {
			const record = await this.getRecord();
			if (!record) {
				throw new Error("No sessions");
			}
			const session = record.getOpenSession();
			if (!session) {
				throw new Error("No open session");
			}
			const remoteIdentityKey = session.indexInfo.remoteIdentityKey;
			if (
				!(await this.storage.isTrustedIdentity(
					this.addr.id,
					remoteIdentityKey,
					ChainType.SENDING,
				))
			) {
				throw new Error("Untrusted identity key");
			}
			const chain = session.getChain(
				session.currentRatchet.ephemeralKeyPair.publicKey,
			);
			if (!chain || chain.chainType === ChainType.RECEIVING) {
				throw new Error("Tried to encrypt on a receiving chain");
			}
			this.fillMessageKeys(chain, chain.chainKey.counter + 1);
			const keyIndex = chain.chainKey.counter;
			const keyMaterial = chain.messageKeys[keyIndex];
			if (!keyMaterial) {
				throw new Error("Missing message key for encryption");
			}
			const keys = hkdfSignalDeriveSecrets(
				keyMaterial,
				new Uint8Array(32),
				utf8ToBytes("WhisperMessageKeys"),
			);
			delete chain.messageKeys[keyIndex];

			const msg = create(SignalMessageSchema, {
				ratchetKey: session.currentRatchet.ephemeralKeyPair.publicKey,
				counter: chain.chainKey.counter,
				previousCounter: session.currentRatchet.previousCounter,
				ciphertext: aesEncrypt(keys[0], data, keys[2].slice(0, 16)),
			});

			const msgBuf = toBinary(SignalMessageSchema, msg);
			const macInput = new Uint8Array(msgBuf.byteLength + 33 * 2 + 1);
			macInput.set(ourIdentityKey.publicKey);
			macInput.set(session.indexInfo.remoteIdentityKey, 33);
			macInput[33 * 2] = this._encodeTupleByte(VERSION, VERSION);
			macInput.set(msgBuf, 33 * 2 + 1);
			const mac = hmacSign(keys[1], macInput);
			const result = new Uint8Array(msgBuf.byteLength + 9);
			result[0] = this._encodeTupleByte(VERSION, VERSION);
			result.set(msgBuf, 1);
			result.set(mac.slice(0, 8), msgBuf.byteLength + 1);
			await this.storeRecord(record);
			let type: number;
			let body: Uint8Array;
			if (session.pendingPreKey) {
				type = 3;

				const preKeyMsg = create(PreKeySignalMessageSchema, {
					identityKey: ourIdentityKey.publicKey,
					registrationId: await this.storage.getOurRegistrationId(),
					baseKey: session.pendingPreKey.baseKey,
					signedPreKeyId:
						typeof session.pendingPreKey.signedKeyId === "number"
							? session.pendingPreKey.signedKeyId
							: undefined,
					message: new Uint8Array(result),
				});

				if (
					session.pendingPreKey.preKeyId &&
					typeof session.pendingPreKey.preKeyId === "number"
				) {
					preKeyMsg.preKeyId = session.pendingPreKey.preKeyId;
				}

				const preKeyMsgBuf = toBinary(PreKeySignalMessageSchema, preKeyMsg);

				body = concatBytes(
					new Uint8Array([this._encodeTupleByte(VERSION, VERSION)]),
					preKeyMsgBuf,
				);
			} else {
				type = 1;
				body = new Uint8Array(result);
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
		sessions: SessionEntry[],
	): Promise<{ session: SessionEntry; plaintext: Uint8Array }> {
		if (!sessions.length) {
			throw new Error("No sessions available");
		}
		const errs: Error[] = [];
		for (const session of sessions) {
			let plaintext: Uint8Array;
			try {
				plaintext = await this.doDecryptWhisperMessage(data, session);
				session.indexInfo.used = Date.now();
				return {
					session,
					plaintext,
				};
			} catch (e) {
				errs.push(e as Error);
			}
		}
		console.error("Failed to decrypt message with any known session...");
		for (const e of errs) {
			console.error(`Session error:${e}`, (e as Error).stack);
		}
		throw new Error("No matching sessions found for message");
	}

	public async decryptWhisperMessage(data: Uint8Array): Promise<Uint8Array> {
		return await this.mutex.runExclusive(async () => {
			const record = await this.getRecord();
			if (!record) {
				throw new Error("No session record");
			}
			const result = await this.decryptWithSessions(data, record.getSessions());
			const remoteIdentityKey = result.session.indexInfo.remoteIdentityKey;
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
			console.debug("[decryptWhisperMessage] State saved successfully");
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
		return await this.mutex.runExclusive(async () => {
			let record = await this.getRecord();
			const preKeyProto = fromBinary(PreKeySignalMessageSchema, data.slice(1));
			if (!record) {
				if (preKeyProto.registrationId == null) {
					throw new Error("No registrationId");
				}
				record = new SessionRecord();
			}
			const builder = new SessionBuilder(this.storage, this.addr);
			const preKeyId = await builder.initIncoming(record, preKeyProto);
			const session = record.getSession(preKeyProto.baseKey);
			if (!session) {
				throw new Error("No session found for baseKey");
			}
			const plaintext = await this.doDecryptWhisperMessage(
				preKeyProto.message,
				session,
			);

			await this.storeRecord(record);
			console.debug("[decryptPreKeyWhisperMessage] State saved successfully");
			if (preKeyId !== undefined && this.storage.removePreKey) {
				await this.storage.removePreKey(preKeyId);
			}
			return plaintext;
		});
	}

	private async doDecryptWhisperMessage(
		messageBuffer: Uint8Array,
		session: SessionEntry,
	): Promise<Uint8Array> {
		if (!session) {
			throw new TypeError("session required");
		}
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
		this.maybeStepRatchet(session, message.ratchetKey, message.previousCounter);

		const chain = session.getChain(message.ratchetKey);
		if (!chain || chain.chainType === ChainType.SENDING) {
			throw new Error("Tried to decrypt on a sending chain");
		}
		this.fillMessageKeys(chain, message.counter);
		const messageKey = chain.messageKeys[message.counter];
		if (!messageKey) {
			throw new Error(
				"Key used already or never filled or invalid message counter",
			);
		}
		const keys = hkdfSignalDeriveSecrets(
			messageKey,
			new Uint8Array(32),
			utf8ToBytes("WhisperMessageKeys"),
		);
		const ourIdentityKey = await this.storage.getOurIdentity();
		const macInput = new Uint8Array(messageProto.byteLength + 33 * 2 + 1);
		macInput.set(session.indexInfo.remoteIdentityKey);
		macInput.set(ourIdentityKey.publicKey, 33);
		macInput[33 * 2] = this._encodeTupleByte(VERSION, VERSION);
		macInput.set(messageProto, 33 * 2 + 1);
		hmacSha256Verify(macInput, keys[1], messageBuffer.slice(-8), 8);
		const plaintext = aesDecrypt(
			keys[0],
			message.ciphertext,
			keys[2].slice(0, 16),
		);
		delete chain.messageKeys[message.counter];
		session.pendingPreKey = undefined;
		return plaintext;
	}

	private fillMessageKeys(
		chain: {
			chainKey: { counter: number; key: Uint8Array | null | undefined };
			messageKeys: Record<number, Uint8Array>;
		},
		counter: number,
	): void {
		if (counter - chain.chainKey.counter > MAX_SKIPPED_MESSAGE_KEYS) {
			throw new Error("Too many messages skipped");
		}
		if (chain.chainKey.key == null) {
			throw new Error("Chain closed, cannot derive keys");
		}
		for (let i = chain.chainKey.counter + 1; i <= counter; i++) {
			if (Object.keys(chain.messageKeys).length >= MAX_SKIPPED_MESSAGE_KEYS) {
				throw new Error("Skipped message keys storage limit reached");
			}
			const messageKey = hmacSign(chain.chainKey.key, new Uint8Array([1]));
			const nextChainKey = hmacSign(chain.chainKey.key, new Uint8Array([2]));
			chain.messageKeys[i] = messageKey;
			chain.chainKey.key = nextChainKey;
			chain.chainKey.counter = i;
		}
	}

	private maybeStepRatchet(
		session: SessionEntry,
		remoteKey: Uint8Array,
		previousCounter: number,
	): void {
		if (session.getChain(remoteKey)) {
			return;
		}
		const ratchet = session.currentRatchet;
		const previousRatchet = session.getChain(ratchet.lastRemoteEphemeralKey);
		if (previousRatchet) {
			this.fillMessageKeys(previousRatchet, previousCounter);
			previousRatchet.chainKey.key = null;
		}
		this.calculateRatchet(session, remoteKey, false);
		const prevCounter = session.getChain(ratchet.ephemeralKeyPair.publicKey);
		if (prevCounter) {
			ratchet.previousCounter = prevCounter.chainKey.counter;
			session.deleteChain(ratchet.ephemeralKeyPair.publicKey);
		}
		ratchet.ephemeralKeyPair = Curve.generateKeyPair();
		this.calculateRatchet(session, remoteKey, true);
		ratchet.lastRemoteEphemeralKey = remoteKey;
	}

	private calculateRatchet(
		session: SessionEntry,
		remoteKey: Uint8Array,
		sending: boolean,
	): void {
		const ratchet = session.currentRatchet;
		const sharedSecret = Curve.sharedKey(
			ratchet.ephemeralKeyPair.privateKey,
			remoteKey,
		);
		const masterKey = hkdfSignalDeriveSecrets(
			sharedSecret,
			ratchet.rootKey,
			utf8ToBytes("WhisperRatchet"),
		);
		const chainKey = sending ? ratchet.ephemeralKeyPair.publicKey : remoteKey;
		session.addChain(chainKey, {
			messageKeys: {},
			chainKey: {
				counter: -1,
				key: masterKey[1],
			},
			chainType: sending ? ChainType.SENDING : ChainType.RECEIVING,
		});
		ratchet.rootKey = masterKey[0];
	}

	public async hasOpenSession(): Promise<boolean> {
		return this.mutex.runExclusive(async () => {
			const record = await this.getRecord();
			if (!record) {
				return false;
			}
			return record.haveOpenSession();
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
