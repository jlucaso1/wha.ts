import type { SenderKeyDistributionMessage } from "@wha.ts/proto";
import type { ISignalProtocolStore } from "@wha.ts/types";
import type { SenderKeyState } from "./schemas";

const MAX_SENDER_KEY_STATES = 5;

export class GroupSessionBuilder {
	constructor(private store: ISignalProtocolStore) {}

	async process(
		senderKeyName: string, // "groupId::senderJid"
		message: SenderKeyDistributionMessage,
	): Promise<void> {
		const result = await this.store.get("sender-key", [senderKeyName]);
		const record = result[senderKeyName] ?? { senderKeyStates: [] };

		const newKeyState: SenderKeyState = {
			senderChainKey: {
				iteration: message.iteration,
				seed: message.chainKey,
			},
			senderKeyId: message.id,
			senderMessageKeys: [],
			senderSigningKey: {
				public: message.signingKey,
			},
		};

		// Add the new state to the front and manage the record size
		record.senderKeyStates.unshift(newKeyState);
		if (record.senderKeyStates.length > MAX_SENDER_KEY_STATES) {
			record.senderKeyStates.length = MAX_SENDER_KEY_STATES;
		}

		await this.store.set({ "sender-key": { [senderKeyName]: record } });
		console.log(
			`[GroupBuilder] Processed and stored sender key for ${senderKeyName}`,
		);
	}
}
