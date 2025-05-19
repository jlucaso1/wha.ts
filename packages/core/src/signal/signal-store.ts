import { SessionRecord, type SignalSessionStorage } from "@wha.ts/signal/src";
import type { ChainType } from "@wha.ts/signal/src/chain_type";
import { concatBytes } from "@wha.ts/utils/src/bytes-utils";
import { KEY_BUNDLE_TYPE } from "@wha.ts/utils/src/curve";
import type { KeyPair, SignedKeyPair } from "@wha.ts/utils/src/types";
import type { IAuthStateProvider } from "../state/interface";

import { ProtocolAddress } from "@wha.ts/signal/src/protocol_address";

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
		return preKey;
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
				return SessionRecord.deserialize(sessionData);
			} catch (e) {
				this.logger.error(
					{ err: e, jid: identifier },
					`Failed to deserialize session for ${identifier}`,
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
		const sessionDataToStore = sessionRecordInstance.serialize();
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
	/**
	 * Retrieves all session records for all devices of a given user.
	 * Returns an array of { address: ProtocolAddress, record: SessionRecord }
	 */
	async getAllSessionRecordsForUser(
		userId: string,
	): Promise<{ address: ProtocolAddress; record: SessionRecord }[]> {
		const sessions = await this.authState.keys.getAllSessionsForUser(userId);
		const results: { address: ProtocolAddress; record: SessionRecord }[] = [];
		for (const [addressStr, sessionData] of Object.entries(sessions)) {
			if (!sessionData) continue;
			try {
				const record = SessionRecord.deserialize(sessionData as Uint8Array);
				const protoAddrStr = addressStr.replace(/_([0-9]+)$/, ".$1");
				const address = ProtocolAddress.from(protoAddrStr);
				results.push({ address, record });
			} catch (err) {
				this.logger.error(
					{ err, address: addressStr },
					"Failed to deserialize session record for device",
				);
			}
		}
		return results;
	}
}
