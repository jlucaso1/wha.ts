import { fromBinary } from "@bufbuild/protobuf";
import type { BinaryNode } from "@wha.ts/binary";
import { getBinaryNodeChild, getBinaryNodeChildren } from "@wha.ts/binary";
import {
	SyncActionDataSchema,
	type SyncdMutation,
	SyncdPatchSchema,
} from "@wha.ts/proto";
import { deserialize } from "@wha.ts/storage/serialization";
import { aesDecrypt, bytesToUtf8, hmacSign, utf8ToBytes } from "@wha.ts/utils";
import type { WhaTSClient } from "../client";
import { getMutationKeys } from "./appstate-keys";
import { AppStateSyncKeyDataSchema } from "./schemas";

export interface DecodedMutation {
	mutation: SyncdMutation;
	index: string;
}

export interface AppStateIterationResult {
	maxVersion: number;
}

async function getAppStateKey(
	client: WhaTSClient<any, any>,
	keyId: Uint8Array,
): Promise<Uint8Array | undefined> {
	const keyIdB64 = Buffer.from(keyId).toString("base64");
	const keyStore = client.auth.db?.getCollection("app-state-keys");
	if (!keyStore) {
		client.logger.warn("app-state-keys collection not found in the database");
		return undefined;
	}

	const keyDataJson = await keyStore.get(keyIdB64);
	if (keyDataJson) {
		const keyData = deserialize(keyDataJson, AppStateSyncKeyDataSchema);
		return keyData?.keyData;
	}

	return undefined;
}

export async function* iterateAppStateMutations(
	collectionNode: BinaryNode,
	client: WhaTSClient<any, any>,
) {
	let maxVersion = 0;

	const patchesNode = getBinaryNodeChild(collectionNode, "patches");
	if (!patchesNode) {
		return { maxVersion };
	}

	const patchChildren = getBinaryNodeChildren(patchesNode, "patch");

	for (const patchChild of patchChildren) {
		let patchContent: Uint8Array;
		if (typeof patchChild.content !== "string") {
			patchContent = new Uint8Array(Object.values(patchChild.content as any));
		} else {
			patchContent = utf8ToBytes(patchChild.content);
		}

		try {
			const patch = fromBinary(SyncdPatchSchema, patchContent);

			if (patch.version?.version) {
				const patchVersion = Number(patch.version.version);
				if (patchVersion > maxVersion) {
					maxVersion = patchVersion;
				}
			}

			if (!patch.keyId?.id) {
				client.logger.warn("Patch missing keyId, skipping");
				continue;
			}

			const keyData = await getAppStateKey(client, patch.keyId.id);

			if (!keyData) {
				client.logger.warn(`No key data found for keyId: ${patch.keyId.id}`);
				continue;
			}

			const { indexKey, valueEncryptionKey } = getMutationKeys(keyData);

			for (const mutation of patch.mutations) {
				if (mutation.record?.index?.blob && mutation.record.value) {
					const valueBlob = mutation.record.value.blob;
					const encryptedPayload = valueBlob.slice(0, -32);

					const iv = encryptedPayload.slice(0, 16);
					const ciphertext = encryptedPayload.slice(16);

					const decrypted = aesDecrypt(ciphertext, valueEncryptionKey, iv); // Make sure your aesDecrypt uses CBC
					const syncActionData = fromBinary(SyncActionDataSchema, decrypted);

					const calculatedIndexHmac = hmacSign(syncActionData.index, indexKey);
					if (
						Buffer.compare(calculatedIndexHmac, mutation.record.index.blob) !==
						0
					) {
						client.logger.error("Index HMAC verification failed");
						continue;
					}

					if (syncActionData.index) {
						const indexString = bytesToUtf8(syncActionData.index);
						const finalIndex = JSON.parse(indexString);

						yield {
							index: finalIndex,
							mutation,
						};
					}
				}
			}
		} catch (err) {
			client.logger.error(
				{ err },
				"Failed to decode a SyncdPatch during iteration",
			);
		}
	}

	return { maxVersion };
}
