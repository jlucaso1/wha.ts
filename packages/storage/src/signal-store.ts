import type {
	ISignalProtocolStore,
	SignalDataSet,
	SignalDataTypeMap,
} from "@wha.ts/core/src/state/interface";
import { base64ToBytes, bytesToBase64 } from "@wha.ts/utils/src/bytes-utils";
import { SIGNAL_KEY_PREFIX } from "./constants";
import { deserializeWithRevival, serializeWithRevival } from "./serialization";
import type { ISimpleKeyValueStore } from "./types";

export class GenericSignalKeyStore implements ISignalProtocolStore {
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
						let parsedValue: SignalDataTypeMap[T];
						if (type === "session") {
							// Session is stored as base64-encoded Uint8Array
							parsedValue = base64ToBytes(rawValue) as SignalDataTypeMap[T];
						} else {
							parsedValue = deserializeWithRevival(
								rawValue,
							) as SignalDataTypeMap[T];
						}
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
						let serializedValue: string;
						if (type === "session" && value instanceof Uint8Array) {
							// Store session as base64 string
							serializedValue = bytesToBase64(value);
						} else {
							serializedValue = serializeWithRevival(value);
						}
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
						const deserializedValue = Uint8Array.from(atob(rawValue), (c) =>
							c.charCodeAt(0),
						);

						result[address] = deserializedValue;
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
