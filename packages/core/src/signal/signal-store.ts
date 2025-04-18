import { SessionRecord, type SignalSessionStorage } from "@wha.ts/signal/src";
import type { ChainType } from "@wha.ts/signal/src/chain_type";
import {
	bytesToUtf8,
	concatBytes,
	utf8ToBytes,
} from "@wha.ts/utils/src/bytes-utils";
import { KEY_BUNDLE_TYPE } from "@wha.ts/utils/src/curve";
import { deserializer, serializer } from "@wha.ts/utils/src/serializer";
import type { KeyPair, SignedKeyPair } from "@wha.ts/utils/src/types";
import type { IAuthStateProvider } from "../state/interface";

export class SignalProtocolStoreAdapter implements SignalSessionStorage {
	private logger = console;
	constructor(private authState: IAuthStateProvider) {}

	async getOurRegistrationId(): Promise<number> {
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

	async loadPreKey(keyId: number): Promise<KeyPair | undefined> {
		const idStr = keyId.toString();
		const result = await this.authState.keys.get("pre-key", [idStr]);
		const preKey = result[idStr];
		if (!preKey) {
			console.warn(`[SignalStore] Pre-key ${idStr} not found!`);
			return undefined;
		}
		return {
			privateKey: preKey.privateKey,
			publicKey: preKey.publicKey,
		};
	}

	async removePreKey(keyId: number): Promise<void> {
		const idStr = keyId.toString();
		await this.authState.keys.set({ "pre-key": { [idStr]: null } });
	}

	async loadSession(identifier: string): Promise<SessionRecord | undefined> {
		const result = await this.authState.keys.get("session", [identifier]);
		const sessionData = result[identifier];

		if (sessionData instanceof Uint8Array) {
			try {
				const jsonString = bytesToUtf8(sessionData);
				const plainObject = deserializer(jsonString);

				const recordInstance = SessionRecord.deserialize(plainObject);

				return recordInstance;
			} catch (e) {
				this.logger.error(
					{ err: e, jid: identifier },
					`Failed to parse/deserialize session JSON for ${identifier}`,
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
		const plainObject = sessionRecordInstance.serialize();
		const jsonString = serializer(plainObject);
		const sessionDataToStore = utf8ToBytes(jsonString);
		await this.authState.keys.set({
			session: { [identifier]: sessionDataToStore },
		});
	}

	async storeSignedPreKey(
		keyId: number,
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

	async loadIdentityKey(identifier: string): Promise<Uint8Array | undefined> {
		const result = await this.authState.keys.get("peer-identity-key", [
			identifier,
		]);
		const key = result[identifier] as Uint8Array | undefined;
		return key ? key : undefined;
	}

	async getOurIdentity(): Promise<KeyPair> {
		const { privateKey, publicKey } = this.authState.creds.signedIdentityKey;
		const prefixedPubKey = concatBytes(KEY_BUNDLE_TYPE, publicKey);
		return {
			privateKey: privateKey,
			publicKey: prefixedPubKey,
		};
	}

	async loadSignedPreKey(keyId: number): Promise<KeyPair | undefined> {
		const storedKey = this.authState.creds.signedPreKey;

		if (storedKey.keyId === keyId) {
			return {
				privateKey: storedKey.keyPair.privateKey,
				publicKey: storedKey.keyPair.publicKey,
			};
		}

		return undefined;
	}
}
