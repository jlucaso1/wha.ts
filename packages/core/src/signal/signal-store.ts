import { SessionRecord } from "@wha.ts/signal/src";
import type { ChainType } from "@wha.ts/signal/src/chain_type";
import {
	bytesToUtf8,
	concatBytes,
	utf8ToBytes,
} from "@wha.ts/utils/src/bytes-utils";
import { KEY_BUNDLE_TYPE } from "@wha.ts/utils/src/curve";
import { BufferJSON } from "@wha.ts/utils/src/serializer";
import type { KeyPair } from "@wha.ts/utils/src/types";
import type { IAuthStateProvider, SignedKeyPair } from "../state/interface";

export class SignalProtocolStoreAdapter {
	private logger = console;
	constructor(private authState: IAuthStateProvider) {}

	async getIdentityKeyPair(): Promise<KeyPair> {
		return {
			privateKey: this.authState.creds.signedIdentityKey.privateKey,
			publicKey: this.authState.creds.signedIdentityKey.publicKey,
		};
	}

	async getLocalRegistrationId(): Promise<number> {
		return this.authState.creds.registrationId;
	}

	async isTrustedIdentity(
		identifier: string,
		identityKey: Uint8Array,
		_direction: ChainType,
	): Promise<boolean> {
		if (!identifier) {
			throw new Error("Got empty identifier");
		}

		const trusted = await this.loadIdentityKey(identifier);
		if (!trusted) {
			return true;
		}
		return identityKey instanceof Uint8Array && trusted instanceof Uint8Array
			? identityKey.length === trusted.length &&
					identityKey.every((v, i) => v === trusted[i])
			: false;
	}

	async loadPreKey(keyId: number | string): Promise<KeyPair | undefined> {
		const idStr = keyId.toString();
		const result = await this.authState.keys.get("pre-key", [idStr]);
		const preKey = result[idStr];
		if (!preKey) {
			console.warn(`[SignalStore] Pre-key ${idStr} not found!`);
			return undefined;
		}
		// this.logger.trace(
		// 	{ preKey, idStr },
		// 	`[SignalStore] Found pre-key ${idStr}`,
		// );
		return {
			privateKey: preKey.privateKey,
			publicKey: preKey.publicKey,
		};
	}

	async storePreKey(keyId: number | string, keyPair: KeyPair): Promise<void> {
		const idStr = keyId.toString();
		await this.authState.keys.set({
			"pre-key": {
				[idStr]: {
					privateKey: keyPair.privateKey,
					publicKey: keyPair.publicKey,
				},
			},
		});
	}

	async removePreKey(keyId: number | string): Promise<void> {
		const idStr = keyId.toString();
		await this.authState.keys.set({ "pre-key": { [idStr]: null } });
	}

	async loadSession(identifier: string): Promise<SessionRecord | undefined> {
		const result = await this.authState.keys.get("session", [identifier]);
		const sessionData = result[identifier];

		// this.logger.trace(
		// 	`Loading session for ${identifier}. Stored type: ${sessionData?.constructor?.name}`,
		// 	sessionData instanceof Uint8Array ? `Length: ${sessionData.length}` : "",
		// );

		if (sessionData instanceof Uint8Array) {
			try {
				const jsonString = bytesToUtf8(sessionData);
				const plainObject = JSON.parse(jsonString, BufferJSON.reviver);

				const recordInstance = SessionRecord.deserialize(plainObject);
				this.logger.trace(
					`Deserialized session for ${identifier} successfully`,
				);
				return recordInstance;
			} catch (e: any) {
				this.logger.error(
					{ err: e, jid: identifier },
					`Failed to parse/deserialize session JSON for ${identifier}`,
				);
				return undefined;
			}
		} else if (sessionData) {
			this.logger.warn(
				`[SignalStore] Session for ${identifier} was not stored as Uint8Array, attempting deserialization.`,
			);
			try {
				return SessionRecord.deserialize(sessionData as any);
			} catch (e: any) {
				this.logger.error(
					{ err: e, jid: identifier },
					`Failed to deserialize non-Uint8Array session for ${identifier}`,
				);
				return undefined;
			}
		}
		return undefined;
	}

	async storeSession(
		identifier: string,
		sessionRecordInstance: SessionRecord,
	): Promise<void> {
		// this.logger.trace(
		// 	`Storing session for ${identifier}. Received SessionRecord instance.`,
		// );

		let sessionDataToStore: Uint8Array;

		try {
			const plainObject = sessionRecordInstance.serialize();
			const jsonString = JSON.stringify(plainObject, BufferJSON.replacer);
			sessionDataToStore = utf8ToBytes(jsonString);
			// this.logger.trace(
			// 	`Storing session object for ${identifier} as JSON string, length: ${sessionDataToStore.length}`,
			// );
		} catch (e: any) {
			this.logger.error(
				{ err: e, jid: identifier },
				`Failed to serialize session object for ${identifier}`,
			);
			throw new Error("Failed to serialize session object");
		}

		await this.authState.keys.set({
			session: { [identifier]: sessionDataToStore },
		});
	}

	async storeSignedPreKey(
		keyId: number | string,
		keyRecord: SignedKeyPair,
	): Promise<void> {
		const keyIdStr = keyId.toString();
		if (this.authState.creds.signedPreKey.keyId.toString() === keyIdStr) {
			this.authState.creds.signedPreKey = {
				keyId: keyRecord.keyId,
				keyPair: {
					privateKey: new Uint8Array(keyRecord.keyPair.privateKey),
					publicKey: new Uint8Array(keyRecord.keyPair.publicKey),
				},
				signature: new Uint8Array(keyRecord.signature),
			};
			await this.authState.saveCreds();
		} else {
			console.warn(`Attempted to store non-current signed pre-key ${keyIdStr}`);
		}
	}

	async removeSignedPreKey(keyId: number | string): Promise<void> {
		const keyIdStr = keyId.toString();
		console.warn(
			`Removal of signed pre-key ${keyIdStr} requested but not implemented`,
		);
	}

	async loadIdentityKey(identifier: string): Promise<Uint8Array | undefined> {
		const result = await this.authState.keys.get("peer-identity-key" as any, [
			identifier,
		]);
		const key = result[identifier] as Uint8Array | undefined;
		return key ? key : undefined;
	}

	async storeIdentityKey(
		identifier: string,
		identityKey: Uint8Array,
	): Promise<void> {
		await this.authState.keys.set({
			"peer-identity-key": { [identifier]: identityKey },
		} as any);
	}

	async saveIdentity(
		identifier: string,
		identityKey: Uint8Array,
	): Promise<boolean> {
		const existing = await this.loadIdentityKey(identifier);

		if (!existing) {
			await this.storeIdentityKey(identifier, identityKey);
			return true;
		}

		if (
			!(
				existing.length === identityKey.length &&
				existing.every((v, i) => v === identityKey[i])
			)
		) {
			console.warn(`Identity key mismatch for ${identifier}. Overwriting.`);
			await this.storeIdentityKey(identifier, identityKey);
			return true;
		}

		return false;
	}

	async loadSenderKey(senderKeyName: string): Promise<any> {
		const result = await this.authState.keys.get("sender-key" as any, [
			senderKeyName,
		]);
		const record = result[senderKeyName];
		if (record) {
			return record;
		}
		return undefined;
	}

	async storeSenderKey(senderKeyName: string, keyRecord: any): Promise<void> {
		const serialized = keyRecord;
		await this.authState.keys.set({
			"sender-key": { [senderKeyName]: serialized },
		} as any);
	}

	async getOurIdentity(): Promise<KeyPair> {
		const { privateKey, publicKey } = this.authState.creds.signedIdentityKey;
		const prefixedPubKey = concatBytes(KEY_BUNDLE_TYPE, publicKey);
		return {
			privateKey: privateKey,
			publicKey: prefixedPubKey,
		};
	}

	async loadSignedPreKey(
		keyId: number | string,
	): Promise<SignedKeyPair["keyPair"] | undefined> {
		const keyIdStr = keyId.toString();
		const storedKey = this.authState.creds.signedPreKey;

		if (storedKey && storedKey.keyId.toString() === keyIdStr) {
			return {
				privateKey: storedKey.keyPair.privateKey,
				publicKey: storedKey.keyPair.publicKey,
			};
		}

		return undefined;
	}
}
