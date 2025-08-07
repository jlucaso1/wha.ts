import {
	type AuthenticationCreds,
	AuthenticationCredsSchema,
	type IAuthStateProvider,
	type ICollection,
	type ISignalProtocolStore,
	type IStorageDatabase,
} from "@wha.ts/types";
import { initAuthCreds } from "@wha.ts/utils/generic";
import { Mutex } from "@wha.ts/utils/mutex-utils";
import { CREDS_KEY } from "./constants";
import { InMemoryStorageDatabase } from "./in-memory";
import { deserialize, serialize } from "./serialization";
import { GenericSignalKeyStore } from "./signal-store";

export class GenericAuthState implements IAuthStateProvider {
	public creds: AuthenticationCreds;
	public keys: ISignalProtocolStore;

	private credsCollection: ICollection<string>;
	private db: IStorageDatabase;
	private saveMutex: Mutex;

	private constructor(
		creds: AuthenticationCreds,
		keys: ISignalProtocolStore,
		db: IStorageDatabase,
		mutex: Mutex,
	) {
		this.creds = creds;
		this.keys = keys;
		this.db = db;
		this.credsCollection = db.getCollection<string>("auth-creds");
		this.saveMutex = mutex;
	}

	static async init(
		db: IStorageDatabase = new InMemoryStorageDatabase(),
	): Promise<GenericAuthState> {
		const saveMutex = new Mutex();
		let creds: AuthenticationCreds;
		const credsCollection = db.getCollection<string>("auth-creds");

		try {
			const parsedCreds = deserialize(
				await credsCollection.get(CREDS_KEY),
				AuthenticationCredsSchema,
			);

			if (parsedCreds) {
				creds = parsedCreds || initAuthCreds();
			} else {
				creds = initAuthCreds();
			}
		} catch (error) {
			console.error(
				"[GenericAuthState] Error loading credentials, initializing new ones:",
				error,
			);
			creds = initAuthCreds();
		}

		const keyStore = new GenericSignalKeyStore(db, saveMutex);
		const authState = new GenericAuthState(creds, keyStore, db, saveMutex);

		return authState;
	}

	async saveCreds(): Promise<void> {
		return this.saveMutex.runExclusive(async () => {
			try {
				await this.credsCollection.set(CREDS_KEY, serialize(this.creds));
			} catch (error) {
				console.error("[GenericAuthState] Error saving credentials:", error);
				throw error;
			}
		});
	}

	async clearData(): Promise<void> {
		return this.saveMutex.runExclusive(async () => {
			console.warn("[GenericAuthState] Clearing all authentication data!");
			try {
				await this.credsCollection.remove(CREDS_KEY);
				await this.db.getCollection("prekey-store").clear();
				await this.db.getCollection("session-store").clear();
				await this.db.getCollection("identity-store").clear();
				await this.db.getCollection("signed-prekey-store").clear();
				await this.db.getCollection("senderkey-store").clear();
				await this.db.getCollection("auth-creds").clear();

				// Re-initialize creds and SignalKeyStore
				this.creds = initAuthCreds();
				this.keys = new GenericSignalKeyStore(this.db, this.saveMutex);

				await this.saveCreds();
			} catch (error) {
				console.error(
					"[GenericAuthState] Error clearing authentication data:",
					error,
				);
				throw error;
			}
		});
	}
}
