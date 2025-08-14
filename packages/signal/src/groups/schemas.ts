import { ZodUint8Array } from "@wha.ts/utils/schemas";
import { z } from "zod/v4";

export const SenderChainKeySchema = z.object({
	iteration: z.number(),
	seed: ZodUint8Array,
});

export const SenderMessageKeySchema = z.object({
	iteration: z.number(),
	seed: ZodUint8Array,
});

export const SenderSigningKeySchema = z.object({
	private: ZodUint8Array.optional(),
	public: ZodUint8Array,
});

export const SenderKeyStateSchema = z.object({
	senderChainKey: SenderChainKeySchema,
	senderKeyId: z.number(),
	senderMessageKeys: z.array(SenderMessageKeySchema).default([]),
	senderSigningKey: SenderSigningKeySchema,
});
export type SenderKeyState = z.infer<typeof SenderKeyStateSchema>;

export const SenderKeyRecordSchema = z.object({
	senderKeyStates: z.array(SenderKeyStateSchema).default([]),
});
export type SenderKeyRecord = z.infer<typeof SenderKeyRecordSchema>;
