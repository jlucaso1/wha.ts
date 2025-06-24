export interface ISimpleKeyValueStore {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
	removeItem(key: string): Promise<void>;
	getKeys(prefix?: string): Promise<string[]>;
	clear(prefix?: string): Promise<void>;
	getItems?(keys: string[]): Promise<{ key: string; value: string | null }[]>;
	setItems?(items: { key: string; value: string | null }[]): Promise<void>;
}
