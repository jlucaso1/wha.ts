import { Curve, randomBytes, signedKeyPair } from "../signal/crypto";
import type { AuthenticationCreds } from "./interface";
import { bytesToBase64, base64ToBytes } from "../utils/bytes-utils";

const generateRegistrationId = (): number => {
  return Uint16Array.from(randomBytes(2)!)[0]! & 16383;
};

export const initAuthCreds = (): AuthenticationCreds => {
  const identityKey = Curve.generateKeyPair();

  return {
    noiseKey: Curve.generateKeyPair(),
    pairingEphemeralKeyPair: Curve.generateKeyPair(),
    signedIdentityKey: identityKey,
    signedPreKey: signedKeyPair(identityKey, 1),
    registrationId: generateRegistrationId(),
    advSecretKey: randomBytes(32),
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSyncCounter: 0,
    accountSettings: {
      unarchiveChats: false,
    },
    registered: false,
    pairingCode: undefined,
    routingInfo: undefined,
  };
};

export const BufferJSON = {
  replacer: (_k: string, value: any) => {
    if (
      value instanceof Uint8Array ||
      value?.type === "Buffer"
    ) {
      return {
        type: "Buffer",
        data: bytesToBase64(value?.data || value),
      };
    }

    return value;
  },

  reviver: (_k: string, value: any) => {
    if (
      typeof value === "object" &&
      !!value &&
      (value.buffer === true || value.type === "Buffer")
    ) {
      const val = value.data || value.value;
      return typeof val === "string"
        ? base64ToBytes(val)
        : new Uint8Array(val || []);
    }

    return value;
  },
};
