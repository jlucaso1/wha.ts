import { base64ToBytes, bytesToBase64 } from "./bytes-utils";

const UINT8_ARRAY_TAG_UTIL = "__IS_UINT8ARRAY_UTIL__";
const BIGINT_TAG_UTIL = "__IS_BIGINT_UTIL__";

function replacerUtil(_key: string, value: any): any {
	if (value instanceof Uint8Array) {
		return { __tag: UINT8_ARRAY_TAG_UTIL, data: bytesToBase64(value) };
	}
	if (typeof value === "bigint") {
		return { __tag: BIGINT_TAG_UTIL, data: value.toString() };
	}
	return value;
}

function reviverUtil(_key: string, value: any): any {
	if (
		typeof value === "object" &&
		value !== null &&
		typeof value.__tag === "string"
	) {
		if (
			value.__tag === UINT8_ARRAY_TAG_UTIL &&
			typeof value.data === "string"
		) {
			return base64ToBytes(value.data);
		}
		if (value.__tag === BIGINT_TAG_UTIL && typeof value.data === "string") {
			return BigInt(value.data);
		}
	}
	return value;
}

export function serializer(data: any): string {
	return JSON.stringify(data, replacerUtil);
}

export function deserializer<T = any>(jsonString: string): T {
	return JSON.parse(jsonString, reviverUtil);
}
