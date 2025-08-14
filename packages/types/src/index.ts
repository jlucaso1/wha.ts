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

export const AuthenticationCredsSchema = z.object({
	account: ADVSignedDeviceIdentitySchema.optional(),
	accountSettings: z.object({
		unarchiveChats: z.boolean(),
	}),
	accountSyncCounter: z.number(),
	advSecretKey: ZodUint8Array,
	firstUnuploadedPreKeyId: z.number(),
	me: z
		.object({
			id: z.string(),
			lid: z.string().optional(),
			name: z.string().optional(),
		})
		.optional(),
	myAppStateKeyId: z.string().optional(),
	nextPreKeyId: z.number(),
	noiseKey: KeyPairSchema,
	pairingCode: z.string().optional(),
	pairingEphemeralKeyPair: KeyPairSchema,
	platform: z.string().optional(),
	processedMessages: z.array(ProcessedMessageKeySchema).optional().default([]),
	registered: z.boolean(),
	registrationId: z.number(),
	routingInfo: ZodUint8Array.optional(),
	signalIdentities: z
		.array(
			z.object({
				identifier: z.object({
					deviceId: z.number(),
					name: z.string(),
				}),
				identifierKey: ZodUint8Array,
			}),
		)
		.optional(),
	signedIdentityKey: KeyPairSchema,
	signedPreKey: SignedKeyPairSchema,
});

export type AuthenticationCreds = z.infer<typeof AuthenticationCredsSchema>;

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

export interface IAuthStateProvider {
	creds: AuthenticationCreds;
	keys: ISignalProtocolStore;
	db?: IStorageDatabase;
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

export type {
	ClientEventMap,
	DeepReadonly,
	IPlugin,
	MergePlugins,
	PluginAPI,
} from "./plugins";
