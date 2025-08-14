import { SenderKeyRecordSchema } from "@wha.ts/signal/groups/schemas";
import { SessionRecordSchema } from "@wha.ts/signal/schemas";
import {
	KeyPairSchema,
	SignedKeyPairSchema,
	ZodUint8Array,
} from "@wha.ts/utils/schemas";
import { z } from "zod/v4";

export const ProcessedMessageKeySchema = z.object({
	chat: z.string(),
	id: z.string(),
});
export type ProcessedMessageKey = z.infer<typeof ProcessedMessageKeySchema>;

export const ADVSignedDeviceIdentitySchema = z.object({
	accountSignature: ZodUint8Array,
	accountSignatureKey: ZodUint8Array,
	details: ZodUint8Array,
	deviceSignature: ZodUint8Array,
});

export const SignalDataTypeMapSchemas = {
	"peer-identity-key": ZodUint8Array,
	"pre-key": KeyPairSchema,
	"sender-key": SenderKeyRecordSchema,
	session: SessionRecordSchema,
	"signed-identity-key": KeyPairSchema,
	"signed-pre-key": SignedKeyPairSchema,
};

export type SignalDataTypeMap = {
	[K in keyof typeof SignalDataTypeMapSchemas]: z.infer<
		(typeof SignalDataTypeMapSchemas)[K]
	>;
};

export type SignalDataSet = {
	[T in keyof SignalDataTypeMap]?: {
		[id: string]: SignalDataTypeMap[T] | null | undefined;
	};
};

export interface ISignalProtocolStore {
	get<T extends keyof SignalDataTypeMap>(
		type: T,
		ids: string[],
	): Promise<{ [id: string]: SignalDataTypeMap[T] | undefined }>;

	set(data: SignalDataSet): Promise<void>;

	getAllSessionsForUser(
		userId: string,
	): Promise<{ [address: string]: SignalDataTypeMap["session"] | undefined }>;
}
