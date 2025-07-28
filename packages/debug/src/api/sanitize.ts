import { bytesToBase64 } from "@wha.ts/utils";

/**
 * A type representing all values that can be safely serialized to JSON.
 */
export type JsonSerializable =
	| string
	| number
	| boolean
	| null
	| JsonSerializable[]
	| { [key: string]: JsonSerializable };

/**
 * Recursively sanitizes an object for JSON output:
 * - Converts Uint8Array to base64 strings.
 * - Converts BigInt to strings.
 * - Handles arrays, objects, and Maps.
 * - Removes functions, symbols, and undefined.
 */
export function sanitizeObjectForJSON(obj: unknown): JsonSerializable {
	if (obj instanceof Uint8Array) {
		return bytesToBase64(obj);
	}
	if (typeof obj === "bigint") {
		return obj.toString();
	}
	if (typeof obj !== "object" || obj === null) {
		// This covers primitives (string, number, boolean, null)
		// and filters out undefined, function, symbol by returning null.
		return typeof obj === "string" ||
			typeof obj === "number" ||
			typeof obj === "boolean"
			? obj
			: null;
	}
	// If obj is a plain object with no keys, return an explicit cast to satisfy TS
	if (
		Object.prototype.toString.call(obj) === "[object Object]" &&
		Object.keys(obj).length === 0
	) {
		return {} as { [key: string]: JsonSerializable };
	}
	if (Array.isArray(obj)) {
		return obj.map(sanitizeObjectForJSON);
	}
	if (obj instanceof Map) {
		const newMap: Record<string, JsonSerializable> = {};
		for (const [key, value] of obj.entries()) {
			newMap[String(key)] = sanitizeObjectForJSON(value);
		}
		return newMap;
	}
	const sanitized: { [key: string]: JsonSerializable } = {};
	for (const key in obj) {
		if (Object.hasOwn(obj, key)) {
			sanitized[key] = sanitizeObjectForJSON(
				(obj as Record<string, unknown>)[key],
			);
		}
	}
	// Explicitly cast empty object to JsonSerializable to satisfy TypeScript
	return Object.keys(sanitized).length === 0
		? ({} as { [key: string]: JsonSerializable })
		: sanitized;
}
