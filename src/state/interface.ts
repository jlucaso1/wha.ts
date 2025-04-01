import type { Buffer } from "node:buffer";

// --- Basic Crypto/Signal Types ---
export type KeyPair = { public: Uint8Array; private: Uint8Array };

export type SignedKeyPair = {
  keyPair: KeyPair;
  signature: Uint8Array;
  keyId: number;
};

export type ProtocolAddress = {
  name: string; // jid
  deviceId: number;
};

export type SignalIdentity = {
  identifier: ProtocolAddress;
  identifierKey: Uint8Array; // Should be public key
};

// --- Authentication Credentials ---
// Simplified initially, based on Baileys structure
export type AuthenticationCreds = {
  noiseKey: KeyPair; // XX Handshake static key
  pairingEphemeralKeyPair: KeyPair; // Ephemeral key for pairing code/QR
  signedIdentityKey: KeyPair; // Identity key pair
  signedPreKey: SignedKeyPair; // Current signed pre key
  registrationId: number; // WA registration ID
  advSecretKey: string; // ADV secret key
  me?: { id: string; name?: string }; // User info after login/pairing
  account?: any; // proto.ADVSignedDeviceIdentity; // Full account info after login
  platform?: string; // Platform obtained during login
  signalIdentities?: SignalIdentity[]; // Saved identities for contacts

  // Key management (needed for pre-key generation later)
  nextPreKeyId: number;
  firstUnuploadedPreKeyId: number;

  // State sync (placeholders for now)
  myAppStateKeyId?: string;
  accountSyncCounter: number;
  accountSettings: {
    unarchiveChats: boolean;
  };

  // Pairing/Login state
  registered: boolean; // Has the device been paired/registered?
  pairingCode?: string; // If using pairing code flow

  // Optional fields from Baileys that might be useful
  routingInfo?: Buffer; // Obtained during connection
};

// --- Signal Protocol Store Types ---

// Define the data types the store needs to handle
export type SignalDataTypeMap = {
  "pre-key": KeyPair;
  session: Uint8Array; // Serialized session record
  "signed-identity-key": KeyPair; // Own identity key (might be redundant with creds)
  "signed-pre-key": SignedKeyPair; // Own signed pre-key by ID
  // Add more types as needed (sender keys, etc.)
};

// Type for the data structure passed to the 'set' method
export type SignalDataSet = {
  [T in keyof SignalDataTypeMap]?: {
    [id: string]: SignalDataTypeMap[T] | null | undefined; // Allow null/undefined for deletion
  };
};

/** Interface for storing/retrieving Signal Protocol data (keys, sessions) */
export interface ISignalProtocolStore {
  get<T extends keyof SignalDataTypeMap>(
    type: T,
    ids: string[]
  ): Promise<{ [id: string]: SignalDataTypeMap[T] | undefined }>;

  set(data: SignalDataSet): Promise<void>;

  // Optional: clear?(): Promise<void>;
}

/** Interface for the overall authentication state provider */
export interface IAuthStateProvider {
  creds: AuthenticationCreds;
  keys: ISignalProtocolStore;
  /** Saves the current credentials (noise key, identity key, me, etc.) */
  saveCreds(): Promise<void>;
}
