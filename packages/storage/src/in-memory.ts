import type { ICollection, IStorageDatabase } from "./types";

export class InMemoryCollection<TValue = string>
	implements ICollection<TValue>
{
	private store = new Map<string, TValue>();

	async get(key: string): Promise<TValue | null> {
		const value = this.store.get(key);
		return value === undefined ? null : value;
	}

	async set(key: string, value: TValue | null): Promise<void> {
		if (value === null) {
			this.store.delete(key);
		} else {
			this.store.set(key, value);
		}
	}

	async remove(key: string): Promise<void> {
		this.store.delete(key);
	}

	async keys(prefix?: string): Promise<string[]> {
		const allKeys = Array.from(this.store.keys());
		if (prefix) {
			return allKeys.filter((k) => k.startsWith(prefix));
		}
		return allKeys;
	}

	async clear(prefix?: string): Promise<void> {
		if (prefix) {
			const keysToRemove = await this.keys(prefix);
			for (const k of keysToRemove) {
				this.store.delete(k);
			}
		} else {
			this.store.clear();
		}
	}
}

export class InMemoryStorageDatabase implements IStorageDatabase {
	private collections = new Map<string, InMemoryCollection<any>>();

	getCollection<TValue = string>(name: string): ICollection<TValue> {
		if (!this.collections.has(name)) {
			this.collections.set(name, new InMemoryCollection<TValue>());
		}
		return this.collections.get(name) as InMemoryCollection<TValue>;
	}
}
