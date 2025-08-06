import type { KeyPair } from "@wha.ts/utils";
import type { z } from "zod/v4";
import type { ChainType } from "./chain_type";
import type { ProtocolAddressSchema, SignalIdentitySchema } from "./schemas";
import type { SessionRecord } from "./session_record";

export interface SignalSessionStorage {
	loadSession(addr: string): Promise<SessionRecord | undefined | null>;
	storeSession(addr: string, record: SessionRecord): Promise<void>;
	getOurIdentity(): Promise<KeyPair>;
	getOurRegistrationId(): Promise<number>;
	isTrustedIdentity(
		identifier: string,
		identityKey: Uint8Array,
		_direction: ChainType,
	): Promise<boolean>;
	removePreKey?(id: number): Promise<void>;
	loadPreKey(keyId: number): Promise<KeyPair | undefined>;
	loadSignedPreKey(keyId: number): Promise<KeyPair | undefined>;
}

export type ProtocolAddress = z.infer<typeof ProtocolAddressSchema>;

export type SignalIdentity = z.infer<typeof SignalIdentitySchema>;
