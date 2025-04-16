import {
	assertBytes,
	base64ToBytes,
	bytesToBase64,
} from "@wha.ts/utils/src/bytes-utils";
import type { KeyPair } from "@wha.ts/utils/src/types";
import { BaseKeyType } from "./base_key_type";
import type { ChainType } from "./chain_type";

const CLOSED_SESSIONS_MAX = 40;
const SESSION_RECORD_VERSION = "v1";

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
	[key: string]: unknown;
}

export interface Chain {
	chainKey: {
		counter: number;
		key: Uint8Array | null;
	};
	chainType: ChainType;
	messageKeys: { [messageNumber: number]: Uint8Array };
}

interface SerializedEphemeralKeyPair {
	publicKey: string;
	privateKey: string;
}

interface SerializedCurrentRatchet {
	ephemeralKeyPair: SerializedEphemeralKeyPair;
	lastRemoteEphemeralKey: string;
	previousCounter: number;
	rootKey: string;
}

interface SerializedIndexInfo {
	baseKey: string;
	baseKeyType: BaseKeyType;
	closed: number;
	used: number;
	created: number;
	remoteIdentityKey: string;
}

interface SerializedPendingPreKey {
	signedKeyId: number;
	baseKey: string;
	preKeyId?: number;
	[key: string]: unknown;
}

interface SerializedChain {
	chainKey: {
		counter: number;
		key: string | null;
	};
	chainType: ChainType;
	messageKeys: { [messageNumber: number]: string };
}

interface SerializedSessionEntry {
	registrationId?: number;
	currentRatchet: SerializedCurrentRatchet;
	indexInfo: SerializedIndexInfo;
	pendingPreKey?: SerializedPendingPreKey;
	_chains: { [ephemeralKeyBase64: string]: SerializedChain };
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

	serialize(): SerializedSessionEntry {
		const serializedChains: {
			[ephemeralKeyBase64: string]: SerializedChain;
		} = {};
		for (const [keyBase64, chain] of Object.entries(this._chains)) {
			const serializedMessageKeys: { [num: number]: string } = {};
			for (const [msgNum, msgKey] of Object.entries(chain.messageKeys)) {
				serializedMessageKeys[Number(msgNum)] = bytesToBase64(msgKey);
			}
			serializedChains[keyBase64] = {
				chainKey: {
					counter: chain.chainKey.counter,
					key: chain.chainKey.key ? bytesToBase64(chain.chainKey.key) : null,
				},
				chainType: chain.chainType,
				messageKeys: serializedMessageKeys,
			};
		}

		const data: SerializedSessionEntry = {
			registrationId: this.registrationId,
			currentRatchet: {
				ephemeralKeyPair: {
					publicKey: bytesToBase64(
						this.currentRatchet.ephemeralKeyPair.publicKey,
					),
					privateKey: bytesToBase64(
						this.currentRatchet.ephemeralKeyPair.privateKey,
					),
				},
				lastRemoteEphemeralKey: bytesToBase64(
					this.currentRatchet.lastRemoteEphemeralKey,
				),
				previousCounter: this.currentRatchet.previousCounter,
				rootKey: bytesToBase64(this.currentRatchet.rootKey),
			},
			indexInfo: {
				baseKey: bytesToBase64(this.indexInfo.baseKey),
				baseKeyType: this.indexInfo.baseKeyType,
				closed: this.indexInfo.closed,
				used: this.indexInfo.used,
				created: this.indexInfo.created,
				remoteIdentityKey: bytesToBase64(this.indexInfo.remoteIdentityKey),
			},
			_chains: serializedChains,
		};

		if (this.pendingPreKey) {
			const serializedPending: SerializedPendingPreKey = {
				...(this.pendingPreKey as Omit<PendingPreKey, "baseKey"> & {
					baseKey: Uint8Array;
				}),
				baseKey: bytesToBase64(this.pendingPreKey.baseKey),
				signedKeyId: this.pendingPreKey.signedKeyId,
			};
			data.pendingPreKey = serializedPending;
		}

		return data;
	}

	static deserialize(data: SerializedSessionEntry): SessionEntry {
		const obj = new SessionEntry();

		obj.registrationId = data.registrationId;

		obj.currentRatchet = {
			ephemeralKeyPair: {
				publicKey: base64ToBytes(
					data.currentRatchet.ephemeralKeyPair.publicKey,
				),
				privateKey: base64ToBytes(
					data.currentRatchet.ephemeralKeyPair.privateKey,
				),
			},
			lastRemoteEphemeralKey: base64ToBytes(
				data.currentRatchet.lastRemoteEphemeralKey,
			),
			previousCounter: data.currentRatchet.previousCounter,
			rootKey: base64ToBytes(data.currentRatchet.rootKey),
		};

		obj.indexInfo = {
			baseKey: base64ToBytes(data.indexInfo.baseKey),
			baseKeyType: data.indexInfo.baseKeyType,
			closed: data.indexInfo.closed,
			used: data.indexInfo.used,
			created: data.indexInfo.created,
			remoteIdentityKey: base64ToBytes(data.indexInfo.remoteIdentityKey),
		};

		const deserializedChains: { [ephemeralKeyBase64: string]: Chain } = {};
		for (const [keyBase64, sChain] of Object.entries(data._chains)) {
			const deserializedMessageKeys: { [num: number]: Uint8Array } = {};
			for (const [msgNum, msgKeyBase64] of Object.entries(sChain.messageKeys)) {
				deserializedMessageKeys[Number(msgNum)] = base64ToBytes(msgKeyBase64);
			}
			deserializedChains[keyBase64] = {
				chainKey: {
					counter: sChain.chainKey.counter,
					key: sChain.chainKey.key ? base64ToBytes(sChain.chainKey.key) : null,
				},
				chainType: sChain.chainType,
				messageKeys: deserializedMessageKeys,
			};
		}
		obj._chains = deserializedChains;

		if (data.pendingPreKey) {
			const deserializedPending: PendingPreKey = {
				...(data.pendingPreKey as Omit<SerializedPendingPreKey, "baseKey"> & {
					baseKey: string;
				}),
				baseKey: base64ToBytes(data.pendingPreKey.baseKey),
				signedKeyId: data.pendingPreKey.signedKeyId,
			};
			obj.pendingPreKey = deserializedPending;
		}

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
			if (!sessions) return;

			const registrationId = (data as any).registrationId;
			if (registrationId) {
				for (const key in sessions) {
					if (
						sessions[key] &&
						!Object.prototype.hasOwnProperty.call(
							sessions[key],
							"registrationId",
						)
					) {
						sessions[key].registrationId = registrationId;
					}
				}
			} else {
			}
		},
	},
];

interface SerializedSessionRecord {
	_sessions: { [baseKeyBase64: string]: SerializedSessionEntry };
	version: string;
}

export class SessionRecord {
	sessions: { [baseKeyBase64: string]: SessionEntry } = {};
	version: string = SESSION_RECORD_VERSION;

	static createEntry(): SessionEntry {
		return new SessionEntry();
	}

	static migrate(data: Record<string, unknown>): void {
		const currentVersion = (data as any).version;
		let run = currentVersion === undefined;
		const dataToMigrate = data;

		for (let i = 0; i < migrations.length; ++i) {
			const migration = migrations[i];
			if (!migration) continue;

			if (run) {
				console.info("Migrating session to:", migration.version);
				try {
					migration.migrate(dataToMigrate);
					(dataToMigrate as any).version = migration.version;
				} catch (e) {
					console.error(`Error during migration to ${migration.version}:`, e);
					throw new Error(
						`Failed migrating SessionRecord to ${migration.version}`,
					);
				}
			} else if (migration.version === currentVersion) {
				run = true;
			}
		}

		if ((dataToMigrate as any).version !== SESSION_RECORD_VERSION) {
			const versionHistory = migrations.map((m) => m.version);
			if (
				currentVersion === undefined ||
				versionHistory.indexOf(currentVersion) <
					versionHistory.indexOf(SESSION_RECORD_VERSION)
			) {
				console.error(
					`Migration finished, but final version is ${(dataToMigrate as any).version}, expected ${SESSION_RECORD_VERSION}`,
				);
			}
		}
	}

	static deserialize(
		data: SerializedSessionRecord | Record<string, unknown>,
	): SessionRecord {
		let dataToUse = data;
		if ((data as SerializedSessionRecord).version !== SESSION_RECORD_VERSION) {
			const dataToMigrate = JSON.parse(JSON.stringify(data));
			SessionRecord.migrate(dataToMigrate);
			dataToUse = dataToMigrate;
		}

		const obj = new SessionRecord();
		const sessionData = (dataToUse as SerializedSessionRecord)._sessions;

		if (sessionData) {
			for (const [baseKeyBase64, entryData] of Object.entries(sessionData)) {
				try {
					obj.sessions[baseKeyBase64] = SessionEntry.deserialize(entryData);
				} catch (e) {
					console.error(
						`Failed to deserialize session entry for key ${baseKeyBase64}:`,
						e,
						"Data:",
						entryData,
					);
				}
			}
		} else {
			console.warn(
				"Deserializing SessionRecord: No '_sessions' property found in data.",
			);
		}

		obj.version =
			(data as SerializedSessionRecord).version || SESSION_RECORD_VERSION;

		return obj;
	}

	serialize(): SerializedSessionRecord {
		const serializedSessions: {
			[baseKeyBase64: string]: SerializedSessionEntry;
		} = {};
		for (const [baseKeyBase64, entry] of Object.entries(this.sessions)) {
			try {
				serializedSessions[baseKeyBase64] = entry.serialize();
			} catch (e) {
				console.error(
					`Failed to serialize session entry for key ${baseKeyBase64}:`,
					e,
				);
			}
		}
		return {
			_sessions: serializedSessions,
			version: this.version,
		};
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
		for (const session of Object.values(this.sessions)) {
			if (!this.isClosed(session)) {
				return session;
			}
		}
		return undefined;
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
		const closedSessionsCount = sessionEntries.filter(([, session]) =>
			this.isClosed(session),
		).length;

		if (closedSessionsCount <= CLOSED_SESSIONS_MAX) {
			return;
		}

		const closedSessions = sessionEntries
			.filter(([, session]) => this.isClosed(session))
			.sort(([, a], [, b]) => {
				const aClosed = a.indexInfo?.closed ?? Number.POSITIVE_INFINITY;
				const bClosed = b.indexInfo?.closed ?? Number.POSITIVE_INFINITY;
				return aClosed - bClosed;
			});

		const sessionsToRemove = closedSessionsCount - CLOSED_SESSIONS_MAX;
		console.info(
			`Session record cleanup: Found ${closedSessionsCount} closed sessions, removing ${sessionsToRemove} oldest ones.`,
		);

		for (let i = 0; i < sessionsToRemove; i++) {
			const closedSession = closedSessions[i];
			if (!closedSession) {
				console.warn("No closed session found for removal");
				continue;
			}
			const [keyToRemove, sessionToRemove] = closedSession;
			console.info(
				`Removing old closed session (closed at ${new Date(sessionToRemove.indexInfo.closed).toISOString()}):`,
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
