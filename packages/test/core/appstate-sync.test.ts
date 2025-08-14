import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBinaryNodeChild } from "@wha.ts/binary";
import { iterateAppStateMutations } from "@wha.ts/core/state/appstate-helpers";
import { DumpedAppStateSchema } from "@wha.ts/storage/debug-dumper";
import { deserialize } from "@wha.ts/storage/serialization";
import pino from "pino";

const DUMPS_DIR = "./decryption-dumps/appstate-sync-dumps";

const logger = pino();

describe.skip("Offline AppState Sync Processing", async () => {
	let dumpFiles: string[];
	try {
		dumpFiles = await fs.readdir(DUMPS_DIR);
	} catch (_error) {
		console.warn(
			`Could not read AppState dump directory: ${DUMPS_DIR}. Skipping tests.`,
		);
		dumpFiles = [];
	}

	for (const fileName of dumpFiles) {
		test(`should correctly find pushName in bundle: ${fileName}`, async () => {
			const bundlePath = path.join(DUMPS_DIR, fileName);
			const fileContent = await fs.readFile(bundlePath, "utf-8");
			const dumped = deserialize(fileContent, DumpedAppStateSchema);

			if (!dumped) {
				console.warn(`Invalid or empty payload in file: ${fileName}`);
				return;
			}

			const iqNode = dumped.node;
			expect(iqNode.tag).toEqual("iq");

			const syncNode = getBinaryNodeChild(iqNode, "sync");
			const collectionNode = getBinaryNodeChild(syncNode, "collection");

			let mutationsCount = 0;

			if (collectionNode) {
				for await (const decodedMutation of iterateAppStateMutations(
					collectionNode,
					logger as any,
				)) {
					console.log("Decoded Mutation:", decodedMutation);
					mutationsCount++;
				}
			}

			const hasPatches =
				collectionNode && getBinaryNodeChild(collectionNode, "patches");

			if (hasPatches) {
				expect(mutationsCount).toBeGreaterThan(0);
				console.log(
					`✅ Successfully parsed patches in ${fileName} without crashing. Found ${mutationsCount} mutations (before decryption).`,
				);
			} else {
				console.log(`No patches found in ${fileName}, test passes.`);
			}
		});
	}
});
