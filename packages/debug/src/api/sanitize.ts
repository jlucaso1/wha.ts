import { bytesToBase64 } from "../../../utils/src/bytes-utils";

/**
 * Recursively sanitizes an object for JSON output:
 * - Converts Uint8Array to base64 strings.
 * - Handles arrays, objects, and Maps.
 */
export function sanitizeObjectForJSON(obj: any): any {
	if (obj instanceof Uint8Array) {
		return bytesToBase64(obj);
	}
	if (typeof obj !== "object" || obj === null) {
		return obj;
	}
	if (Array.isArray(obj)) {
		return obj.map(sanitizeObjectForJSON);
	}
	if (obj instanceof Map) {
		const newMap: Record<string, any> = {};
		for (const [key, value] of obj.entries()) {
			newMap[String(key)] = sanitizeObjectForJSON(value);
		}
		return newMap;
	}
	const sanitized: { [key: string]: any } = {};
	for (const key in obj) {
		if (Object.prototype.hasOwnProperty.call(obj, key)) {
			sanitized[key] = sanitizeObjectForJSON(obj[key]);
		}
	}
	return sanitized;
}
