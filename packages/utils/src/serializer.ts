import { base64ToBytes, bytesToBase64 } from "./bytes-utils";

export const BufferJSON = {
	replacer: (_k: string, value: any) => {
		if (value instanceof Uint8Array || value?.type === "Buffer") {
			return {
				type: "Buffer",
				data: bytesToBase64(value?.data || value),
			};
		}

		if (typeof value === "bigint") {
			return {
				type: "BigInt",
				data: value.toString(),
			};
		}

		return value;
	},

	reviver: (_k: string, value: any) => {
		if (
			typeof value === "object" &&
			!!value &&
			(value.buffer === true || value.type === "Buffer")
		) {
			const val = value.data || value.value;
			return typeof val === "string"
				? base64ToBytes(val)
				: new Uint8Array(val || []);
		}

		if (typeof value === "object" && !!value && value.type === "BigInt") {
			return BigInt(value.data);
		}

		return value;
	},
};
