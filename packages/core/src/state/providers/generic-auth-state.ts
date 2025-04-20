import { deserializer, serializer } from "@wha.ts/utils/src/serializer";
import { type Storage, createStorage } from "unstorage";
import type {
	AuthenticationCreds,
	IAuthStateProvider,
	ISignalProtocolStore,
	SignalDataSet,
	SignalDataTypeMap,
} from "../interface";
import { generatePreKeys, initAuthCreds } from "../utils";

const CREDS_KEY = "auth:creds";
const SIGNAL_KEY_PREFIX = "signal:";

class GenericSignalKeyStore implements ISignalProtocolStore {
	constructor(private storage: Storage) {}

	private getSignalKey(type: keyof SignalDataTypeMap, id: string): string {
		const safeId = id.replace(/:/g, "_");
		return `${SIGNAL_KEY_PREFIX}${type}:${safeId}`;
	}

	async get<T extends keyof SignalDataTypeMap>(
		type: T,
		ids: string[],
	): Promise<{ [id: string]: SignalDataTypeMap[T] | undefined }> {
		if (!ids || ids.length === 0) {
			return {};
		}

		const storageKeys = ids.map((id) => this.getSignalKey(type, id));

		const finalResults: { [id: string]: SignalDataTypeMap[T] | undefined } = {};

		try {
			const batchResults = await this.storage.getItems(storageKeys);

			const resultMap = new Map<string, string | null>();
			for (const item of batchResults) {
				resultMap.set(item.key, item.value as string);
			}

			for (const id of ids) {
				const storageKey = this.getSignalKey(type, id);
				const rawValue = resultMap.get(storageKey);

				if (rawValue !== null && rawValue !== undefined) {
					try {
						const parsedValue = deserializer(
							JSON.stringify(rawValue),
						) as SignalDataTypeMap[T];
						finalResults[id] = parsedValue;
					} catch (error) {
						console.error(
							`[GenericSignalKeyStore] Error parsing item ${storageKey} for id ${id}:`,
							error,
							"Raw value:",
							rawValue,
						);
					}
				}
			}
		} catch (error) {
			console.error(
				`[GenericSignalKeyStore] Error using getItems for type ${type} and keys ${storageKeys.join(
					", ",
				)}:`,
				error,
			);
		}

		return finalResults;
	}

	async set(data: SignalDataSet): Promise<void> {
		const itemsToSet: { key: string; value: string | null }[] = [];

		for (const typeStr in data) {
			const type = typeStr as keyof SignalDataTypeMap;
			const dataOfType = data[type];
			if (!dataOfType) continue;

			for (const id in dataOfType) {
				const key = this.getSignalKey(type, id);
				const value = dataOfType[id];

				if (value === null || value === undefined) {
					itemsToSet.push({ key: key, value: null });
				} else {
					try {
						const serializedValue = serializer(value);
						itemsToSet.push({ key: key, value: serializedValue });
					} catch (error) {
						console.error(
							`[GenericSignalKeyStore] Error serializing value for key ${key} (id: ${id}, type: ${type}):`,
							error,
						);
					}
				}
			}
		}

		if (itemsToSet.length === 0) {
			return;
		}

		try {
			await this.storage.setItems(itemsToSet);
		} catch (error) {
			const keys = itemsToSet.map((i) => i.key).join(", ");
			console.error(
				`[GenericSignalKeyStore] Error using setItems for keys ${keys}:`,
				error,
			);
			throw error;
		}
	}
	/**
	 * Retrieves all session data for all devices of a given user.
	 * Returns a mapping from ProtocolAddress string (user@server_deviceId) to session data (Uint8Array).
	 */
	async getAllSessionsForUser(
		userId: string,
	): Promise<{ [address: string]: SignalDataTypeMap["session"] | undefined }> {
		const prefix = `${SIGNAL_KEY_PREFIX}session:${userId}_`;
		let keys: string[] = [];
		try {
			keys = await this.storage.getKeys(prefix);
		} catch (err) {
			console.error(
				`[GenericSignalKeyStore] Error getting session keys for user ${userId}:`,
				err,
			);
			return {};
		}
		if (!keys.length) return {};

		let items: { key: string; value: string | null }[] = [];
		try {
			items = await this.storage.getItems(keys);
		} catch (err) {
			console.error(
				`[GenericSignalKeyStore] Error getting session items for user ${userId}:`,
				err,
			);
			return {};
		}

		const result: {
			[address: string]: SignalDataTypeMap["session"] | undefined;
		} = {};
		for (const { key, value } of items) {
			if (value !== null && value !== undefined) {
				try {
					const prefixStr = `${SIGNAL_KEY_PREFIX}session:`;
					const address = key.slice(prefixStr.length);
					result[address] = deserializer(value) as SignalDataTypeMap["session"];
				} catch (err) {
					console.error(
						`[GenericSignalKeyStore] Error deserializing session for key ${key}:`,
						err,
					);
				}
			}
		}
		return result;
	}
}

export class GenericAuthState implements IAuthStateProvider {
	public creds: AuthenticationCreds;
	public keys: ISignalProtocolStore;

	private constructor(
		creds: AuthenticationCreds,
		keys: ISignalProtocolStore,
		private storage: Storage,
	) {
		this.creds = creds;
		this.keys = keys;
	}

	static async init(storage = createStorage()): Promise<GenericAuthState> {
		let creds: AuthenticationCreds;
		let loadedCreds = false;
		try {
			const credsValue = await storage.getItem(CREDS_KEY);
			if (credsValue !== null && typeof credsValue === "string") {
				creds = deserializer(credsValue);
				loadedCreds = true;
			} else if (credsValue !== null) {
				try {
					creds = deserializer(JSON.stringify(credsValue));
					loadedCreds = true;
				} catch {
					console.warn(
						"[GenericAuthState] Recovery failed, initializing new creds.",
					);
					creds = initAuthCreds();
				}
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

		// Generate and store initial pre-keys ONLY if creds were newly initialized
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
			const serializedCreds = serializer(this.creds);
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
		} catch (error) {
			console.error(
				"[GenericAuthState] Error clearing authentication data:",
				error,
			);
			throw error;
		}
	}
}
