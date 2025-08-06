import type { BinaryNode } from "@wha.ts/binary";
import { SenderKeyRecordSchema } from "@wha.ts/signal/groups/schemas";
import { SessionRecordSchema } from "@wha.ts/signal/schemas";
import {
	KeyPairSchema,
	SignedKeyPairSchema,
	ZodUint8Array,
} from "@wha.ts/utils/schemas";
import { z } from "zod/v4";

export const ProcessedMessageKeySchema = z.object({
	id: z.string(),
	chat: z.string(),
});
export type ProcessedMessageKey = z.infer<typeof ProcessedMessageKeySchema>;

export const ADVSignedDeviceIdentitySchema = z.object({
	details: ZodUint8Array,
	accountSignatureKey: ZodUint8Array,
	accountSignature: ZodUint8Array,
	deviceSignature: ZodUint8Array,
});

export const AuthenticationCredsSchema = z.object({
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
	account: ADVSignedDeviceIdentitySchema.optional(),
	platform: z.string().optional(),
	signalIdentities: z
		.array(
			z.object({
				identifier: z.object({
					name: z.string(),
					deviceId: z.number(),
				}),
				identifierKey: ZodUint8Array,
			}),
		)
		.optional(),
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
	processedMessages: z.array(ProcessedMessageKeySchema).optional().default([]),
});

export type AuthenticationCreds = z.infer<typeof AuthenticationCredsSchema>;

export const SignalDataTypeMapSchemas = {
	"pre-key": KeyPairSchema,
	session: SessionRecordSchema,
	"signed-identity-key": KeyPairSchema,
	"signed-pre-key": SignedKeyPairSchema,
	"peer-identity-key": ZodUint8Array,
	"sender-key": SenderKeyRecordSchema,
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

export interface IAuthStateProvider {
	creds: AuthenticationCreds;
	keys: ISignalProtocolStore;
	saveCreds(): Promise<void>;
}

export type MaybePromise<T> = T | Promise<T>;

export interface ICollection<TValue = string> {
	get(key: string): MaybePromise<TValue | null>;
	set(key: string, value: TValue | null): MaybePromise<void>;
	remove(key: string): MaybePromise<void>;
	keys(prefix?: string): MaybePromise<string[]>;
	clear(prefix?: string): MaybePromise<void>;
}

export interface IStorageDatabase {
	getCollection<TValue = string>(name: string): ICollection<TValue>;
}

export type DecryptionDumper<TStorage> = (
	dumpDir: string,
	node: BinaryNode,
	creds: AuthenticationCreds,
	storage: TStorage,
) => void | Promise<void>;

export {
	generateMdTagPrefix,
	generatePreKeys,
	generateRegistrationId,
	initAuthCreds,
} from "./utils";
