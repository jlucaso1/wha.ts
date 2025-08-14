import { hkdf } from "@wha.ts/utils";

export function getMutationKeys(keyData: Uint8Array) {
	const expanded = hkdf(keyData, 160, { info: "WhatsApp Mutation Keys" });
	return {
		indexKey: expanded.slice(0, 32),
		patchMacKey: expanded.slice(128, 160),
		snapshotMacKey: expanded.slice(96, 128),
		valueEncryptionKey: expanded.slice(32, 64),
		valueMacKey: expanded.slice(64, 96),
	};
}
