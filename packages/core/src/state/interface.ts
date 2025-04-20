import type { ADVSignedDeviceIdentity } from "@wha.ts/proto";
import type {
	KeyPair,
	SignalIdentity,
	SignedKeyPair,
} from "@wha.ts/utils/src/types";

export type AuthenticationCreds = {
	noiseKey: KeyPair;
	pairingEphemeralKeyPair: KeyPair;
	signedIdentityKey: KeyPair;
	signedPreKey: SignedKeyPair;
	registrationId: number;
	advSecretKey: Uint8Array;
	me?: { id: string; name?: string };
	account?: ADVSignedDeviceIdentity;
	platform?: string;
	signalIdentities?: SignalIdentity[];

	nextPreKeyId: number;
	firstUnuploadedPreKeyId: number;

	myAppStateKeyId?: string;
	accountSyncCounter: number;
	accountSettings: {
		unarchiveChats: boolean;
	};

	registered: boolean;
	pairingCode?: string;

	routingInfo?: Uint8Array;
};

export type SignalDataTypeMap = {
	"pre-key": KeyPair;
	session: Uint8Array;
	"signed-identity-key": KeyPair;
	"signed-pre-key": SignedKeyPair;
	"peer-identity-key": Uint8Array;
	"sender-key": Uint8Array;
};

export type SignalDataSet = {
	[T in keyof SignalDataTypeMap]?: {
		[id: string]: SignalDataTypeMap[T] | null | undefined;
	};
};

/** Interface for storing/retrieving Signal Protocol data (keys, sessions) */
export interface ISignalProtocolStore {
	get<T extends keyof SignalDataTypeMap>(
		type: T,
		ids: string[],
	): Promise<{ [id: string]: SignalDataTypeMap[T] | undefined }>;

	set(data: SignalDataSet): Promise<void>;

	/**
	 * Retrieves all session data for all devices of a given user.
	 * The returned object maps ProtocolAddress strings (user@server_deviceId) to session data.
	 */
	getAllSessionsForUser(
		userId: string,
	): Promise<{ [address: string]: SignalDataTypeMap["session"] | undefined }>;
}

/** Interface for the overall authentication state provider */
export interface IAuthStateProvider {
	creds: AuthenticationCreds;
	keys: ISignalProtocolStore;
	/** Saves the current credentials (noise key, identity key, me, etc.) */
	saveCreds(): Promise<void>;
}
