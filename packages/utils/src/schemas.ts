import { z } from "zod/v4";
import { base64ToBytes } from "./bytes-utils";

export const ZodUint8Array = z.preprocess(
	(val) => {
		if (typeof val === "string") return base64ToBytes(val);
		return val;
	},
	z.instanceof(Uint8Array<ArrayBufferLike>),
);

export const ZodBigInt = z.preprocess((val) => {
	if (typeof val === "string" || typeof val === "number") return BigInt(val);
	return val;
}, z.bigint());

export const KeyPairSchema = z.object({
	privateKey: ZodUint8Array,
	publicKey: ZodUint8Array,
});

export const SignedKeyPairSchema = z.object({
	keyId: z.number(),
	keyPair: KeyPairSchema,
	signature: ZodUint8Array,
});

export const SignalIdentitySchema = z.object({
	identifier: z.object({
		deviceId: z.number(),
		name: z.string(),
	}),
	identifierKey: ZodUint8Array,
});
