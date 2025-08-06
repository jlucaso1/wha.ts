import { bytesToBase64 } from "@wha.ts/utils";
import type z from "zod";
import type { ZodType } from "zod";

function replacer(_key: string, value: unknown): unknown {
	if (value instanceof Uint8Array) {
		return bytesToBase64(value);
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	return value;
}

export function serialize(data: unknown): string {
	return JSON.stringify(data, replacer);
}

export function deserialize<T extends ZodType>(
	jsonString: string | null | undefined,
	schema: T,
): z.infer<T> | undefined {
	if (jsonString === null || jsonString === undefined) {
		return undefined;
	}

	try {
		const data = JSON.parse(jsonString);
		return schema.parse(data);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		console.error(
			`[Serialization] Failed to deserialize or validate data: ${errorMessage}`,
		);
		throw new Error(
			`Data validation failed: ${errorMessage} ${schema._zod.toJSONSchema?.()} ${jsonString}`,
		);
	}
}
