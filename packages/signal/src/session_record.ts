import type { KeyPair } from "@wha.ts/utils";
import { bytesToBase64 } from "@wha.ts/utils";
import { BaseKeyType } from "./base_key_type";

export const SESSION_RECORD_VERSION = "v2-plain-json";
const CLOSED_SESSIONS_MAX = 40;

// Exporting these interfaces to be used by SessionCipher and SessionBuilder
export interface ISessionEntry {
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

export interface IChain {
	chainKey: {
		counter: number;
		key: Uint8Array | null;
	};
	chainType: number;
	messageKeys: { [messageNumber: number]: Uint8Array };
}

export class SessionRecord {
	sessions: { [baseKeyBase64: string]: ISessionEntry } = {};
	version: string = SESSION_RECORD_VERSION;

	static fromPlainObject(plain: {
		sessions: { [key: string]: ISessionEntry };
		version: string;
	}): SessionRecord {
		const record = new SessionRecord();
		record.sessions = plain.sessions || {};
		record.version = plain.version || SESSION_RECORD_VERSION;
		return record;
	}

	haveOpenSession(): boolean {
		const openSession = this.getOpenSession();
		return !!openSession && typeof openSession.registrationId === "number";
	}

	getSession(baseKey: Uint8Array): ISessionEntry | undefined {
		const keyBase64 = bytesToBase64(baseKey);
		const session = this.sessions[keyBase64];
		if (session?.indexInfo?.baseKeyType === BaseKeyType.OURS) {
			throw new Error(
				"Attempted to lookup a session using our base key - use getOpenSession or iterate sessions instead.",
			);
		}
		return session;
	}

	getOpenSession(): ISessionEntry | undefined {
		let latestUsed = -1n;
		let openSession: ISessionEntry | undefined;

		for (const session of Object.values(this.sessions)) {
			if (session.indexInfo && session.indexInfo.closed === -1n) {
				const usedTime = session.indexInfo.used;
				if (usedTime > latestUsed) {
					latestUsed = usedTime;
					openSession = session;
				}
			}
		}
		return openSession;
	}

	setSession(session: ISessionEntry): void {
		if (!session.indexInfo || !session.indexInfo.baseKey) {
			throw new Error("Cannot set session: Missing indexInfo or baseKey");
		}
		const baseKeyToUse = session.indexInfo.baseKey;
		this.sessions[bytesToBase64(baseKeyToUse)] = session;
	}

	getSessions(): ISessionEntry[] {
		return Object.values(this.sessions).sort((a, b) => {
			const aUsed = a.indexInfo?.used ?? 0n;
			const bUsed = b.indexInfo?.used ?? 0n;
			return Number(bUsed - aUsed);
		});
	}

	closeSession(session: ISessionEntry): void {
		if (!session.indexInfo) {
			console.error("Cannot close session without indexInfo:", session);
			return;
		}
		if (this.isClosed(session)) {
			console.warn("Session already closed");
			return;
		}
		console.info("Closing session");
		session.indexInfo.closed = BigInt(Date.now());
	}

	openSession(session: ISessionEntry): void {
		if (!session.indexInfo) {
			console.error("Cannot open session without indexInfo:", session);
			return;
		}
		if (!this.isClosed(session)) {
			console.warn("Session already open");
			return;
		}
		console.info("Re-opening session");
		session.indexInfo.closed = -1n;
	}

	isClosed(session: ISessionEntry): boolean {
		return !!session.indexInfo && session.indexInfo.closed !== -1n;
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
			const aClosed = a.indexInfo?.closed ?? BigInt(Number.POSITIVE_INFINITY);
			const bClosed = b.indexInfo?.closed ?? BigInt(Number.POSITIVE_INFINITY);
			return Number(aClosed - bClosed);
		});

		const sessionsToRemoveCount = closedSessions.length - CLOSED_SESSIONS_MAX;
		console.info(
			`Session record cleanup: Found ${closedSessions.length} closed sessions, removing ${sessionsToRemoveCount} oldest ones.`,
		);

		for (let i = 0; i < sessionsToRemoveCount; i++) {
			const keyToRemove = closedSessions[i]?.[0];
			if (keyToRemove) {
				delete this.sessions[keyToRemove];
			}
		}
	}

	deleteAllSessions(): void {
		console.warn("Deleting all sessions from the record!");
		this.sessions = {};
	}
}
