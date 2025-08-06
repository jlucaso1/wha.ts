import { fromBinary } from "@bufbuild/protobuf";
import { SenderKeyMessageSchema } from "@wha.ts/proto";
import type { ISignalProtocolStore } from "@wha.ts/types";
import { aesDecrypt, hkdf, hmacSign } from "@wha.ts/utils";
import type { SenderKeyRecord, SenderKeyState } from "./schemas";

const KDF_INFO = "WhisperGroup";
const MESSAGE_KEY_SEED = new Uint8Array([0x01]);
const CHAIN_KEY_SEED = new Uint8Array([0x02]);
const MAX_MESSAGE_KEYS = 2000;

export class GroupCipher {
	constructor(
		private store: ISignalProtocolStore,
		private senderKeyName: string,
	) {}

	async decrypt(senderKeyMessageBytes: Uint8Array): Promise<Uint8Array> {
		const result = await this.store.get("sender-key", [this.senderKeyName]);
		const record = result[this.senderKeyName];
		if (!record) {
			throw new Error(
				`[GroupCipher] No sender key record for ${this.senderKeyName}`,
			);
		}

		const message = fromBinary(SenderKeyMessageSchema, senderKeyMessageBytes);
		const state = this.getSenderKeyState(record, message.id);
		if (!state) {
			throw new Error(`[GroupCipher] No state for key ID ${message.id}`);
		}

		// The signature is not part of the SenderKeyMessage proto.
		// The calling context needs to handle signature verification.

		const senderKey = this.getSenderKey(state, message.iteration);

		if (!senderKey) {
			throw new Error(
				`[GroupCipher] No sender key for iteration ${message.iteration}`,
			);
		}

		const { iv, cipherKey } = this.deriveMessageKeys(senderKey.seed);

		const plaintext = aesDecrypt(cipherKey, message.ciphertext, iv);

		// Update the record with the new state (consumed keys, advanced ratchet)
		await this.store.set({ "sender-key": { [this.senderKeyName]: record } });

		return plaintext;
	}

	private getSenderKeyState(
		record: SenderKeyRecord,
		keyId: number,
	): SenderKeyState {
		const state = record.senderKeyStates.find((s) => s.senderKeyId === keyId);
		if (!state)
			throw new Error(`Could not find sender key state for keyId ${keyId}`);
		return state;
	}

	private getSenderKey(state: SenderKeyState, iteration: number) {
		const chainKey = state.senderChainKey;
		if (chainKey.iteration > iteration) {
			const keyIndex = state.senderMessageKeys.findIndex(
				(k) => k.iteration === iteration,
			);
			if (keyIndex > -1) {
				const [key] = state.senderMessageKeys.splice(keyIndex, 1);
				return key;
			}
			throw new Error(
				`Key from old counter ${iteration} not found (current: ${chainKey.iteration})`,
			);
		}

		if (iteration - chainKey.iteration > MAX_MESSAGE_KEYS) {
			throw new Error("Message key too far in the future");
		}

		while (chainKey.iteration < iteration) {
			const messageKey = this.getSenderMessageKey(chainKey);
			state.senderMessageKeys.push(messageKey);

			const nextSeed = hmacSign(chainKey.seed, CHAIN_KEY_SEED);
			chainKey.iteration += 1;
			chainKey.seed = nextSeed;
		}

		const resultKey = this.getSenderMessageKey(chainKey);
		const nextSeed = hmacSign(chainKey.seed, CHAIN_KEY_SEED);
		chainKey.iteration += 1;
		chainKey.seed = nextSeed;

		return resultKey;
	}

	private getSenderMessageKey(chainKey: SenderKeyState["senderChainKey"]) {
		const seed = hmacSign(chainKey.seed, MESSAGE_KEY_SEED);
		return { iteration: chainKey.iteration, seed };
	}

	private deriveMessageKeys(seed: Uint8Array) {
		// The Rust code derived 48 bytes, but AES-CBC only needs 32 for key + 16 for IV
		const derived = hkdf(seed, 48, { info: KDF_INFO });
		return {
			iv: derived.slice(0, 16),
			cipherKey: derived.slice(16, 48), // Assuming AES-256-CBC
		};
	}
}
