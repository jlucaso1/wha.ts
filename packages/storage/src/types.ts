type StorageValue = null | string;
type MaybePromise<T> = T | Promise<T>;

export interface ISimpleKeyValueStore {
	getItem(key: string): MaybePromise<StorageValue>;
	setItem(key: string, value: string | null): MaybePromise<void>;
	removeItem(key: string): MaybePromise<void>;
	getKeys(prefix?: string): MaybePromise<string[]>;
	clear(prefix?: string): MaybePromise<void>;
	getItems?(
		keys: string[],
	): MaybePromise<{ key: string; value: StorageValue }[]>;
	setItems?(items: { key: string; value: string | null }[]): MaybePromise<void>;
}
