import type { BinaryNode } from "@wha.ts/binary";
import { getBinaryNodeChild, S_WHATSAPP_NET } from "@wha.ts/binary";
import type { IAuthStateProvider } from "@wha.ts/types";
import type { TypedCustomEvent } from "@wha.ts/types/generics/typed-event-target";
import type { ILogger } from "@wha.ts/types/transport";
import {
	encodeBigEndian,
	generatePreKeys,
	KEY_BUNDLE_TYPE,
	type KeyPair,
	type SignedKeyPair,
} from "@wha.ts/utils";
import type { ConnectionManager } from "./core/connection";

export const MIN_PREKEY_COUNT = 10;
export const PREKEY_UPLOAD_BATCH_SIZE = 30;

const formatPreKeyForXMPP = (keyPair: KeyPair, id: number): BinaryNode => ({
	attrs: {},
	content: [
		{ attrs: {}, content: encodeBigEndian(id, 3), tag: "id" },
		{ attrs: {}, content: keyPair.publicKey, tag: "value" },
	],
	tag: "key",
});

const formatSignedPreKeyForXMPP = (
	signedKeyPair: SignedKeyPair,
): BinaryNode => ({
	attrs: {},
	content: [
		{ attrs: {}, content: encodeBigEndian(signedKeyPair.keyId, 3), tag: "id" },
		{ attrs: {}, content: signedKeyPair.keyPair.publicKey, tag: "value" },
		{ attrs: {}, content: signedKeyPair.signature, tag: "signature" },
	],
	tag: "skey",
});

export class PreKeyManager {
	private epoch = 0;

	constructor(
		private auth: IAuthStateProvider,
		private logger: ILogger,
		private connectionManager: ConnectionManager,
	) {}

	public async checkAndUploadPreKeys(): Promise<void> {
		try {
			const count = await this.getServerPreKeyCount();
			this.logger.info({ count }, "Server pre-key count");
			if (count <= MIN_PREKEY_COUNT) {
				this.logger.info(
					{ count, threshold: MIN_PREKEY_COUNT },
					"Low pre-key count, uploading more.",
				);
				await this.uploadPreKeys();
			}
		} catch (err) {
			this.logger.error({ err }, "Failed to check/upload pre-keys");
		}
	}

	private async getServerPreKeyCount(): Promise<number> {
		const msgId = this.generateTag();
		const iq: BinaryNode = {
			attrs: {
				id: msgId,
				to: S_WHATSAPP_NET,
				type: "get",
				xmlns: "encrypt",
			},
			content: [{ attrs: {}, tag: "count" }],
			tag: "iq",
		};

		await this.connectionManager.sendNode(iq);
		const response = await this.waitForRequest(msgId);
		const countNode = getBinaryNodeChild(response, "count");
		const count = parseInt(countNode?.attrs.value || "0", 10);
		return count;
	}

	private async uploadPreKeys(): Promise<void> {
		const { creds } = this.auth;
		const newPreKeys = generatePreKeys(
			creds.nextPreKeyId,
			PREKEY_UPLOAD_BATCH_SIZE,
		);
		const newPreKeysArray = Object.values(newPreKeys);

		this.logger.info(`Uploading ${newPreKeysArray.length} pre-keys...`);

		const preKeyNodes = Object.entries(newPreKeys).map(([id, keyPair]) =>
			formatPreKeyForXMPP(keyPair, Number(id)),
		);
		const signedPreKeyNode = formatSignedPreKeyForXMPP(creds.signedPreKey);

		const msgId = this.generateTag();
		const iq: BinaryNode = {
			attrs: {
				id: msgId,
				to: S_WHATSAPP_NET,
				type: "set",
				xmlns: "encrypt",
			},
			content: [
				{
					attrs: {},
					content: encodeBigEndian(creds.registrationId),
					tag: "registration",
				},
				{ attrs: {}, content: KEY_BUNDLE_TYPE, tag: "type" },
				{
					attrs: {},
					content: creds.signedIdentityKey.publicKey,
					tag: "identity",
				},
				{ attrs: {}, content: preKeyNodes, tag: "list" },
				signedPreKeyNode,
			],
			tag: "iq",
		};

		await this.connectionManager.sendNode(iq);
		await this.waitForRequest(msgId);

		await this.auth.keys.set({ "pre-key": newPreKeys });
		creds.nextPreKeyId += newPreKeysArray.length;
		await this.auth.saveCreds();

		this.logger.info(
			`Successfully uploaded ${newPreKeysArray.length} pre-keys. Next pre-key ID is ${creds.nextPreKeyId}.`,
		);
	}

	private waitForRequest(
		reqId: string,
		timeoutMs = 15000,
	): Promise<BinaryNode> {
		return new Promise<BinaryNode>((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				cleanup();
				reject(
					new Error(
						`Timeout waiting for response to request ${reqId} after ${timeoutMs}ms`,
					),
				);
			}, timeoutMs);

			const listener = (event: TypedCustomEvent<{ node: BinaryNode }>) => {
				const responseNode = event.detail.node;
				if (responseNode.tag === "iq" && responseNode.attrs.id === reqId) {
					cleanup();
					if (responseNode.attrs.type === "error") {
						reject(
							new Error(`Request ${reqId} failed with an error response.`),
						);
					} else {
						resolve(responseNode);
					}
				}
			};

			const cleanup = () => {
				clearTimeout(timeoutId);
				this.connectionManager.removeEventListener(
					"node.received",
					listener as EventListener,
				);
			};

			this.connectionManager.addEventListener(
				"node.received",
				listener as EventListener,
			);
		});
	}

	private generateTag(): string {
		return `${Date.now()}.${this.epoch++}`;
	}
}
