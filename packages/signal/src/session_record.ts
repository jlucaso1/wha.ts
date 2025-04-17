import {
	assertBytes,
	base64ToBytes,
	bytesToBase64,
} from "@wha.ts/utils/src/bytes-utils";
import type { KeyPair } from "@wha.ts/utils/src/types";
import { BaseKeyType } from "./base_key_type";
import { ChainType } from "./chain_type";

import { create, fromBinary, protoInt64, toBinary } from "@bufbuild/protobuf";
import {
	ProtoBaseKeyType,
	ProtoChainKeySchema,
	ProtoChainSchema,
	ProtoChainType,
	ProtoCurrentRatchetSchema,
	ProtoIndexInfoSchema,
	ProtoKeyPairSchema,
	ProtoPendingPreKeySchema,
	ProtoSessionEntrySchema,
	ProtoSessionRecordSchema,
} from "@wha.ts/proto";

const CLOSED_SESSIONS_MAX = 40;
const SESSION_RECORD_VERSION = "v2-proto";

interface CurrentRatchet {
	ephemeralKeyPair: KeyPair;
	lastRemoteEphemeralKey: Uint8Array;
	previousCounter: number;
	rootKey: Uint8Array;
}

interface IndexInfo {
	baseKey: Uint8Array;
	baseKeyType: BaseKeyType;
	closed: number;
	used: number;
	created: number;
	remoteIdentityKey: Uint8Array;
}

interface PendingPreKey {
	signedKeyId: number;
	baseKey: Uint8Array;
	preKeyId?: number;
}

interface Chain {
	chainKey: {
		counter: number;
		key: Uint8Array | null;
	};
	chainType: ChainType;
	messageKeys: { [messageNumber: number]: Uint8Array };
}

function toProtoBaseKeyType(type: BaseKeyType): ProtoBaseKeyType {
	switch (type) {
		case BaseKeyType.OURS:
			return ProtoBaseKeyType.OURS;
		case BaseKeyType.THEIRS:
			return ProtoBaseKeyType.THEIRS;
		default:
			return ProtoBaseKeyType.UNSPECIFIED;
	}
}

function fromProtoBaseKeyType(type: ProtoBaseKeyType): BaseKeyType {
	switch (type) {
		case ProtoBaseKeyType.OURS:
			return BaseKeyType.OURS;
		case ProtoBaseKeyType.THEIRS:
			return BaseKeyType.THEIRS;
		default:
			throw new Error(`Unrecognized ProtoBaseKeyType: ${type}`);
	}
}

function toProtoChainType(type: ChainType): ProtoChainType {
	switch (type) {
		case ChainType.SENDING:
			return ProtoChainType.SENDING;
		case ChainType.RECEIVING:
			return ProtoChainType.RECEIVING;
		default:
			return ProtoChainType.UNSPECIFIED;
	}
}

function fromProtoChainType(type: ProtoChainType): ChainType {
	switch (type) {
		case ProtoChainType.SENDING:
			return ChainType.SENDING;
		case ProtoChainType.RECEIVING:
			return ChainType.RECEIVING;
		default:
			throw new Error(`Unrecognized ProtoChainType: ${type}`);
	}
}

export class SessionEntry {
	registrationId?: number;
	currentRatchet!: CurrentRatchet;
	indexInfo!: IndexInfo;
	pendingPreKey?: PendingPreKey;
	private _chains: { [ephemeralKeyBase64: string]: Chain } = {};

	toString(): string {
		const baseKey =
			this.indexInfo?.baseKey && bytesToBase64(this.indexInfo.baseKey);
		return `<SessionEntry [baseKey=${baseKey}]>`;
	}

	addChain(ephemeralPublicKey: Uint8Array, value: Chain): void {
		assertBytes(ephemeralPublicKey);
		const id = bytesToBase64(ephemeralPublicKey);
		if (Object.prototype.hasOwnProperty.call(this._chains, id)) {
			throw new Error("Overwrite attempt on chain");
		}
		this._chains[id] = value;
	}

	getChain(ephemeralPublicKey: Uint8Array): Chain | undefined {
		assertBytes(ephemeralPublicKey);
		return this._chains[bytesToBase64(ephemeralPublicKey)];
	}

	deleteChain(ephemeralPublicKey: Uint8Array): void {
		assertBytes(ephemeralPublicKey);
		const id = bytesToBase64(ephemeralPublicKey);
		if (!Object.prototype.hasOwnProperty.call(this._chains, id)) {
			console.warn(`Chain not found for deletion: ${id}`);
			return;
		}
		delete this._chains[id];
	}

	*chains(): IterableIterator<[Uint8Array, Chain]> {
		for (const [keyBase64, chain] of Object.entries(this._chains)) {
			yield [base64ToBytes(keyBase64), chain];
		}
	}

	/**
	 * Serialize this session entry to Protobuf binary format.
	 */
	serialize(): Uint8Array {
		const protoEntry = create(ProtoSessionEntrySchema);

		if (this.registrationId !== undefined) {
			protoEntry.registrationId = this.registrationId;
		}

		if (!this.currentRatchet) {
			throw new Error("Serialization error: currentRatchet is missing");
		}
		protoEntry.currentRatchet = create(ProtoCurrentRatchetSchema, {
			ephemeralKeyPair: create(ProtoKeyPairSchema, {
				publicKey: this.currentRatchet.ephemeralKeyPair.publicKey,
				privateKey: this.currentRatchet.ephemeralKeyPair.privateKey,
			}),
			lastRemoteEphemeralKey: this.currentRatchet.lastRemoteEphemeralKey,
			previousCounter: this.currentRatchet.previousCounter,
			rootKey: this.currentRatchet.rootKey,
		});

		if (!this.indexInfo) {
			throw new Error("Serialization error: indexInfo is missing");
		}
		protoEntry.indexInfo = create(ProtoIndexInfoSchema, {
			baseKey: this.indexInfo.baseKey,
			baseKeyType: toProtoBaseKeyType(this.indexInfo.baseKeyType),
			closed: protoInt64.parse(this.indexInfo.closed),
			used: protoInt64.parse(this.indexInfo.used),
			created: protoInt64.parse(this.indexInfo.created),
			remoteIdentityKey: this.indexInfo.remoteIdentityKey,
		});

		if (this.pendingPreKey) {
			protoEntry.pendingPreKey = create(ProtoPendingPreKeySchema, {
				signedKeyId: this.pendingPreKey.signedKeyId,
				baseKey: this.pendingPreKey.baseKey,
				preKeyId: this.pendingPreKey.preKeyId,
			});
		}

		for (const [keyBase64, chain] of Object.entries(this._chains)) {
			const protoChain = create(ProtoChainSchema, {
				chainKey: create(ProtoChainKeySchema, {
					counter: chain.chainKey.counter,
					key: chain.chainKey.key ?? undefined,
				}),
				chainType: toProtoChainType(chain.chainType),
				messageKeys: chain.messageKeys,
			});
			protoEntry.chains[keyBase64] = protoChain;
		}

		return toBinary(ProtoSessionEntrySchema, protoEntry);
	}

	/**
	 * Deserialize Protobuf binary data into a SessionEntry.
	 */
	static deserialize(data: Uint8Array): SessionEntry {
		const protoEntry = fromBinary(ProtoSessionEntrySchema, data);
		const obj = new SessionEntry();

		obj.registrationId = protoEntry.registrationId;

		if (!protoEntry.currentRatchet) {
			throw new Error("Deserialization failed: Missing currentRatchet");
		}
		obj.currentRatchet = {
			ephemeralKeyPair: {
				publicKey:
					protoEntry.currentRatchet.ephemeralKeyPair?.publicKey ??
					new Uint8Array(),
				privateKey:
					protoEntry.currentRatchet.ephemeralKeyPair?.privateKey ??
					new Uint8Array(),
			},
			lastRemoteEphemeralKey: protoEntry.currentRatchet.lastRemoteEphemeralKey,
			previousCounter: protoEntry.currentRatchet.previousCounter,
			rootKey: protoEntry.currentRatchet.rootKey,
		};

		if (!protoEntry.indexInfo) {
			throw new Error("Deserialization failed: Missing indexInfo");
		}
		obj.indexInfo = {
			baseKey: protoEntry.indexInfo.baseKey,
			baseKeyType: fromProtoBaseKeyType(protoEntry.indexInfo.baseKeyType),
			closed: Number(protoEntry.indexInfo.closed),
			used: Number(protoEntry.indexInfo.used),
			created: Number(protoEntry.indexInfo.created),
			remoteIdentityKey: protoEntry.indexInfo.remoteIdentityKey,
		};

		if (protoEntry.pendingPreKey) {
			obj.pendingPreKey = {
				signedKeyId: protoEntry.pendingPreKey.signedKeyId,
				baseKey: protoEntry.pendingPreKey.baseKey,
				preKeyId: protoEntry.pendingPreKey.preKeyId,
			};
		}

		obj._chains = {};
		for (const [keyBase64, protoChain] of Object.entries(protoEntry.chains)) {
			if (!protoChain.chainKey) {
				throw new Error("Deserialization failed: Missing chainKey in chain");
			}
			const chain: Chain = {
				chainKey: {
					counter: protoChain.chainKey.counter,
					key: protoChain.chainKey.key ?? null,
				},
				chainType: fromProtoChainType(protoChain.chainType),
				messageKeys: {},
			};
			for (const [msgNumStr, msgKeyBytes] of Object.entries(
				protoChain.messageKeys,
			)) {
				chain.messageKeys[Number(msgNumStr)] = msgKeyBytes;
			}
			obj._chains[keyBase64] = chain;
		}

		return obj;
	}
}

export class SessionRecord {
	sessions: { [baseKeyBase64: string]: SessionEntry } = {};
	version: string = SESSION_RECORD_VERSION;

	static createEntry(): SessionEntry {
		return new SessionEntry();
	}

	static deserialize(data: Uint8Array): SessionRecord {
		const protoRecord = fromBinary(ProtoSessionRecordSchema, data);
		const obj = new SessionRecord();

		obj.version = protoRecord.version || SESSION_RECORD_VERSION;
		if (obj.version !== SESSION_RECORD_VERSION) {
			console.warn(
				`Deserializing SessionRecord with version ${obj.version}, expected ${SESSION_RECORD_VERSION}`,
			);
		}

		obj.sessions = {};
		for (const [keyBase64, protoEntry] of Object.entries(
			protoRecord.sessions,
		)) {
			const entryBytes = toBinary(ProtoSessionEntrySchema, protoEntry);
			try {
				obj.sessions[keyBase64] = SessionEntry.deserialize(entryBytes);
			} catch (e) {
				console.error(
					`Failed to deserialize session entry for key ${keyBase64}:`,
					e,
				);
			}
		}

		return obj;
	}

	serialize(outputFormat: "binary" | "object" = "binary"): Uint8Array | object {
		const protoRecord = create(ProtoSessionRecordSchema);
		protoRecord.version = this.version;

		for (const [keyBase64, entry] of Object.entries(this.sessions)) {
			try {
				const entryBytes = entry.serialize();
				const protoEntry = fromBinary(ProtoSessionEntrySchema, entryBytes);
				protoRecord.sessions[keyBase64] = protoEntry;
			} catch (e) {
				console.error(
					`Failed to serialize session entry for key ${keyBase64}:`,
					e,
				);
			}
		}

		if (outputFormat === "object") {
			return protoRecord;
		}
		return toBinary(ProtoSessionRecordSchema, protoRecord);
	}

	haveOpenSession(): boolean {
		const openSession = this.getOpenSession();
		return !!openSession && typeof openSession.registrationId === "number";
	}

	getSession(baseKey: Uint8Array): SessionEntry | undefined {
		assertBytes(baseKey);
		const keyBase64 = bytesToBase64(baseKey);
		const session = this.sessions[keyBase64];
		if (session && session.indexInfo.baseKeyType === BaseKeyType.OURS) {
			throw new Error(
				"Attempted to lookup a session using our base key - use getOpenSession or iterate sessions instead.",
			);
		}
		return session;
	}

	getOpenSession(): SessionEntry | undefined {
		let latestUsed = -1;
		let openSession: SessionEntry | undefined = undefined;
		for (const session of Object.values(this.sessions)) {
			if (!this.isClosed(session)) {
				if (session.indexInfo.used > latestUsed) {
					latestUsed = session.indexInfo.used;
					openSession = session;
				}
			}
		}
		return openSession;
	}

	setSession(session: SessionEntry): void {
		if (!session.indexInfo || !session.indexInfo.baseKey) {
			throw new Error("Cannot set session: Missing indexInfo or baseKey");
		}
		const baseKeyToUse = session.indexInfo.baseKey;
		this.sessions[bytesToBase64(baseKeyToUse)] = session;
	}

	getSessions(): SessionEntry[] {
		return Array.from(Object.values(this.sessions)).sort((a, b) => {
			const aUsed = a.indexInfo?.used ?? 0;
			const bUsed = b.indexInfo?.used ?? 0;
			return bUsed - aUsed;
		});
	}

	closeSession(session: SessionEntry): void {
		if (!session.indexInfo) {
			console.error("Cannot close session without indexInfo:", session);
			return;
		}
		if (this.isClosed(session)) {
			console.warn("Session already closed", session.toString());
			return;
		}
		console.info("Closing session:", session.toString());
		session.indexInfo.closed = Date.now();
	}

	openSession(session: SessionEntry): void {
		if (!session.indexInfo) {
			console.error("Cannot open session without indexInfo:", session);
			return;
		}
		if (!this.isClosed(session)) {
			console.warn("Session already open", session.toString());
			return;
		}
		console.info("Re-opening session:", session.toString());
		session.indexInfo.closed = -1;
	}

	isClosed(session: SessionEntry): boolean {
		return !!session.indexInfo && session.indexInfo.closed !== -1;
	}

	removeOldSessions(): void {
		const sessionEntries = Object.entries(this.sessions);
		const closedSessions = sessionEntries.filter(([, session]) =>
			this.isClosed(session),
		);

		if (closedSessions.length <= CLOSED_SESSIONS_MAX) {
			return;
		}

		closedSessions.sort(([, a], [, b]) => {
			const aClosed = a.indexInfo?.closed ?? Number.POSITIVE_INFINITY;
			const bClosed = b.indexInfo?.closed ?? Number.POSITIVE_INFINITY;
			return aClosed - bClosed;
		});

		const sessionsToRemoveCount = closedSessions.length - CLOSED_SESSIONS_MAX;
		console.info(
			`Session record cleanup: Found ${closedSessions.length} closed sessions, removing ${sessionsToRemoveCount} oldest ones.`,
		);

		for (let i = 0; i < sessionsToRemoveCount; i++) {
			const closedSession = closedSessions[i];
			if (!closedSession) {
				console.warn(`Unexpected state during session cleanup at index ${i}`);
				continue;
			}
			const [keyToRemove, sessionToRemove] = closedSession;
			const closedDate = new Date(sessionToRemove.indexInfo.closed);
			console.info(
				`Removing old closed session (closed at ${closedDate.toISOString()}):`,
				sessionToRemove.toString(),
			);
			delete this.sessions[keyToRemove];
		}
	}

	deleteAllSessions(): void {
		console.warn("Deleting all sessions from the record!");
		this.sessions = {};
	}
}
