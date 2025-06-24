export {
	bytesToHex,
	bytesToUtf8,
	concatBytes,
	equalBytes,
	utf8ToBytes,
	hexToBytes,
} from "@noble/ciphers/utils";

export const bytesToBase64 = (bytes: Uint8Array): string => {
	return btoa(String.fromCharCode(...bytes));
};

export const base64ToBytes = (base64: string): Uint8Array => {
	return new Uint8Array([...atob(base64)].map((c) => c.charCodeAt(0)));
};

export const unpadRandomMax16 = (e: Uint8Array) => {
	const t = new Uint8Array(e);
	if (0 === t.length) {
		throw new Error("unpadPkcs7 given empty bytes");
	}

	const r = t[t.length - 1];

	if (r === undefined) {
		throw new Error("unpadPkcs7 given undefined bytes");
	}

	if (r > t.length) {
		throw new Error(`unpad given ${t.length} bytes, but pad is ${r}`);
	}

	return new Uint8Array(t.buffer, t.byteOffset, t.length - r);
};

export const padRandomMax16 = (data: Uint8Array): Uint8Array => {
	const paddingBytes = 16 - (data.length % 16);
	const padded = new Uint8Array(data.length + paddingBytes);
	padded.set(data);
	padded.fill(paddingBytes, data.length);
	return padded;
};

export const isBytes = (value: unknown): value is Uint8Array => {
	if (value instanceof Uint8Array) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.every((v) => typeof v === "number");
	}
	if (typeof value === "string") {
		try {
			const decoded = atob(value);
			return (
				decoded.length % 4 === 0 &&
				decoded.split("").every((c) => c.charCodeAt(0) < 256)
			);
		} catch {
			return false;
		}
	}
	return false;
};
