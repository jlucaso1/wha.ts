import {
	assertBytes,
	base64ToBytes,
	bytesToBase64,
} from "@wha.ts/utils/src/bytes-utils";
import { BufferJSON } from "@wha.ts/utils/src/serializer";
import { BaseKeyType } from "./base_key_type";

const CLOSED_SESSIONS_MAX = 40;
const SESSION_RECORD_VERSION = "v1";

interface EphemeralKeyPair {
	publicKey: Uint8Array;
	privateKey: Uint8Array;
}

interface CurrentRatchet {
	ephemeralKeyPair: EphemeralKeyPair;
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
	baseKey: Uint8Array;
	[key: string]: unknown;
}

interface Chain {
	chainKey: {
		counter: number;
		key: Uint8Array | null;
	};
	chainType: number;
	messageKeys: { [key: string]: Uint8Array };
}

export class SessionEntry {
	registrationId?: number;
	currentRatchet!: CurrentRatchet;
	indexInfo!: IndexInfo;
	pendingPreKey?: PendingPreKey;
	private _chains: { [key: string]: Chain } = {};

	toString(): string {
		const baseKey =
			this.indexInfo?.baseKey && bytesToBase64(this.indexInfo.baseKey);
		return `<SessionEntry [baseKey=${baseKey}]>`;
	}

	addChain(key: Uint8Array, value: Chain): void {
		assertBytes(key);
		const id = bytesToBase64(key);
		if (Object.prototype.hasOwnProperty.call(this._chains, id)) {
			throw new Error("Overwrite attempt");
		}
		this._chains[id] = value;
	}

	getChain(key: Uint8Array): Chain | undefined {
		assertBytes(key);
		return this._chains[bytesToBase64(key)];
	}

	deleteChain(key: Uint8Array): void {
		assertBytes(key);
		const id = bytesToBase64(key);
		if (!Object.prototype.hasOwnProperty.call(this._chains, id)) {
			throw new ReferenceError("Not Found");
		}
		delete this._chains[id];
	}

	*chains(): IterableIterator<[Uint8Array, Chain]> {
		for (const [k, v] of Object.entries(this._chains)) {
			yield [base64ToBytes(k), v];
		}
	}

	serialize(): any {
		return JSON.parse(JSON.stringify(this, BufferJSON.replacer));
	}

	static deserialize(data: any): SessionEntry {
		const parsed =
			typeof data === "string" ? JSON.parse(data, BufferJSON.reviver) : data;
		const obj = Object.assign(new SessionEntry(), parsed);
		return obj;
	}
}

interface Migration {
	version: string;
	migrate: (data: Record<string, unknown>) => void;
}

const migrations: Migration[] = [
	{
		version: "v1",
		migrate: function migrateV1(data: Record<string, unknown>) {
			const sessions = (data as any)._sessions;
			if ((data as any).registrationId) {
				for (const key in sessions) {
					if (!sessions[key].registrationId) {
						sessions[key].registrationId = (data as any).registrationId;
					}
				}
			} else {
				for (const key in sessions) {
					if (sessions[key].indexInfo.closed === -1) {
						console.error(
							"V1 session storage migration error: registrationId",
							(data as any).registrationId,
							"for open session version",
							(data as any).version,
						);
					}
				}
			}
		},
	},
];

export class SessionRecord {
	sessions: { [key: string]: SessionEntry } = {};
	version: string = SESSION_RECORD_VERSION;

	static createEntry(): SessionEntry {
		return new SessionEntry();
	}

	static migrate(data: Record<string, unknown>): void {
		let run = (data as any).version === undefined;
		for (let i = 0; i < migrations.length; ++i) {
			const migration = migrations[i];
			if (!migration) continue;
			if (run) {
				console.info("Migrating session to:", migration.version);
				migration.migrate(data);
			} else if (migration.version === (data as any).version) {
				run = true;
			}
		}
		if (!run) {
			throw new Error("Error migrating SessionRecord");
		}
	}

	static deserialize(data: Record<string, unknown>): SessionRecord {
		if ((data as any).version !== SESSION_RECORD_VERSION) {
			SessionRecord.migrate(data);
		}
		const obj = new SessionRecord();
		if ((data as any)._sessions) {
			for (const [key, entry] of Object.entries((data as any)._sessions)) {
				obj.sessions[key] = SessionEntry.deserialize(entry);
			}
		}
		return obj;
	}

	serialize(): Record<string, unknown> {
		const _sessions: { [key: string]: unknown } = {};
		for (const [key, entry] of Object.entries(this.sessions)) {
			_sessions[key] = entry.serialize();
		}
		return {
			_sessions,
			version: this.version,
		};
	}

	haveOpenSession(): boolean {
		const openSession = this.getOpenSession();
		return !!openSession && typeof openSession.registrationId === "number";
	}

	getSession(key: Uint8Array): SessionEntry | undefined {
		assertBytes(key);
		const session = this.sessions[bytesToBase64(key)];
		if (session && session.indexInfo.baseKeyType === BaseKeyType.OURS) {
			throw new Error("Tried to lookup a session using our basekey");
		}
		return session;
	}

	getOpenSession(): SessionEntry | undefined {
		for (const session of Object.values(this.sessions)) {
			if (!this.isClosed(session)) {
				return session;
			}
		}
	}

	setSession(session: SessionEntry): void {
		this.sessions[bytesToBase64(session.indexInfo.baseKey)] = session;
	}

	getSessions(): SessionEntry[] {
		return Array.from(Object.values(this.sessions)).sort((a, b) => {
			const aUsed = a.indexInfo.used || 0;
			const bUsed = b.indexInfo.used || 0;
			return aUsed === bUsed ? 0 : aUsed < bUsed ? 1 : -1;
		});
	}

	closeSession(session: SessionEntry): void {
		if (this.isClosed(session)) {
			console.warn("Session already closed", session);
			return;
		}
		console.info("Closing session:", session);
		session.indexInfo.closed = Date.now();
	}

	openSession(session: SessionEntry): void {
		if (!this.isClosed(session)) {
			console.warn("Session already open");
		}
		console.info("Opening session:", session);
		session.indexInfo.closed = -1;
	}

	isClosed(session: SessionEntry): boolean {
		return session.indexInfo.closed !== -1;
	}

	removeOldSessions(): void {
		while (Object.keys(this.sessions).length > CLOSED_SESSIONS_MAX) {
			let oldestKey: string | undefined;
			let oldestSession: SessionEntry | undefined;
			for (const [key, session] of Object.entries(this.sessions)) {
				if (
					session.indexInfo.closed !== -1 &&
					(!oldestSession ||
						session.indexInfo.closed < oldestSession.indexInfo.closed)
				) {
					oldestKey = key;
					oldestSession = session;
				}
			}
			if (oldestKey) {
				console.info("Removing old closed session:", oldestSession);
				delete this.sessions[oldestKey];
			} else {
				throw new Error("Corrupt sessions object");
			}
		}
	}

	deleteAllSessions(): void {
		for (const key of Object.keys(this.sessions)) {
			delete this.sessions[key];
		}
	}
}
