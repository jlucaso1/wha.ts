import { ZodBigInt, ZodUint8Array } from "@wha.ts/utils/schemas";
import { z } from "zod/v4";

export const AppStateSyncKeyFingerprintSchema = z.object({
	currentIndex: z.number().optional(),
	deviceIndexes: z.record(z.string(), ZodUint8Array).optional(),
	rawId: z.number().optional(),
});

export const AppStateSyncKeyDataSchema = z.object({
	fingerprint: AppStateSyncKeyFingerprintSchema.optional(),
	keyData: ZodUint8Array.optional(),
	timestamp: ZodBigInt.optional(),
});

export type AppStateSyncKeyData = z.infer<typeof AppStateSyncKeyDataSchema>;
