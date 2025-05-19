import * as fs from "node:fs/promises";
import * as path from "node:path";
import { base64ToBytes, bytesToBase64 } from "@wha.ts/utils/src/bytes-utils";

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

const UINT8_ARRAY_TAG = "__IS_UINT8ARRAY__";
const BIGINT_TAG = "__IS_BIGINT__";

function replacer(_key: string, value: any): any {
	if (value instanceof Uint8Array) {
		return { __tag: UINT8_ARRAY_TAG, data: bytesToBase64(value) };
	}
	if (typeof value === "bigint") {
		return { __tag: BIGINT_TAG, data: value.toString() };
	}
	return value;
}

function reviver(_key: string, value: any): any {
	if (
		typeof value === "object" &&
		value !== null &&
		typeof value.__tag === "string"
	) {
		if (value.__tag === UINT8_ARRAY_TAG && typeof value.data === "string") {
			return base64ToBytes(value.data);
		}
		if (value.__tag === BIGINT_TAG && typeof value.data === "string") {
			return BigInt(value.data);
		}
	}
	if (
		Array.isArray(value) &&
		value.length === 2 &&
		value[0] === "Uint8Array" &&
		Array.isArray(value[1]) &&
		value[1].every((item: any) => typeof item === "number")
	) {
		return new Uint8Array(value[1]);
	}
	return value;
}

function serializeWithRevival(data: any): string {
	return JSON.stringify(data, replacer);
}

function deserializeWithRevival<T = any>(
	input: string | Record<string, any> | Array<any> | null | undefined,
): T {
	let jsonStringToParse: string;

	if (input === null || input === undefined) {
		return input as T;
	}

	if (typeof input === "string") {
		jsonStringToParse = input;
	} else if (typeof input === "object") {
		console.warn(
			"[deserializeWithRevival] Received a non-string object. The storage implementation should ideally return strings. Attempting to process by re-serializing.",
		);
		jsonStringToParse = JSON.stringify(input, replacer);
	} else {
		console.error(
			`[deserializeWithRevival] Received unexpected input type: ${typeof input}. Value:`,
			input,
			"Attempting to stringify and parse.",
		);
		jsonStringToParse = String(input);
	}

	return JSON.parse(jsonStringToParse, reviver);
}

export interface ISimpleKeyValueStore {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
	removeItem(key: string): Promise<void>;
	getKeys(prefix?: string): Promise<string[]>;
	clear(prefix?: string): Promise<void>;
	getItems?(keys: string[]): Promise<{ key: string; value: string | null }[]>;
	setItems?(items: { key: string; value: string | null }[]): Promise<void>;
}

export class InMemorySimpleKeyValueStore implements ISimpleKeyValueStore {
	private store = new Map<string, string>();

	async getItem(key: string): Promise<string | null> {
		const value = this.store.get(key);
		return value === undefined ? null : value;
	}

	async setItem(key: string, value: string): Promise<void> {
		this.store.set(key, value);
	}

	async removeItem(key: string): Promise<void> {
		this.store.delete(key);
	}

	async getKeys(prefix?: string): Promise<string[]> {
		const keys = Array.from(this.store.keys());
		if (prefix) {
			return keys.filter((k) => k.startsWith(prefix));
		}
		return keys;
	}

	async clear(prefix?: string): Promise<void> {
		if (prefix) {
			const keysToRemove = await this.getKeys(prefix);
			for (const k of keysToRemove) {
				this.store.delete(k);
			}
		} else {
			this.store.clear();
		}
	}

	async getItems(
		keys: string[],
	): Promise<{ key: string; value: string | null }[]> {
		return Promise.all(
			keys.map(async (key) => ({ key, value: await this.getItem(key) })),
		);
	}

	async setItems(
		items: { key: string; value: string | null }[],
	): Promise<void> {
		for (const item of items) {
			if (item.value === null) {
				await this.removeItem(item.key);
			} else {
				await this.setItem(item.key, item.value);
			}
		}
	}
}

export class FileSystemSimpleKeyValueStore implements ISimpleKeyValueStore {
	private baseDir: string;

	constructor(directoryPath: string) {
		this.baseDir = path.resolve(directoryPath);
		console.log(
			`[FileSystemSimpleKeyValueStore] Instance CREATED. Base directory: ${this.baseDir}`,
		);
		try {
			require("node:fs").mkdirSync(this.baseDir, { recursive: true });
		} catch (err) {
			console.error(
				`[FileSystemSimpleKeyValueStore] Failed to create base directory ${this.baseDir}:`,
				err,
			);
			throw err;
		}
	}

	private keyToRelativeFilePath(key: string): string {
		const sanitizeSegment = (segment: string): string => {
			return segment.replace(/[^a-zA-Z0-9.\-_]/g, "_");
		};

		const parts = key.split(":");
		if (parts.length === 1) {
			return `${sanitizeSegment(parts[0] ?? "")}.json`;
		}
		const dirParts = parts.slice(0, -1).map(sanitizeSegment);
		const fileName = `${sanitizeSegment(parts[parts.length - 1] ?? "")}.json`;
		return path.join(...dirParts, fileName);
	}

	private relativeFilePathToKey(relPath: string): string | null {
		if (!relPath.endsWith(".json")) return null;
		const noExtension = relPath.slice(0, -5);
		const parts = noExtension.split(path.sep);
		return parts.join(":");
	}

	private getFullFilePath(key: string): string {
		return path.join(this.baseDir, this.keyToRelativeFilePath(key));
	}

	async getItem(key: string): Promise<string | null> {
		const filePath = this.getFullFilePath(key);
		try {
			const data = await fs.readFile(filePath, "utf-8");
			return data;
		} catch (error: any) {
			if (error.code === "ENOENT") {
				return null;
			}
			console.error(
				`[FileSystemStore.getItem] Error reading key "${key}" from ${filePath}:`,
				error,
			);
			throw error;
		}
	}

	async setItem(key: string, value: string): Promise<void> {
		const filePath = this.getFullFilePath(key);
		try {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, value, "utf-8");
		} catch (error) {
			console.error(
				`[FileSystemStore.setItem] Error writing key "${key}" to ${filePath}:`,
				error,
			);
			throw error;
		}
	}

	async removeItem(key: string): Promise<void> {
		const filePath = this.getFullFilePath(key);
		try {
			await fs.unlink(filePath);
		} catch (error: any) {
			if (error.code === "ENOENT") {
				return;
			}
			console.error(
				`[FileSystemStore.removeItem] Error removing key "${key}" from ${filePath}:`,
				error,
			);
			throw error;
		}
	}

	async getKeys(prefix?: string): Promise<string[]> {
		const reconstructKeyFromFullPath = (fullPath: string): string | null => {
			if (!fullPath.startsWith(this.baseDir) || !fullPath.endsWith(".json")) {
				return null;
			}
			const relPath = path.relative(this.baseDir, fullPath);
			return this.relativeFilePathToKey(relPath);
		};

		const filesToScan: string[] = [this.baseDir];
		const allFilePaths: string[] = [];

		while (filesToScan.length > 0) {
			const currentScanDir = filesToScan.pop();
			if (!currentScanDir) {
				break;
			}
			try {
				const entries = await fs.readdir(currentScanDir, {
					withFileTypes: true,
				});
				for (const entry of entries) {
					const entryPath = path.join(currentScanDir, entry.name);
					if (entry.isDirectory()) {
						filesToScan.push(entryPath);
					} else if (entry.isFile() && entry.name.endsWith(".json")) {
						allFilePaths.push(entryPath);
					}
				}
			} catch (error: any) {
				if (error.code !== "ENOENT") {
					console.error(
						`[FileSystemStore.getKeys] Error during directory scan of ${currentScanDir}:`,
						error,
					);
				}
			}
		}

		const keys = allFilePaths
			.map(reconstructKeyFromFullPath)
			.filter((k) => k !== null) as string[];

		if (prefix) {
			return keys.filter((k) => k.startsWith(prefix));
		}
		return keys;
	}

	async clear(prefix?: string): Promise<void> {
		const keysToRemove = await this.getKeys(prefix);
		for (const key of keysToRemove) {
			await this.removeItem(key);
		}
	}

	async getItems(
		keys: string[],
	): Promise<{ key: string; value: string | null }[]> {
		return Promise.all(
			keys.map(async (key) => ({ key, value: await this.getItem(key) })),
		);
	}

	async setItems(
		items: { key: string; value: string | null }[],
	): Promise<void> {
		await Promise.all(
			items.map((item) => {
				if (item.value === null) {
					return this.removeItem(item.key);
				}
				return this.setItem(item.key, item.value);
			}),
		);
	}
}

class GenericSignalKeyStore implements ISignalProtocolStore {
	constructor(private storage: ISimpleKeyValueStore) {}

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
			let items: { key: string; value: string | null }[];
			if (this.storage.getItems) {
				items = await this.storage.getItems(storageKeys);
			} else {
				items = await Promise.all(
					storageKeys.map(async (sk) => ({
						key: sk,
						value: await this.storage.getItem(sk),
					})),
				);
			}

			const valueMap = new Map<string, string | null>();
			for (const item of items) {
				valueMap.set(item.key, item.value);
			}

			for (const id of ids) {
				const storageKey = this.getSignalKey(type, id);
				const rawValue = valueMap.get(storageKey);

				if (rawValue !== null && rawValue !== undefined) {
					try {
						const parsedValue = deserializeWithRevival(
							rawValue,
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
						const serializedValue = serializeWithRevival(value);
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
			if (this.storage.setItems) {
				await this.storage.setItems(itemsToSet);
			} else {
				for (const item of itemsToSet) {
					if (item.value === null) {
						await this.storage.removeItem(item.key);
					} else {
						await this.storage.setItem(item.key, item.value);
					}
				}
			}
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
		const userNumber = userId.split("@")[0];
		if (!userNumber) return {};

		const allSessionKeysPrefix = `${SIGNAL_KEY_PREFIX}session:`;
		let allSessionKeys: string[] = [];
		try {
			allSessionKeys = await this.storage.getKeys(allSessionKeysPrefix);
		} catch (err) {
			console.error(
				"[GenericSignalKeyStore] Error getting all session keys:",
				err,
			);
			return {};
		}

		const userSessionKeys = allSessionKeys.filter((key) => {
			const keyBody = key.slice(allSessionKeysPrefix.length);
			const keyUserPart = keyBody.split(".")[0];
			return keyUserPart === userNumber;
		});

		if (!userSessionKeys.length) return {};

		try {
			let rawItems: { key: string; value: string | null }[] = [];
			if (this.storage.getItems) {
				rawItems = await this.storage.getItems(userSessionKeys);
			} else {
				rawItems = await Promise.all(
					userSessionKeys.map(async (sk) => ({
						key: sk,
						value: await this.storage.getItem(sk),
					})),
				);
			}

			const result: {
				[address: string]: SignalDataTypeMap["session"] | undefined;
			} = {};

			for (const { key, value: rawValue } of rawItems) {
				if (rawValue !== null && rawValue !== undefined) {
					try {
						const address = key.slice(allSessionKeysPrefix.length);
						const deserializedValue =
							deserializeWithRevival<SignalDataTypeMap["session"]>(rawValue);

						if (deserializedValue instanceof Uint8Array) {
							result[address] = deserializedValue;
						} else {
							console.error(
								`[GenericSignalKeyStore] Deserialized session for key ${key} is not a Uint8Array:`,
								typeof deserializedValue,
							);
						}
					} catch (err: unknown) {
						const errorMessage =
							err instanceof Error ? err.message : String(err);
						console.error(
							`[GenericSignalKeyStore] Error deserializing session for key ${key}: ${errorMessage}`,
							err,
						);
					}
				}
			}
			return result;
		} catch (err) {
			console.error(
				`[GenericSignalKeyStore] Error getting session items for user ${userId}:`,
				err,
			);
			return {};
		}
	}
}

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
