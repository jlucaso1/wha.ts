import {
  generateX25519KeyPair,
  randomBytes,
  signedKeyPair,
} from "../signal/crypto";
import type { AuthenticationCreds } from "./interface";

// Simple counter for registration ID, not cryptographically secure for production
let currentRegistrationId = Math.floor(Math.random() * 16380); // Range 0-16383

export const generateRegistrationId = (): number => {
  // Wrap around if it exceeds the max value for WA
  currentRegistrationId = (currentRegistrationId + 1) % 16384;
  return currentRegistrationId;
};

export const initAuthCreds = (): AuthenticationCreds => {
  const identityKey = generateX25519KeyPair(); // Used for Signal Identity
  // Note: Baileys uses Curve.generateKeyPair which seems X25519 based on usage.
  // WA signs with the Ed25519 version derived from the X25519 private key,
  // but X25519 is used for ECDH. Node crypto handles these separately.
  // For now, we generate X25519; Ed25519 signing is stubbed.

  return {
    noiseKey: generateX25519KeyPair(),
    pairingEphemeralKeyPair: generateX25519KeyPair(),
    signedIdentityKey: identityKey,
    signedPreKey: signedKeyPair(identityKey, 1), // Generate pre-key #1, signed by identity
    registrationId: generateRegistrationId(),
    advSecretKey: randomBytes(32).toString("base64"), // ADV Secret
    // processedHistoryMessages: [], // For future history sync
    nextPreKeyId: 1, // Start prekey IDs from 1
    firstUnuploadedPreKeyId: 1, // Start prekey IDs from 1
    accountSyncCounter: 0,
    accountSettings: {
      unarchiveChats: false, // Default setting
    },
    // Initial state: not logged in, no user info
    registered: false,
    platform: undefined,
    me: undefined,
    account: undefined,
    signalIdentities: [],
    // Other fields initialized
    myAppStateKeyId: undefined,
    pairingCode: undefined,
    routingInfo: undefined,
  };
};
