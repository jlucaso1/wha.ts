import type {
	AuthenticationCreds,
	IAuthStateProvider,
	ISignalProtocolStore,
} from "@wha.ts/core";
import { generatePreKeys, initAuthCreds } from "@wha.ts/core";
import { CREDS_KEY, SIGNAL_KEY_PREFIX } from "./constants";
import { InMemorySimpleKeyValueStore } from "./in-memory";
import { deserializeWithRevival, serializeWithRevival } from "./serialization";
import { GenericSignalKeyStore } from "./signal-store";
import type { ISimpleKeyValueStore } from "./types";

export class GenericAuthState implements IAuthStateProvider {
	public creds: AuthenticationCreds;
	public keys: ISignalProtocolStore;

	private constructor(
		creds: AuthenticationCreds,
		keys: ISignalProtocolStore,
		private storage: ISimpleKeyValueStore,
	) {
		this.creds = creds;
		this.keys = keys;
	}

	static async init(
		storage: ISimpleKeyValueStore = new InMemorySimpleKeyValueStore(),
	): Promise<GenericAuthState> {
		let creds: AuthenticationCreds;
		let loadedCreds = false;
		try {
			const credsString = await storage.getItem(CREDS_KEY);
			if (credsString) {
				creds = deserializeWithRevival(credsString);
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

		const keyStore = new GenericSignalKeyStore(storage);
		const authState = new GenericAuthState(creds, keyStore, storage);

		if (!loadedCreds) {
			const INITIAL_PREKEY_COUNT = 30;
			const preKeys = generatePreKeys(creds.nextPreKeyId, INITIAL_PREKEY_COUNT);
			await keyStore.set({ "pre-key": preKeys });
			creds.nextPreKeyId += INITIAL_PREKEY_COUNT;
			await authState.saveCreds();
		}

		return authState;
	}

	async saveCreds(): Promise<void> {
		try {
			const serializedCreds = serializeWithRevival(this.creds);
			await this.storage.setItem(CREDS_KEY, serializedCreds);
		} catch (error) {
			console.error("[GenericAuthState] Error saving credentials:", error);
			throw error;
		}
	}

	async clearData(): Promise<void> {
		console.warn("[GenericAuthState] Clearing all authentication data!");
		try {
			await this.storage.removeItem(CREDS_KEY);
			await this.storage.clear(SIGNAL_KEY_PREFIX);

			this.creds = initAuthCreds();
			this.keys = new GenericSignalKeyStore(this.storage);

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
