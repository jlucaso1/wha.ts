// HKDF Standalone Test for Noise Protocol

import { describe, expect, it } from "bun:test";
import { hkdf } from "./crypto";

// Helper to convert hex string to Uint8Array
function hexToBytes(hex: string): Uint8Array {
	const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
	const matches = cleanHex.match(/.{1,2}/g);
	if (!matches) return new Uint8Array();
	return new Uint8Array(matches.map((byte) => Number.parseInt(byte, 16)));
}

// Helper to convert Uint8Array to hex string
function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

describe("HKDF Standalone Test", () => {
	it("should match the expected client output", () => {
		const inputKeyMaterial = hexToBytes(
			"9551a0c91a9844475e9a165d5fcfff987f4ef0dd98f53fb1edc9676b24171e26",
		);
		const salt = hexToBytes(
			"4e6f6973655f58585f32353531395f41455347434d5f53484132353600000000",
		);
		const info = "";
		const outputLen = 64;

		const output = hkdf(inputKeyMaterial, outputLen, { salt, info });

		const expectedSaltAfter =
			"80e77ec30d23005db64103da1f843a791428204e6d9981f06b75225244076323";
		const expectedCipherKey =
			"ca40f3f22ca8a3dff4728bf1f4db7b4435ab9b55d3efa885510baa0c7b746006";

		const saltAfter = output.subarray(0, 32);
		const cipherKey = output.subarray(32);

		console.log("salt(after):", bytesToHex(saltAfter));
		console.log("cipherKey :", bytesToHex(cipherKey));

		expect(bytesToHex(saltAfter)).toBe(expectedSaltAfter);
		expect(bytesToHex(cipherKey)).toBe(expectedCipherKey);
	});
});
