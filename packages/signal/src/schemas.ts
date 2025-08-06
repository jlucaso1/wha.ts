import { ZodUint8Array } from "@wha.ts/utils/schemas";
import { z } from "zod/v4";
import { BaseKeyType } from "./base_key_type";
import { ChainType } from "./chain_type";
import { SessionRecord } from "./session_record";

export const ZodBigInt = z.preprocess((val) => {
	if (typeof val === "string" || typeof val === "number") return BigInt(val);
	return val;
}, z.bigint());

export const KeyPairSchema = z.object({
	publicKey: ZodUint8Array,
	privateKey: ZodUint8Array,
});

export const ProtocolAddressSchema = z.object({
	name: z.string(),
	deviceId: z.number(),
});

export const SignalIdentitySchema = z.object({
	identifier: ProtocolAddressSchema,
	identifierKey: ZodUint8Array,
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
