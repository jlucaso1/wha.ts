import type { AuthenticationCreds } from "@wha.ts/core";
import { base64ToBytes, type SignalIdentity } from "@wha.ts/utils";
import { z } from "zod";
import { BaseKeyType } from "./base_key_type";
import { ChainType } from "./chain_type";
import { SessionRecord } from "./session_record";

export const ZodUint8Array = z.preprocess((val) => {
	if (typeof val === "string") return base64ToBytes(val);
	return val;
}, z.instanceof(Uint8Array));

export const ZodBigInt = z.preprocess((val) => {
	if (typeof val === "string" || typeof val === "number") return BigInt(val);
	return val;
}, z.bigint());

export const KeyPairSchema = z.object({
	publicKey: ZodUint8Array,
	privateKey: ZodUint8Array,
});

export const SignedKeyPairSchema = z.object({
	keyPair: KeyPairSchema,
	signature: ZodUint8Array,
	keyId: z.number(),
});

const SignalIdentitySchema: z.ZodType<SignalIdentity> = z.object({
	identifier: z.object({
		name: z.string(),
		deviceId: z.number(),
	}),
	identifierKey: ZodUint8Array,
});

export const AuthenticationCredsSchema: z.ZodType<AuthenticationCreds> =
	z.object({
		noiseKey: KeyPairSchema,
		pairingEphemeralKeyPair: KeyPairSchema,
		signedIdentityKey: KeyPairSchema,
		signedPreKey: SignedKeyPairSchema,
		registrationId: z.number(),
		advSecretKey: ZodUint8Array,
		me: z
			.object({
				id: z.string(),
				name: z.string().optional(),
			})
			.optional(),
		// The `account` field holds a protobuf-generated object.
		// Using z.any() is the most robust way to handle this without creating a brittle Zod schema
		// that needs to be updated every time the proto definition changes.
		account: z.any().optional(),
		platform: z.string().optional(),
		signalIdentities: z.array(SignalIdentitySchema).optional(),
		nextPreKeyId: z.number(),
		firstUnuploadedPreKeyId: z.number(),
		myAppStateKeyId: z.string().optional(),
		accountSyncCounter: z.number(),
		accountSettings: z.object({
			unarchiveChats: z.boolean(),
		}),
		registered: z.boolean(),
		pairingCode: z.string().optional(),
		routingInfo: ZodUint8Array.optional(),
	});

export const ChainKeySchema = z.object({
	counter: z.number(),
	key: ZodUint8Array.nullable(),
});

export const ChainSchema = z.object({
	chainKey: ChainKeySchema,
	chainType: z.enum(ChainType),
	messageKeys: z.record(z.string(), ZodUint8Array),
});

export const IndexInfoSchema = z.object({
	baseKey: ZodUint8Array,
	baseKeyType: z.enum(BaseKeyType),
	closed: ZodBigInt,
	used: ZodBigInt,
	created: ZodBigInt,
	remoteIdentityKey: ZodUint8Array,
});

export const PendingPreKeySchema = z.object({
	signedKeyId: z.number(),
	baseKey: ZodUint8Array,
	preKeyId: z.number().optional(),
});

export const SessionEntrySchema = z.object({
	registrationId: z.number().optional(),
	currentRatchet: z.object({
		ephemeralKeyPair: KeyPairSchema,
		lastRemoteEphemeralKey: ZodUint8Array,
		previousCounter: z.number(),
		rootKey: ZodUint8Array,
	}),
	indexInfo: IndexInfoSchema,
	pendingPreKey: PendingPreKeySchema.optional(),
	chains: z.record(z.string(), ChainSchema),
});

const PlainSessionRecordSchema = z.object({
	sessions: z.record(z.string(), SessionEntrySchema),
	version: z.string().default("v3-zod"),
});

export const SessionRecordSchema = PlainSessionRecordSchema.transform((plain) =>
	SessionRecord.fromPlainObject(plain),
);

export type ISessionRecord = z.infer<typeof SessionRecordSchema>;
