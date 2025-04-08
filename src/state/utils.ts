import { Curve, randomBytes, signedKeyPair } from "../signal/crypto";
import type { AuthenticationCreds } from "./interface";

let currentRegistrationId = Math.floor(Math.random() * 16380);

const generateRegistrationId = (): number => {
  currentRegistrationId = (currentRegistrationId + 1) % 16384;
  return currentRegistrationId;
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
    platform: undefined,
    me: undefined,
    account: undefined,
    signalIdentities: [],
    myAppStateKeyId: undefined,
    pairingCode: undefined,
    routingInfo: undefined,
  };
};
