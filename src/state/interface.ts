export type KeyPair = { public: Uint8Array; private: Uint8Array };

type SignedKeyPair = {
  keyPair: KeyPair;
  signature: Uint8Array;
  keyId: number;
};

type ProtocolAddress = {
  name: string;
  deviceId: number;
};

export type SignalIdentity = {
  identifier: ProtocolAddress;
  identifierKey: Uint8Array;
};

export type AuthenticationCreds = {
  noiseKey: KeyPair;
  pairingEphemeralKeyPair: KeyPair;
  signedIdentityKey: KeyPair;
  signedPreKey: SignedKeyPair;
  registrationId: number;
  advSecretKey: Uint8Array;
  me?: { id: string; name?: string };
  account?: any;
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
}

/** Interface for the overall authentication state provider */
export interface IAuthStateProvider {
  creds: AuthenticationCreds;
  keys: ISignalProtocolStore;
  /** Saves the current credentials (noise key, identity key, me, etc.) */
  saveCreds(): Promise<void>;
}
