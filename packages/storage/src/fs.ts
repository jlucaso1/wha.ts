import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ICollection, IStorageDatabase } from "@wha.ts/types";

function isNodeError(error: unknown): error is ErrnoException {
	return error instanceof Error && "code" in error;
}

export class FileSystemCollection implements ICollection<string> {
	private collectionDirectory: string;

	constructor(basePath: string, collectionName: string) {
		this.collectionDirectory = path.resolve(basePath, collectionName);

		fs.mkdir(this.collectionDirectory, { recursive: true }).catch((err) => {
			console.error(
				`[FileSystemCollection] Failed to create directory ${this.collectionDirectory}:`,
				err,
			);
		});
	}

	private sanitizeSegment(segment: string): string {
		return segment.replace(/[^a-zA-Z0-9.\-_]/g, "_");
	}

	private keyToRelativeFilePath(key: string): string {
		const parts = key.split(":");
		if (parts.length === 1) {
			return `${this.sanitizeSegment(parts[0] ?? "")}.json`;
		}
		const dirParts = parts.slice(0, -1).map(this.sanitizeSegment);
		const fileName = `${this.sanitizeSegment(
			parts[parts.length - 1] ?? "",
		)}.json`;
		return path.join(...dirParts, fileName);
	}

	private getFullFilePath(key: string): string {
		return path.join(this.collectionDirectory, this.keyToRelativeFilePath(key));
	}

	async get(key: string): Promise<string | null> {
		const filePath = this.getFullFilePath(key);
		try {
			const data = await fs.readFile(filePath, "utf-8");
			return data || null;
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") {
				return null;
			}
			console.error(
				`[FileSystemCollection.get] Error reading key "${key}" from ${filePath}:`,
				error,
			);
			throw error;
		}
	}

	async set(key: string, value: string | null): Promise<void> {
		const filePath = this.getFullFilePath(key);
		try {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			if (value === null) {
				return await this.remove(key);
			}
			await fs.writeFile(filePath, value, "utf-8");
		} catch (error) {
			console.error(
				`[FileSystemCollection.set] Error writing key "${key}" to ${filePath}:`,
				error,
			);
			throw error;
		}
	}

	async remove(key: string): Promise<void> {
		const filePath = this.getFullFilePath(key);
		try {
			await fs.unlink(filePath);
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") {
				return;
			}
			console.error(
				`[FileSystemCollection.remove] Error removing key "${key}" from ${filePath}:`,
				error,
			);
			throw error;
		}
	}

	async keys(prefix?: string): Promise<string[]> {
		const allFilePaths: string[] = [];
		const filesToScan: string[] = [this.collectionDirectory];

		while (filesToScan.length > 0) {
			const currentScanDir = filesToScan.pop();
			if (!currentScanDir) break;

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
			} catch (error) {
				if (isNodeError(error) && error.code === "ENOENT") {
					return [];
				}
				console.error(
					`[FileSystemCollection.keys] Error scanning directory ${currentScanDir}:`,
					error,
				);
			}
		}

		const keys = allFilePaths
			.map((fullPath) => {
				const relPath = path.relative(this.collectionDirectory, fullPath);
				if (!relPath.endsWith(".json")) return null;
				const noExtension = relPath.slice(0, -5);
				return noExtension.split(path.sep).join(":");
			})
			.filter((k) => k !== null) as string[];

		if (prefix) {
			return keys.filter((k) => k.startsWith(prefix));
		}
		return keys;
	}

	async clear(prefix?: string): Promise<void> {
		const keysToRemove = await this.keys(prefix);
		await Promise.all(keysToRemove.map((key) => this.remove(key)));
	}
}

export class FileSystemStorageDatabase implements IStorageDatabase {
	baseDir: string;
	private collections = new Map<string, FileSystemCollection>();

	constructor(directoryPath: string) {
		this.baseDir = path.resolve(directoryPath);

		fs.mkdir(this.baseDir, { recursive: true }).catch((err) => {
			console.error(
				`[FileSystemStorageDatabase] Failed to create base directory ${this.baseDir}:`,
				err,
			);
		});
	}

	getCollection<TValue = string>(name: string): ICollection<TValue> {
		if (!this.collections.has(name)) {
			this.collections.set(name, new FileSystemCollection(this.baseDir, name));
		}
		return this.collections.get(name) as ICollection<TValue>;
	}
}
