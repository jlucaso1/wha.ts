import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	PreKeySignalMessageSchema,
	ProtoKeyPairSchema,
	SignalMessageSchema,
} from "@wha.ts/proto";
import {
	ProtoChainSchema,
	ProtoChainType,
	type ProtoSessionEntry as ProtoSessionEntryType,
} from "@wha.ts/proto";
import { concatBytes, utf8ToBytes } from "@wha.ts/utils";
import { bytesToBase64 } from "@wha.ts/utils";
import {
	aesDecrypt,
	aesEncrypt,
	hkdfSignalDeriveSecrets,
	hmacSha256Verify,
	hmacSign,
} from "@wha.ts/utils";
import { Curve } from "@wha.ts/utils";
import { Mutex } from "@wha.ts/utils";
import { ChainType } from "./chain_type";
import { ProtocolAddress } from "./protocol_address";
import { SessionBuilder } from "./session_builder";
import { SessionRecord } from "./session_record";
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
			if (!session.indexInfo) throw new Error("Session missing indexInfo");
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
			if (!session.currentRatchet || !session.currentRatchet.ephemeralKeyPair)
				throw new Error("Session missing currentRatchet or ephemeralKeyPair");
			const chain =
				session.chains?.[
					bytesToBase64(session.currentRatchet.ephemeralKeyPair.publicKey)
				];
			if (!chain || chain.chainType === ProtoChainType.RECEIVING) {
				throw new Error("Tried to encrypt on a receiving chain");
			}
			if (!chain.chainKey) throw new Error("Chain missing chainKey");
			this.fillMessageKeys(chain, Number(chain.chainKey.counter) + 1);
			const keyIndex = Number(chain.chainKey.counter);
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
				counter: Number(chain.chainKey.counter),
				previousCounter: Number(session.currentRatchet.previousCounter),
				ciphertext: aesEncrypt(keys[0], data, keys[2].slice(0, 16)),
			});

			const msgBuf = toBinary(SignalMessageSchema, msg);
			const macInput = new Uint8Array(msgBuf.byteLength + 33 * 2 + 1);
			macInput.set(ourIdentityKey.publicKey);
			macInput.set(session.indexInfo.remoteIdentityKey, 33);
			macInput[33 * 2] = this._encodeTupleByte(VERSION, VERSION);
			macInput.set(msgBuf, 33 * 2 + 1);
			const mac = hmacSign(keys[1], macInput);
			const message = new Uint8Array(msgBuf.byteLength + 9);
			message[0] = this._encodeTupleByte(VERSION, VERSION);
			message.set(msgBuf, 1);
			message.set(mac.slice(0, 8), msgBuf.byteLength + 1);
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
					message,
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
		sessions: ProtoSessionEntryType[],
	): Promise<{ session: ProtoSessionEntryType; plaintext: Uint8Array }> {
		if (!sessions.length) {
			throw new Error("No sessions available");
		}
		const errs: Error[] = [];
		for (const session of sessions) {
			let plaintext: Uint8Array;
			try {
				plaintext = await this.doDecryptWhisperMessage(data, session);
				if (!session.indexInfo) throw new Error("Session missing indexInfo");
				session.indexInfo.used = BigInt(Date.now());
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
			if (!result.session.indexInfo)
				throw new Error("Session missing indexInfo");
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
			if (preKeyId !== undefined && this.storage.removePreKey) {
				await this.storage.removePreKey(preKeyId);
			}
			return plaintext;
		});
	}

	private async doDecryptWhisperMessage(
		messageBuffer: Uint8Array,
		session: ProtoSessionEntryType,
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

		const chain = session.chains?.[bytesToBase64(message.ratchetKey)];
		if (!chain || chain.chainType === ProtoChainType.SENDING) {
			throw new Error("Tried to decrypt on a sending chain");
		}
		if (!chain.chainKey) throw new Error("Chain missing chainKey");
		this.fillMessageKeys(chain, Number(message.counter));
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
		if (!session.indexInfo) throw new Error("Session missing indexInfo");
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
			chainKey?: { counter?: number; key?: Uint8Array | null };
			messageKeys: Record<number, Uint8Array>;
		},
		counter: number,
	): void {
		if (!chain.chainKey) throw new Error("Chain missing chainKey");
		const startCounter =
			typeof chain.chainKey.counter === "number" ? chain.chainKey.counter : 0;
		if (counter - startCounter > MAX_SKIPPED_MESSAGE_KEYS) {
			throw new Error("Too many messages skipped");
		}
		if (!chain.chainKey.key) {
			throw new Error("Chain closed, cannot derive keys");
		}
		for (let i = startCounter + 1; i <= counter; i++) {
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
		session: ProtoSessionEntryType,
		remoteKey: Uint8Array,
		previousCounter: number,
	): void {
		if (session.chains?.[bytesToBase64(remoteKey)]) {
			return;
		}
		const ratchet = session.currentRatchet;
		if (!ratchet) throw new Error("Session missing currentRatchet");
		const previousRatchet =
			session.chains?.[bytesToBase64(ratchet.lastRemoteEphemeralKey)];
		if (previousRatchet) {
			if (!previousRatchet.chainKey) throw new Error("Chain missing chainKey");
			this.fillMessageKeys(previousRatchet, previousCounter);
			// Protobuf: set to undefined instead of null
			previousRatchet.chainKey.key = undefined;
		}
		this.calculateRatchet(session, remoteKey, false);
		const prevCounter = ratchet.ephemeralKeyPair?.publicKey
			? session.chains?.[bytesToBase64(ratchet.ephemeralKeyPair.publicKey)]
			: undefined;
		if (prevCounter?.chainKey) {
			ratchet.previousCounter = Number(prevCounter.chainKey.counter);
			if (ratchet.ephemeralKeyPair?.publicKey) {
				delete session.chains[
					bytesToBase64(ratchet.ephemeralKeyPair.publicKey)
				];
			}
		}
		const newKeyPair = Curve.generateKeyPair();
		ratchet.ephemeralKeyPair = create(ProtoKeyPairSchema, {
			publicKey: newKeyPair.publicKey,
			privateKey: newKeyPair.privateKey,
		});
		this.calculateRatchet(session, remoteKey, true);
		ratchet.lastRemoteEphemeralKey = remoteKey;
	}

	private calculateRatchet(
		session: ProtoSessionEntryType,
		remoteKey: Uint8Array,
		sending: boolean,
	): void {
		const ratchet = session.currentRatchet;
		if (!ratchet) throw new Error("Session missing currentRatchet");
		if (!ratchet.ephemeralKeyPair)
			throw new Error("Ratchet missing ephemeralKeyPair");
		if (!ratchet.ephemeralKeyPair.privateKey)
			throw new Error("Ratchet missing privateKey");
		if (!ratchet.rootKey) throw new Error("Ratchet missing rootKey");
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
		if (!chainKey) throw new Error("Missing chainKey for ratchet");
		if (!session.chains) session.chains = {};
		session.chains[bytesToBase64(chainKey)] = create(ProtoChainSchema, {
			messageKeys: {},
			chainKey: {
				counter: -1,
				key: masterKey[1],
			},
			chainType: sending ? ProtoChainType.SENDING : ProtoChainType.RECEIVING,
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
