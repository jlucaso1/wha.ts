import type { ISimpleKeyValueStore } from "./types";

export class InMemorySimpleKeyValueStore implements ISimpleKeyValueStore {
	private store = new Map<string, unknown>();

	async getItem<T = unknown>(key: string): Promise<T | null> {
		const value = this.store.get(key);
		return value === undefined ? null : (value as T);
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

	async getItems<T = unknown>(
		keys: string[],
	): Promise<{ key: string; value: T | null }[]> {
		return Promise.all(
			keys.map(async (key) => ({ key, value: await this.getItem<T>(key) })),
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
