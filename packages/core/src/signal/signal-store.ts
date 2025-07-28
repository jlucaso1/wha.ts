import {
	ProtocolAddress,
	SessionRecord,
	type SignalSessionStorage,
} from "@wha.ts/signal";
import type { ChainType } from "@wha.ts/signal/chain_type";
import { deserializeWithRevival } from "@wha.ts/storage/serialization";
import {
	concatBytes,
	KEY_BUNDLE_TYPE,
	type KeyPair,
	type SignedKeyPair,
} from "@wha.ts/utils";
import type { IAuthStateProvider } from "../state/interface";
import type { ILogger } from "../transport/types";

export class SignalProtocolStoreAdapter implements SignalSessionStorage {
	constructor(
		private authState: IAuthStateProvider,
		private logger: ILogger,
	) {}

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
		const preKey = deserializeWithRevival<KeyPair>(result[idStr]);

		if (!preKey) {
			this.logger.warn(`[SignalStore] Pre-key ${idStr} not found!`);
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

		if (!sessionData) {
			return undefined;
		}

		if (sessionData instanceof SessionRecord) {
			return sessionData;
		}

		try {
			const record = SessionRecord.fromJSON(sessionData);
			return record;
		} catch (e) {
			this.logger.error(
				{ err: e, jid: identifier },
				`Failed to instantiate SessionRecord for ${identifier}`,
			);
			return undefined;
		}
	}

	async storeSession(
		identifier: string,
		sessionRecordInstance: SessionRecord,
	): Promise<void> {
		await this.authState.keys.set({
			session: { [identifier]: sessionRecordInstance },
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
					privateKey: keyRecord.keyPair.privateKey,
					publicKey: keyRecord.keyPair.publicKey,
				},
				signature: keyRecord.signature,
			};
			await this.authState.saveCreds();
		} else {
			this.logger.warn(
				`Attempted to store non-current signed pre-key ${keyIdStr}`,
			);
		}
	}

	async loadIdentityKey(identifier: string): Promise<Uint8Array | undefined> {
		const result = await this.authState.keys.get("peer-identity-key", [
			identifier,
		]);
		return result[identifier] as Uint8Array | undefined;
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

	async getAllSessionRecordsForUser(
		userId: string,
	): Promise<{ address: ProtocolAddress; record: SessionRecord }[]> {
		const sessions = await this.authState.keys.getAllSessionsForUser(userId);
		const results: { address: ProtocolAddress; record: SessionRecord }[] = [];
		for (const [addressStr, sessionData] of Object.entries(sessions)) {
			if (!sessionData) continue;
			try {
				const record = SessionRecord.fromJSON(sessionData);

				const protoAddrStr = addressStr.replace(/_([0-9]+)$/, ".$1");
				const address = ProtocolAddress.from(protoAddrStr);
				results.push({ address, record });
			} catch (err) {
				this.logger.error(
					{ err, address: addressStr },
					"Failed to process session record for device",
				);
			}
		}
		return results;
	}
}
