import { BufferJSON } from "@wha.ts/utils/src/serializer";
import { type Storage, createStorage } from "unstorage";
import type {
	AuthenticationCreds,
	IAuthStateProvider,
	ISignalProtocolStore,
	SignalDataSet,
	SignalDataTypeMap,
} from "../interface";
import { initAuthCreds } from "../utils";

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
				resultMap.set(
					item.key,
					item.value === undefined ? null : String(item.value),
				);
			}

			for (const id of ids) {
				const storageKey = this.getSignalKey(type, id);
				const rawValue = resultMap.get(storageKey);

				if (rawValue !== null && rawValue !== undefined) {
					try {
						const parsedValue = JSON.parse(
							rawValue,
							BufferJSON.reviver,
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
				`[GenericSignalKeyStore] Error using getItems for type ${type} and keys ${storageKeys.join(", ")}:`,
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
						const serializedValue = JSON.stringify(value, BufferJSON.replacer);
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
		try {
			const credsValue = await storage.getItem(CREDS_KEY);
			if (credsValue !== null && typeof credsValue === "string") {
				creds = JSON.parse(credsValue, BufferJSON.reviver);
			} else if (credsValue !== null) {
				try {
					creds = JSON.parse(JSON.stringify(credsValue), BufferJSON.reviver);
				} catch {
					console.warn(
						"[GenericAuthState] Recovery failed, initializing new creds.",
					);
					creds = initAuthCreds();
				}
			} else {
				creds = initAuthCreds();
				await storage.setItem(
					CREDS_KEY,
					JSON.stringify(creds, BufferJSON.replacer),
				);
			}
		} catch (error) {
			console.error(
				"[GenericAuthState] Error loading credentials, initializing new ones:",
				error,
			);
			creds = initAuthCreds();
			try {
				await storage.setItem(
					CREDS_KEY,
					JSON.stringify(creds, BufferJSON.replacer),
				);
			} catch (saveError) {
				console.error(
					"[GenericAuthState] Error saving newly initialized credentials after load failure:",
					saveError,
				);
			}
		}

		const keyStore = new GenericSignalKeyStore(storage);

		return new GenericAuthState(creds, keyStore, storage);
	}

	async saveCreds(): Promise<void> {
		try {
			const serializedCreds = JSON.stringify(this.creds, BufferJSON.replacer);
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
