export {
	bytesToHex,
	bytesToUtf8,
	concatBytes,
	equalBytes,
	utf8ToBytes,
} from "@noble/ciphers/utils";

export const bytesToBase64 = (bytes: Uint8Array): string => {
	return btoa(String.fromCharCode(...bytes));
};

export const base64ToBytes = (base64: string): Uint8Array => {
	return new Uint8Array([...atob(base64)].map((c) => c.charCodeAt(0)));
};
