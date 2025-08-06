import type {
	ICollection,
	ISignalProtocolStore,
	IStorageDatabase,
	SignalDataSet,
	SignalDataTypeMap,
} from "@wha.ts/types";
import { SignalDataTypeMapSchemas } from "@wha.ts/types";
import { deserialize, serialize } from "./serialization";

export class GenericSignalKeyStore implements ISignalProtocolStore {
	private preKeyStore: ICollection<string>;
	private sessionStore: ICollection<string>;
	private identityStore: ICollection<string>;
	private signedPreKeyStore: ICollection<string>;
	private senderKeyStore: ICollection<string>;

	constructor(db: IStorageDatabase) {
		this.preKeyStore = db.getCollection<string>("prekey-store");
		this.sessionStore = db.getCollection<string>("session-store");
		this.identityStore = db.getCollection<string>("identity-store");
		this.signedPreKeyStore = db.getCollection<string>("signed-prekey-store");
		this.senderKeyStore = db.getCollection<string>("senderkey-store");
	}

	private getCollectionForType<T extends keyof SignalDataTypeMap>(
		type: T,
	): ICollection<string> {
		switch (type) {
			case "pre-key":
				return this.preKeyStore;
			case "session":
				return this.sessionStore;
			case "signed-identity-key":
			case "peer-identity-key":
				return this.identityStore;
			case "signed-pre-key":
				return this.signedPreKeyStore;
			case "sender-key":
				return this.senderKeyStore;
			default:
				throw new Error(`Unknown SignalDataTypeMap type: ${String(type)}`);
		}
	}

	async get<T extends keyof SignalDataTypeMap>(
		type: T,
		ids: string[],
	): Promise<{ [id: string]: SignalDataTypeMap[T] | undefined }> {
		if (!ids || ids.length === 0) {
			return {};
		}

		const collection = this.getCollectionForType(type);
		const finalResults: { [id: string]: SignalDataTypeMap[T] | undefined } = {};
		const schema = SignalDataTypeMapSchemas[type];

		const promises = ids.map(async (id) => {
			const rawValue = await collection.get(id);
			if (rawValue !== null && rawValue !== undefined) {
				try {
					finalResults[id] = deserialize(
						rawValue,
						schema,
					) as SignalDataTypeMap[T];
				} catch (error) {
					console.error(
						`[GenericSignalKeyStore] Zod validation failed for key '${id}' (type: ${String(
							type,
						)}):`,
						error,
					);
				}
			}
		});
		await Promise.all(promises);
		return finalResults;
	}

	async set(data: SignalDataSet): Promise<void> {
		const promises: Promise<void>[] = [];

		for (const typeStr in data) {
			const type = typeStr as keyof SignalDataTypeMap;
			const dataOfType = data[type];
			if (!dataOfType) continue;

			const collection = this.getCollectionForType(type);

			for (const id in dataOfType) {
				const value = dataOfType[id];

				if (value === null || value === undefined) {
					const result = collection.remove(id);
					promises.push(
						result instanceof Promise ? result : Promise.resolve(result),
					);
				} else {
					try {
						const serializedValue = serialize(value);
						const result = collection.set(id, serializedValue);
						promises.push(
							result instanceof Promise ? result : Promise.resolve(result),
						);
					} catch (error) {
						console.error(
							`[GenericSignalKeyStore] Error serializing value for id '${id}' (type: ${String(
								type,
							)}):`,
							error,
						);
					}
				}
			}
		}
		await Promise.all(promises);
	}

	/**
	 * Retrieves all session data for all devices of a given user.
	 * Returns an array of { address, record } for the user.
	 */
	async getAllSessionsForUser(
		userId: string,
	): Promise<{ [address: string]: SignalDataTypeMap["session"] | undefined }> {
		const userNumber = userId.split("@")[0];
		if (!userNumber) return {};

		const allSessionKeys: string[] = await this.sessionStore.keys();

		const userSessionKeys = allSessionKeys.filter((key) => {
			const keyUserPart = key.split(".")[0];
			return keyUserPart === userNumber;
		});

		if (!userSessionKeys.length) return {};

		const schema = SignalDataTypeMapSchemas.session;
		const result: {
			[address: string]: SignalDataTypeMap["session"] | undefined;
		} = {};

		for (const key of userSessionKeys) {
			const rawValue = await this.sessionStore.get(key);
			if (rawValue !== null && rawValue !== undefined) {
				try {
					const record = deserialize(
						rawValue,
						schema,
					) as SignalDataTypeMap["session"];
					const address = key; // You may want to parse this into ProtocolAddress if available
					result[address] = record;
				} catch (err: unknown) {
					console.error(
						`[GenericSignalKeyStore] Error deserializing session for key '${key}': ${err}`,
						err,
					);
				}
			}
		}
		return result;
	}
}
