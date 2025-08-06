import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BinaryNode } from "@wha.ts/binary";
import type { AuthenticationCreds } from "@wha.ts/core";
import { bytesToBase64 } from "@wha.ts/utils";
import type { FileSystemStorageDatabase } from "./fs";

export async function dumpDecryptionData(
	dumpDir: string,
	node: BinaryNode,
	_creds: AuthenticationCreds,
	storage: FileSystemStorageDatabase,
): Promise<void> {
	const timestamp = Date.now();
	const messageId = node.attrs.id || "unknown-id";
	const bundleDir = path.join(dumpDir, `${timestamp}-${messageId}`);

	try {
		await fs.mkdir(bundleDir, { recursive: true });

		const encNode = getBinaryNodeChild(node, "enc");
		if (encNode?.content instanceof Uint8Array) {
			const payload = {
				timestamp: new Date().toISOString(),
				messageId: node.attrs.id,
				participant: node.attrs.participant,
				from: node.attrs.from,
				type: encNode.attrs.type,
				ciphertext: bytesToBase64(encNode.content),
			};
			await fs.writeFile(
				path.join(bundleDir, "payload.json"),
				JSON.stringify(payload, null, 2),
				"utf-8",
			);
		}

		const stateDumpDir = path.join(bundleDir, "state_dump");
		await fs.cp(storage.baseDir, stateDumpDir, { recursive: true });

		console.log(
			`[DecryptionDumper] Successfully saved test bundle to: ${bundleDir}`,
		);
	} catch (error) {
		console.error("[DecryptionDumper] Failed to save test bundle:", error);
	}
}

function getBinaryNodeChild(
	node: BinaryNode | undefined,
	childTag: string,
): BinaryNode | undefined {
	if (node && Array.isArray(node.content)) {
		return node.content.find((item) => item.tag === childTag);
	}
	return undefined;
}
