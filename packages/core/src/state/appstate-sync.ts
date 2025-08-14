import { fromBinary } from "@bufbuild/protobuf";
import type { BinaryNode } from "@wha.ts/binary";
import { getBinaryNodeChild, S_WHATSAPP_NET } from "@wha.ts/binary";
import {
	SyncActionValue_PushNameSettingSchema,
	SyncdMutation_SyncdOperation,
} from "@wha.ts/proto";
import type { ICollection, IPlugin } from "@wha.ts/types";
import type { WhaTSClient } from "../client";
import { iterateAppStateMutations } from "./appstate-helpers";

async function getAppStateVersion(
	collection: ICollection<string>,
	name: string,
): Promise<number> {
	const versionStr = await collection.get(`app-state-version:${name}`);
	return versionStr ? parseInt(versionStr, 10) : 0;
}

async function setAppStateVersion(
	collection: ICollection<string>,
	name: string,
	version: number,
): Promise<void> {
	await collection.set(`app-state-version:${name}`, version.toString());
}

async function fetchAppStatePatches<
	_TStorage,
	TPlugins extends readonly IPlugin[],
>(
	client: WhaTSClient<_TStorage, TPlugins>,
	name: string,
	version: number,
	isFullSync: boolean,
): Promise<BinaryNode> {
	const attrs: { [key: string]: string } = {
		name,
		return_snapshot: String(isFullSync),
	};

	if (!isFullSync) {
		attrs.version = String(version);
	}

	const collectionNode: BinaryNode = {
		attrs,
		tag: "collection",
	};

	const syncNode: BinaryNode = {
		attrs: {},
		content: [collectionNode],
		tag: "sync",
	};

	const iq: BinaryNode = {
		attrs: {
			to: S_WHATSAPP_NET,
			type: "set",
			xmlns: "w:sync:app:state",
		},
		content: [syncNode],
		tag: "iq",
	};

	return client.sendIQ(iq);
}

export async function appStateSync<
	_TStorage,
	TPlugins extends readonly IPlugin[],
>(client: WhaTSClient<_TStorage, TPlugins>, name: string, fullSync: boolean) {
	client.logger.info(
		`Starting AppState sync for '${name}' (full_sync: ${fullSync})`,
	);

	const db = client.auth.db;
	if (!db) {
		client.logger.error(
			"Auth provider does not have a 'db' property for app state sync.",
		);
		return;
	}
	const appStateCollection = db.getCollection("app-state");
	let currentVersion = await getAppStateVersion(appStateCollection, name);

	if (fullSync) {
		currentVersion = 0;
	}

	let hasMore = true;
	let isFirstSync = fullSync;

	while (hasMore) {
		const respNode = await fetchAppStatePatches(
			client,
			name,
			currentVersion,
			isFirstSync,
		);
		isFirstSync = false;

		const syncNode = getBinaryNodeChild(respNode, "sync");
		const collectionNode = getBinaryNodeChild(syncNode, "collection");

		if (collectionNode) {
			hasMore = collectionNode.attrs.has_more_patches === "true";

			if (collectionNode.attrs.version) {
				currentVersion = parseInt(collectionNode.attrs.version, 10);
			}

			const mutationIterator = iterateAppStateMutations(collectionNode, client);

			let iteratorResult = await mutationIterator.next();

			while (!iteratorResult.done) {
				const { mutation, index } = iteratorResult.value;
				console.log("Decoded Mutation:", index);

				// Here is the specific logic for this context (finding pushName)
				if (
					index.startsWith("setting_pushName") &&
					mutation.operation === SyncdMutation_SyncdOperation.SET &&
					mutation.record?.value?.blob
				) {
					const pushNameSetting = fromBinary(
						SyncActionValue_PushNameSettingSchema,
						mutation.record.value.blob,
					);
					if (pushNameSetting.name) {
						const oldName = client.auth.creds.me?.name;
						if (oldName !== pushNameSetting.name) {
							client.logger.info(
								`Received push name '${pushNameSetting.name}' via app state sync, updating store.`,
							);
							if (client.auth.creds.me) {
								client.auth.creds.me.name = pushNameSetting.name;
								await client.auth.saveCreds();
							}
						}
						// We found what we need, but we let the iterator finish to get the final version.
					}
				}

				iteratorResult = await mutationIterator.next();
			}

			const { maxVersion: patchMaxVersion } = iteratorResult.value;
			currentVersion = Math.max(currentVersion, patchMaxVersion);

			await setAppStateVersion(appStateCollection, name, currentVersion);
		} else {
			hasMore = false;
		}
	}
	client.logger.info(`Finished AppState sync for '${name}'`);
}
