export type MaybePromise<T> = T | Promise<T>;

export interface ICollection<TValue = string> {
	get(key: string): MaybePromise<TValue | null>;
	set(key: string, value: TValue | null): MaybePromise<void>;
	remove(key: string): MaybePromise<void>;
	keys(prefix?: string): MaybePromise<string[]>;
	clear(prefix?: string): MaybePromise<void>;
}

export interface IStorageDatabase {
	getCollection<TValue = string>(name: string): ICollection<TValue>;
}
