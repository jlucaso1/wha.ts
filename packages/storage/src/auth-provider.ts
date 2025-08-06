import type {
	AuthenticationCreds,
	IAuthStateProvider,
	ISignalProtocolStore,
} from "@wha.ts/core";
import { generatePreKeys, initAuthCreds } from "@wha.ts/core";
import { AuthenticationCredsSchema } from "@wha.ts/core/state/interface";
import { CREDS_KEY } from "./constants";
import { InMemoryStorageDatabase } from "./in-memory";
import { deserialize, serialize } from "./serialization";
import { GenericSignalKeyStore } from "./signal-store";
import type { ICollection, IStorageDatabase } from "./types";

export class GenericAuthState implements IAuthStateProvider {
	public creds: AuthenticationCreds;
	public keys: ISignalProtocolStore;

	private credsCollection: ICollection<string>;
	private db: IStorageDatabase;

	private constructor(
		creds: AuthenticationCreds,
		keys: ISignalProtocolStore,
		db: IStorageDatabase,
	) {
		this.creds = creds;
		this.keys = keys;
		this.db = db;
		this.credsCollection = db.getCollection<string>("auth-creds");
	}

	static async init(
		db: IStorageDatabase = new InMemoryStorageDatabase(),
	): Promise<GenericAuthState> {
		let creds: AuthenticationCreds;
		let loadedCreds = false;
		const credsCollection = db.getCollection<string>("auth-creds");

		try {
			const parsedCreds = deserialize(
				await credsCollection.get(CREDS_KEY),
				AuthenticationCredsSchema,
			);

			if (parsedCreds) {
				creds = parsedCreds || initAuthCreds();
				loadedCreds = true;
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

		const keyStore = new GenericSignalKeyStore(db);
		const authState = new GenericAuthState(creds, keyStore, db);

		if (!loadedCreds) {
			const INITIAL_PREKEY_COUNT = 30;
			const preKeys = generatePreKeys(creds.nextPreKeyId, INITIAL_PREKEY_COUNT);
			// This `set` will now route to the appropriate collection via GenericSignalKeyStore
			await keyStore.set({ "pre-key": preKeys });
			creds.nextPreKeyId += INITIAL_PREKEY_COUNT;
			await authState.saveCreds();
		}

		return authState;
	}

	async saveCreds(): Promise<void> {
		try {
			await this.credsCollection.set(CREDS_KEY, serialize(this.creds));
		} catch (error) {
			console.error("[GenericAuthState] Error saving credentials:", error);
			throw error;
		}
	}

	async clearData(): Promise<void> {
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
			this.keys = new GenericSignalKeyStore(this.db);

			const INITIAL_PREKEY_COUNT = 30;
			const preKeys = generatePreKeys(
				this.creds.nextPreKeyId,
				INITIAL_PREKEY_COUNT,
			);
			await this.keys.set({ "pre-key": preKeys });
			this.creds.nextPreKeyId += INITIAL_PREKEY_COUNT;
			await this.saveCreds();
		} catch (error) {
			console.error(
				"[GenericAuthState] Error clearing authentication data:",
				error,
			);
			throw error;
		}
	}
}
