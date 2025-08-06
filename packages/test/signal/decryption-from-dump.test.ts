import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fromBinary } from "@bufbuild/protobuf";
import { jidDecode } from "@wha.ts/binary";
import { SignalProtocolStoreAdapter } from "@wha.ts/core";
import { MessageSchema } from "@wha.ts/proto";
import { ProtocolAddress, SessionCipher } from "@wha.ts/signal";
import { GroupCipher } from "@wha.ts/signal/groups/cipher";
import { GenericAuthState, InMemoryStorageDatabase } from "@wha.ts/storage";
import type { ICollection } from "@wha.ts/types";
import { base64ToBytes, unpadRandomMax16 } from "@wha.ts/utils";

async function loadDumpedStateIntoMemory(
	dumpPath: string,
): Promise<InMemoryStorageDatabase> {
	const memoryDb = new InMemoryStorageDatabase();
	const collectionNames = await fs.readdir(dumpPath);

	const walkAndLoad = async (
		basePath: string,
		currentPath: string,
		collection: ICollection<string>,
	) => {
		const entries = await fs.readdir(currentPath, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(currentPath, entry.name);
			if (entry.isDirectory()) {
				await walkAndLoad(basePath, fullPath, collection);
			} else if (entry.isFile() && entry.name.endsWith(".json")) {
				const relativePath = path.relative(basePath, fullPath);
				const key = relativePath.slice(0, -5).replace(/[\\/]/g, ":");

				const content = await fs.readFile(fullPath, "utf-8");
				await collection.set(key, content);
			}
		}
	};

	for (const collectionName of collectionNames) {
		const collection = memoryDb.getCollection(collectionName);
		const collectionPath = path.join(dumpPath, collectionName);
		await walkAndLoad(collectionPath, collectionPath, collection);
	}

	return memoryDb;
}

const DUMPS_DIR = "./decryption-dumps";

describe("Offline Decryption from Dumped Bundles", async () => {
	const dumpFolders = await fs.readdir(DUMPS_DIR);

	for (const folderName of dumpFolders) {
		test(`should correctly decrypt bundle: ${folderName}`, async () => {
			const bundlePath = path.join(DUMPS_DIR, folderName);

			const stateDumpPath = path.join(bundlePath, "state_dump");

			const memoryStorage = await loadDumpedStateIntoMemory(stateDumpPath);

			const payload = JSON.parse(
				await fs.readFile(path.join(bundlePath, "payload.json"), "utf-8"),
			);

			const authState = await GenericAuthState.init(memoryStorage);

			const signalStore = new SignalProtocolStoreAdapter(authState, console);
			const decodedJid = jidDecode(payload.from);
			if (!decodedJid || !decodedJid.user) {
				throw new Error(`Invalid JID in payload: ${payload.from}`);
			}
			const senderAddress = new ProtocolAddress(
				decodedJid.user,
				decodedJid.device ?? 0,
			);
			const cipher = new SessionCipher(signalStore, senderAddress);

			const ciphertext = base64ToBytes(payload.ciphertext);
			let plaintext: Uint8Array;
			if (payload.type === "pkmsg") {
				plaintext = await cipher.decryptPreKeyWhisperMessage(ciphertext);
			} else if (payload.type === "msg") {
				plaintext = await cipher.decryptWhisperMessage(ciphertext);
			} else if (payload.type === "skmsg") {
				if (!payload.participant)
					throw new Error("Dumped SKMSG missing participant");
				const senderKeyName = `${payload.from}::${payload.participant}`;
				const cipher = new GroupCipher(authState.keys, senderKeyName);

				// This is still simplified. You'd need to parse the skmsg format properly.
				const rawProtoBytes = ciphertext.slice(1, -8);
				plaintext = await cipher.decrypt(rawProtoBytes);
			} else {
				throw new Error(`Unsupported message type for test: ${payload.type}`);
			}

			expect(plaintext).toBeDefined();
			expect(plaintext.length).toBeGreaterThan(0);

			const unpaddedPlaintext = unpadRandomMax16(plaintext);

			const message = fromBinary(MessageSchema, unpaddedPlaintext);

			expect(message).toBeDefined();

			console.log(`✅ Successfully decrypted ${folderName}`);
		});
	}
});
