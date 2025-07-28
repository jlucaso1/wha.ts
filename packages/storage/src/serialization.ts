import { base64ToBytes, bytesToBase64 } from "@wha.ts/utils";

const UINT8_ARRAY_TAG = "__IS_UINT8ARRAY__";
const BIGINT_TAG = "__IS_BIGINT__";

function replacer(_key: string, value: any): any {
	if (value instanceof Uint8Array) {
		return { __tag: UINT8_ARRAY_TAG, data: bytesToBase64(value) };
	}
	if (typeof value === "bigint") {
		return { __tag: BIGINT_TAG, data: value.toString() };
	}
	return value;
}

function reviver(_key: string, value: any): any {
	if (
		typeof value === "object" &&
		value !== null &&
		typeof value.__tag === "string"
	) {
		switch (value.__tag) {
			case UINT8_ARRAY_TAG:
				if (typeof value.data === "string") {
					return base64ToBytes(value.data);
				}
				break;
			case BIGINT_TAG:
				if (typeof value.data === "string") {
					return BigInt(value.data);
				}
				break;
		}
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
