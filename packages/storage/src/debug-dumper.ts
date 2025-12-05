import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BinaryNode } from "@wha.ts/binary";
import { bytesToBase64 } from "@wha.ts/utils";
import { z } from "zod/v4";
import type { FileSystemStorageDatabase } from "./fs";
import { replacer, serialize } from "./serialization";

export async function dumpDecryptionData(
	dumpDir: string,
	node: BinaryNode,
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
				ciphertext: bytesToBase64(encNode.content),
				from: node.attrs.from,
				messageId: node.attrs.id,
				participant: node.attrs.participant,
				timestamp: new Date().toISOString(),
				type: encNode.attrs.type,
			};
			await fs.writeFile(
				path.join(bundleDir, "payload.json"),
				JSON.stringify(payload, replacer, 2),
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

export const DumpedAppStateSchema = z.object({
	collectionName: z.string(),
	node: z.any(),
	timestamp: z.string(),
	version: z.string(),
});

type DumpedAppState = z.infer<typeof DumpedAppStateSchema>;

export async function dumpAppStateSyncData(
	dumpDir: string,
	node: BinaryNode,
): Promise<void> {
	if (node.tag !== "iq" || node.attrs.type !== "result") {
		return;
	}

	const syncNode = getBinaryNodeChild(node, "sync");
	if (!syncNode) return;

	const collectionNode = getBinaryNodeChild(syncNode, "collection");
	if (!collectionNode) return;

	const version = collectionNode.attrs.version || "initial";
	const collectionName = collectionNode.attrs.name;

	if (!collectionName) return;

	const timestamp = Date.now();
	const bundleDir = path.join(dumpDir, "appstate-sync-dumps");

	try {
		await fs.mkdir(bundleDir, { recursive: true });

		const fileName = `${timestamp}-${collectionName}-v${version}.json`;
		const filePath = path.join(bundleDir, fileName);

		const payload: DumpedAppState = {
			collectionName,
			node: node,
			timestamp: new Date().toISOString(),
			version,
		};

		await fs.writeFile(filePath, serialize(payload), "utf-8");

		console.log(
			`[AppStateDumper] Successfully saved AppState sync bundle to: ${filePath}`,
		);
	} catch (error) {
		console.error(
			"[AppStateDumper] Failed to save AppState sync bundle:",
			error,
		);
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
