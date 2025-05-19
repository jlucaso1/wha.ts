import { base64ToBytes, bytesToBase64 } from "@wha.ts/utils";

export const UINT8_ARRAY_TAG = "__IS_UINT8ARRAY__";
export const BIGINT_TAG = "__IS_BIGINT__";

export function replacer(_key: string, value: any): any {
	if (value instanceof Uint8Array) {
		return { __tag: UINT8_ARRAY_TAG, data: bytesToBase64(value) };
	}
	if (typeof value === "bigint") {
		return { __tag: BIGINT_TAG, data: value.toString() };
	}
	return value;
}

export function reviver(_key: string, value: any): any {
	if (
		typeof value === "object" &&
		value !== null &&
		typeof value.__tag === "string"
	) {
		if (value.__tag === UINT8_ARRAY_TAG && typeof value.data === "string") {
			return base64ToBytes(value.data);
		}
		if (value.__tag === BIGINT_TAG && typeof value.data === "string") {
			return BigInt(value.data);
		}
	}
	if (
		Array.isArray(value) &&
		value.length === 2 &&
		value[0] === "Uint8Array" &&
		Array.isArray(value[1]) &&
		value[1].every((item: any) => typeof item === "number")
	) {
		return new Uint8Array(value[1]);
	}
	return value;
}

export function serializeWithRevival(data: any): string {
	return JSON.stringify(data, replacer);
}

export function deserializeWithRevival<T = any>(
	input: string | Record<string, any> | Array<any> | null | undefined,
): T {
	if (typeof input === "string") {
		return JSON.parse(input, reviver);
	}
	if (input == null) {
		return input as T;
	}
	return JSON.parse(JSON.stringify(input), reviver);
}
