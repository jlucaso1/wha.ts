import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ISimpleKeyValueStore } from "./types";

export class FileSystemSimpleKeyValueStore implements ISimpleKeyValueStore {
	private baseDir: string;

	constructor(directoryPath: string) {
		this.baseDir = path.resolve(directoryPath);
		console.log(
			`[FileSystemSimpleKeyValueStore] Instance CREATED. Base directory: ${this.baseDir}`,
		);
		import("node:fs/promises").then((fsModule) => {
			fsModule.mkdir(this.baseDir, { recursive: true }).catch((err) => {
				console.error(
					`[FileSystemSimpleKeyValueStore] Failed to create base directory ${this.baseDir}:`,
					err,
				);
				throw err;
			});
		});
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
			return data ? data : null;
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

	async setItem(key: string, value: string | null): Promise<void> {
		const filePath = this.getFullFilePath(key);
		try {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			if (value === null) {
				return await this.removeItem(key);
			}
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
