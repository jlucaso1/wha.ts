import { bytesToBase64 } from "@wha.ts/utils/src/bytes-utils";
import type { KeyPair } from "@wha.ts/utils/src/types";
import { BaseKeyType } from "./base_key_type";
import { ChainType } from "./chain_type";

import { create, fromBinary, protoInt64, toBinary } from "@bufbuild/protobuf";
import {
	ProtoBaseKeyType,
	ProtoChainType,
	ProtoSessionEntrySchema,
	ProtoSessionRecordSchema,
} from "@wha.ts/proto";
import type {
	ProtoSessionEntry as ProtoSessionEntryType,
	ProtoSessionRecord as ProtoSessionRecordType,
} from "@wha.ts/proto/gen/signal_session_pb";

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

export class SessionRecord {
	sessions: { [baseKeyBase64: string]: ProtoSessionEntryType } = {};
	version: string = SESSION_RECORD_VERSION;

	static createEntry(): ProtoSessionEntryType {
		return create(ProtoSessionEntrySchema);
	}

	static deserialize(data: Uint8Array): SessionRecord {
		const protoRecord = fromBinary(
			ProtoSessionRecordSchema,
			data,
		) as ProtoSessionRecordType;
		const record = new SessionRecord();
		record.version = protoRecord.version || SESSION_RECORD_VERSION;
		record.sessions = protoRecord.sessions;
		return record;
	}

	serialize(): Uint8Array {
		const protoRecord = create(ProtoSessionRecordSchema);
		protoRecord.version = this.version;
		protoRecord.sessions = this.sessions;
		return toBinary(ProtoSessionRecordSchema, protoRecord);
	}

	haveOpenSession(): boolean {
		const openSession = this.getOpenSession();
		return !!openSession && typeof openSession.registrationId === "number";
	}

	getSession(baseKey: Uint8Array): ProtoSessionEntryType | undefined {
		const keyBase64 = bytesToBase64(baseKey);
		const session = this.sessions[keyBase64];
		if (session && session.indexInfo?.baseKeyType === ProtoBaseKeyType.OURS) {
			throw new Error(
				"Attempted to lookup a session using our base key - use getOpenSession or iterate sessions instead.",
			);
		}
		return session;
	}

	getOpenSession(): ProtoSessionEntryType | undefined {
		let latestUsed = -1;
		let openSession: ProtoSessionEntryType | undefined = undefined;
		for (const session of Object.values(this.sessions)) {
			if (
				session.indexInfo &&
				session.indexInfo.closed === protoInt64.parse(-1)
			) {
				const usedTime = session.indexInfo ? Number(session.indexInfo.used) : 0;
				if (usedTime > latestUsed) {
					latestUsed = usedTime;
					openSession = session;
				}
			}
		}
		return openSession;
	}

	setSession(session: ProtoSessionEntryType): void {
		if (!session.indexInfo || !session.indexInfo.baseKey) {
			throw new Error("Cannot set session: Missing indexInfo or baseKey");
		}
		const baseKeyToUse = session.indexInfo.baseKey;
		this.sessions[bytesToBase64(baseKeyToUse)] = session;
	}

	getSessions(): ProtoSessionEntryType[] {
		return Array.from(Object.values(this.sessions)).sort((a, b) => {
			const aUsed = a.indexInfo?.used ? Number(a.indexInfo.used) : 0;
			const bUsed = b.indexInfo?.used ? Number(b.indexInfo.used) : 0;
			return bUsed - aUsed;
		});
	}

	closeSession(session: ProtoSessionEntryType): void {
		if (!session.indexInfo) {
			console.error("Cannot close session without indexInfo:", session);
			return;
		}
		if (this.isClosed(session)) {
			console.warn("Session already closed");
			return;
		}
		console.info("Closing session");
		session.indexInfo.closed = protoInt64.parse(Date.now());
	}

	openSession(session: ProtoSessionEntryType): void {
		if (!session.indexInfo) {
			console.error("Cannot open session without indexInfo:", session);
			return;
		}
		if (!this.isClosed(session)) {
			console.warn("Session already open");
			return;
		}
		console.info("Re-opening session");
		session.indexInfo.closed = protoInt64.parse(-1);
	}

	isClosed(session: ProtoSessionEntryType): boolean {
		return !!session.indexInfo && Number(session.indexInfo.closed) !== -1;
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
			const aClosed = a.indexInfo?.closed
				? Number(a.indexInfo.closed)
				: Number.POSITIVE_INFINITY;
			const bClosed = b.indexInfo?.closed
				? Number(b.indexInfo.closed)
				: Number.POSITIVE_INFINITY;
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
			const [keyToRemove] = closedSession;
			delete this.sessions[keyToRemove];
		}
	}

	deleteAllSessions(): void {
		console.warn("Deleting all sessions from the record!");
		this.sessions = {};
	}
}
