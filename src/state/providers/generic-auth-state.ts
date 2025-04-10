import { type Storage, createStorage } from "unstorage";
import type {
	AuthenticationCreds,
	IAuthStateProvider,
	ISignalProtocolStore,
	SignalDataSet,
	SignalDataTypeMap,
} from "../interface";
import { BufferJSON, initAuthCreds } from "../utils";

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
		const results: { [id: string]: SignalDataTypeMap[T] | undefined } = {};
		const fetchPromises = ids.map(async (id) => {
			const key = this.getSignalKey(type, id);
			try {
				const value = await this.storage.getItem(key);
				if (value !== null && typeof value === "string") {
					results[id] = JSON.parse(
						value,
						BufferJSON.reviver,
					) as SignalDataTypeMap[T];
				} else if (value !== null) {
					console.warn(
						`[UnstorageSignalKeyStore] Unexpected non-string value for key ${key}:`,
						value,
					);
					try {
						results[id] = JSON.parse(
							JSON.stringify(value),
							BufferJSON.reviver,
						) as SignalDataTypeMap[T];
					} catch {}
				}
			} catch (error) {
				console.error(
					`[UnstorageSignalKeyStore] Error getting item ${key}:`,
					error,
				);
			}
		});
		await Promise.all(fetchPromises);

		return results;
	}

	async set(data: SignalDataSet): Promise<void> {
		const setPromises: Promise<void>[] = [];

		for (const typeStr in data) {
			const type = typeStr as keyof SignalDataTypeMap;
			const dataOfType = data[type];
			if (!dataOfType) continue;

			for (const id in dataOfType) {
				const key = this.getSignalKey(type, id);
				const value = dataOfType[id];

				if (value === null || value === undefined) {
					setPromises.push(
						this.storage
							.removeItem(key)
							.catch((error) =>
								console.error(
									`[UnstorageSignalKeyStore] Error removing item ${key}:`,
									error,
								),
							),
					);
				} else {
					try {
						const serializedValue = JSON.stringify(value, BufferJSON.replacer);
						setPromises.push(
							this.storage
								.setItem(key, serializedValue)
								.catch((error) =>
									console.error(
										`[UnstorageSignalKeyStore] Error setting item ${key}:`,
										error,
									),
								),
						);
					} catch (error) {
						console.error(
							`[UnstorageSignalKeyStore] Error serializing value for key ${key}:`,
							error,
						);
					}
				}
			}
		}
		await Promise.all(setPromises);
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
				"[UnstorageAuthState] Error loading credentials, initializing new ones:",
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
					"[UnstorageAuthState] Error saving newly initialized credentials after load failure:",
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
			console.error("[UnstorageAuthState] Error saving credentials:", error);
		}
	}

	async clearData(): Promise<void> {
		console.warn("[UnstorageAuthState] Clearing all authentication data!");
		try {
			await this.storage.removeItem(CREDS_KEY);

			const signalKeys = await this.storage.getKeys(SIGNAL_KEY_PREFIX);
			const removePromises = signalKeys.map((key) =>
				this.storage.removeItem(key),
			);
			await Promise.all(removePromises);

			this.creds = initAuthCreds();
			this.keys = new GenericSignalKeyStore(this.storage);
		} catch (error) {
			console.error(
				"[UnstorageAuthState] Error clearing authentication data:",
				error,
			);
		}
	}
}
