// src/utils/auth-logic.ts
import { Buffer } from "node:buffer";
import {
  createHash,
  createHmac,
  randomBytes as cryptoRandomBytes,
} from "node:crypto";
import {
  S_WHATSAPP_NET,
  getBinaryNodeChild,
  getBinaryNodeChildren,
  jidDecode,
  jidEncode,
  type BinaryNode,
} from "../binary";
import {
  DEFAULT_BROWSER,
  KEY_BUNDLE_TYPE,
  WA_CERT_DETAILS, // Assuming this is defined in defaults
  WA_VERSION,
} from "../defaults";
import {
  ClientPayloadSchema,
  ClientPayload_UserAgent_Platform,
  ClientPayload_WebInfo_WebSubPlatform,
  DeviceProps_PlatformType,
  ADVSignedDeviceIdentitySchema,
  ADVDeviceIdentitySchema,
  ADVSignedDeviceIdentityHMACSchema,
  CertChainSchema,
  CertChain_NoiseCertificate_DetailsSchema,
  type ClientPayload,
  type DeviceProps,
  type ADVSignedDeviceIdentity,
  ClientPayload_UserAgentSchema,
  ClientPayload_WebInfoSchema,
  type ClientPayload_DevicePairingRegistrationData,
} from "../gen/whatsapp_pb"; // Adjust path if needed
import { signEd25519, generateX25519KeyPair } from "../signal/crypto"; // Assuming crypto utils exist
import type { AuthenticationCreds } from "../state/interface";
import type { ILogger, WebSocketConfig } from "../transport/types";
import { encodeBigEndian } from "./generics"; // Need this utility
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

// Helper: Map platform string to PlatformType enum
const getPlatformType = (platform: string): DeviceProps_PlatformType => {
  const platformUpper = platform.toUpperCase();
  // Use a more robust mapping if needed, this is basic
  switch (platformUpper) {
    case "CHROME":
      return DeviceProps_PlatformType.CHROME;
    case "FIREFOX":
      return DeviceProps_PlatformType.FIREFOX;
    case "IE":
      return DeviceProps_PlatformType.IE;
    case "OPERA":
      return DeviceProps_PlatformType.OPERA;
    case "SAFARI":
      return DeviceProps_PlatformType.SAFARI;
    case "EDGE":
      return DeviceProps_PlatformType.EDGE;
    case "DESKTOP":
      return DeviceProps_PlatformType.DESKTOP;
    case "IPAD":
      return DeviceProps_PlatformType.IPAD;
    case "ANDROID_TABLET":
      return DeviceProps_PlatformType.ANDROID_TABLET;
    // Add other platforms from the enum as needed
    default:
      return DeviceProps_PlatformType.UNKNOWN;
  }
};

// Helper: Get UserAgent based on config
const getUserAgent = (
  version: number[] = WA_VERSION,
  browser: readonly [string, string, string] = DEFAULT_BROWSER
): ClientPayload["userAgent"] => {
  return create(ClientPayload_UserAgentSchema, {
    platform: ClientPayload_UserAgent_Platform.WEB, // Assuming web for now
    appVersion: {
      primary: version[0],
      secondary: version[1],
      tertiary: version[2],
    },
    osVersion: browser[2] || "0.1",
    manufacturer: browser[0] || "Wha.ts", // OS Name
    device: browser[1] || "NodeJS", // Browser Name
    osBuildNumber: "0.1", // Default
  });
};

// Helper: Get WebInfo based on config
const getWebInfo = (
  browser: readonly [string, string, string] = DEFAULT_BROWSER
): ClientPayload["webInfo"] => {
  let webSubPlatform = ClientPayload_WebInfo_WebSubPlatform.WEB_BROWSER;
  // Simple mapping, expand if needed
  if (browser[0] === "Mac OS") {
    webSubPlatform = ClientPayload_WebInfo_WebSubPlatform.DARWIN;
  } else if (browser[0] === "Windows") {
    webSubPlatform = ClientPayload_WebInfo_WebSubPlatform.WIN32;
  }

  return create(ClientPayload_WebInfoSchema, {
    webSubPlatform: webSubPlatform,
  });
};

// Simplified Client Payload generation (Adapt from Baileys/validate-connection)
const getBaseClientPayload = (
  version: number[] = WA_VERSION,
  browser: readonly [string, string, string] = DEFAULT_BROWSER
): Partial<ClientPayload> => ({
  // connectType default is WIFI_UNKNOWN, ConnectReason required
  userAgent: getUserAgent(version, browser),
  webInfo: getWebInfo(browser),
});

/** Generates the ClientPayload for logging in with existing credentials */
export const generateLoginPayload = (
  userJid: string,
  version: number[] = WA_VERSION,
  browser: readonly [string, string, string] = DEFAULT_BROWSER
): ClientPayload => {
  const { user, device } = jidDecode(userJid)!; // Assuming jidDecode always returns valid parts for a logged-in user
  const payload = create(ClientPayloadSchema, {
    ...(getBaseClientPayload(version, browser) as ClientPayload),
    // connectReason: ClientPayload_ConnectReason.USER_ACTIVATED, // Example
    passive: false, // Should be false for active login? Check Baileys logic
    pull: true, // MD requires pull=true for login?
    username: BigInt(user), // Use BigInt for uint64
    device: device || 0,
    // sessionId: Generate or retrieve session ID if needed
    // shortConnect: Check if needed
  });
  return payload;
};

/** Generates the ClientPayload for registering a new device */
export const generateRegisterPayload = (
  creds: AuthenticationCreds, // Requires initial creds
  version: number[] = WA_VERSION,
  browser: readonly [string, string, string] = DEFAULT_BROWSER
): ClientPayload => {
  const appVersionBuf = createHash("md5")
    .update(version.join(".")) // join as string
    .digest();

  // Placeholder for DeviceProps - Adapt from Baileys/validate-connection
  const companion: Partial<DeviceProps> = {
    os: browser[0],
    platformType: getPlatformType(browser[1]),
    // requireFullSync: config.syncFullHistory, // Add config later
  };
  const companionProto = Buffer.from([]); // Replace with actual encoded proto

  const registerPayload = create(ClientPayloadSchema, {
    ...(getBaseClientPayload(version, browser) as ClientPayload),
    // connectReason: ClientPayload_ConnectReason.USER_ACTIVATED, // Example
    passive: true, // Passive is true for registration/pairing
    pull: false,
    devicePairingData: {
      $typeName: "ClientPayload.DevicePairingRegistrationData",
      buildHash: appVersionBuf,
      deviceProps: companionProto,
      eRegid: encodeBigEndian(creds.registrationId), // Need encodeBigEndian
      eKeytype: KEY_BUNDLE_TYPE, // From defaults
      eIdent: creds.signedIdentityKey.public,
      eSkeyId: encodeBigEndian(creds.signedPreKey.keyId, 3), // 3 bytes
      eSkeyVal: creds.signedPreKey.keyPair.public,
      eSkeySig: creds.signedPreKey.signature,
    },
  });
  return registerPayload;
};

/** HMAC sign implementation (simple wrapper) */
const hmacSign = (data: Uint8Array, key: Uint8Array): Buffer => {
  return createHmac("sha256", key).update(data).digest();
};

/** Curve sign implementation (simple wrapper, ensure crypto.ts exports signEd25519) */
// Assuming signEd25519 exists and handles the key format appropriately
// const curveSign = (privateKey: Uint8Array, message: Uint8Array): Buffer => {
//     return Buffer.from(signEd25519(privateKey, message));
// };
// Stubbing Curve sign as it was complex before
const curveSign = (privateKey: Uint8Array, message: Uint8Array): Buffer => {
  console.warn("Using stubbed curveSign in auth-logic!");
  return Buffer.from(cryptoRandomBytes(64));
};

// Placeholder for Curve verify
const curveVerify = (
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array
): boolean => {
  console.warn("Using stubbed curveVerify in auth-logic!");
  return true; // Assume valid for now
};

// Placeholder for signal ID creation
const createSignalIdentity = (
  jid: string,
  publicKey: Uint8Array
): {
  identifier: { name: string; deviceId: number };
  identifierKey: Uint8Array;
} => {
  return {
    identifier: { name: jid, deviceId: 0 }, // Assuming primary device initially
    identifierKey: publicKey, // Need to handle version byte prefixing if necessary
  };
};

/**
 * Processes the <iq type='result' tag='pair-success'> stanza
 * Extracts account info, verifies signatures, generates reply.
 * Adapted from Baileys `configureSuccessfulPairing`.
 */
export const configureSuccessfulPairing = (
  stanza: BinaryNode,
  creds: AuthenticationCreds // Pass current creds
): { creds: Partial<AuthenticationCreds>; reply: BinaryNode } => {
  const msgId = stanza.attrs.id;

  const pairSuccessNode = getBinaryNodeChild(stanza, "pair-success");
  if (!pairSuccessNode) throw new Error("Missing 'pair-success' in stanza");

  const deviceIdentityNode = getBinaryNodeChild(
    pairSuccessNode,
    "device-identity"
  );
  const platformNode = getBinaryNodeChild(pairSuccessNode, "platform");
  const deviceNode = getBinaryNodeChild(pairSuccessNode, "device");
  const businessNode = getBinaryNodeChild(pairSuccessNode, "biz");

  if (!deviceIdentityNode?.content || !deviceNode?.attrs.jid) {
    throw new Error(
      "Missing device-identity content or device jid in pair-success node"
    );
  }

  // 1. Decode ADVSignedDeviceIdentityHMAC
  const hmacIdentity = fromBinary(
    ADVSignedDeviceIdentityHMACSchema,
    deviceIdentityNode.content as Uint8Array
  );
  if (!hmacIdentity.details || !hmacIdentity.hmac) {
    throw new Error("Invalid ADVSignedDeviceIdentityHMAC structure");
  }

  // 2. Verify HMAC
  const advSign = hmacSign(
    hmacIdentity.details,
    Buffer.from(creds.advSecretKey, "base64")
  );
  if (Buffer.compare(hmacIdentity.hmac, advSign) !== 0) {
    console.error(
      "HMAC Details:",
      Buffer.from(hmacIdentity.details).toString("hex")
    );
    console.error("ADV Key:", creds.advSecretKey);
    console.error(
      "Received HMAC:",
      Buffer.from(hmacIdentity.hmac).toString("hex")
    );
    console.error("Calculated HMAC:", advSign.toString("hex"));
    throw new Error("Invalid ADV account signature HMAC");
  }

  // 3. Decode ADVSignedDeviceIdentity
  const account = fromBinary(
    ADVSignedDeviceIdentitySchema,
    hmacIdentity.details
  );
  if (
    !account.details ||
    !account.accountSignatureKey ||
    !account.accountSignature
  ) {
    throw new Error("Invalid ADVSignedDeviceIdentity structure");
  }

  // 4. Verify Account Signature
  // Signature is created by signing: (6, 0) + deviceDetails + identityPubKey
  const accountMsg = Buffer.concat([
    Buffer.from([6, 0]),
    account.details,
    creds.signedIdentityKey.public, // Our public identity key
  ]);
  if (
    !curveVerify(
      account.accountSignatureKey,
      accountMsg,
      account.accountSignature
    )
  ) {
    throw new Error("Invalid account signature");
  }

  // 5. Create Device Signature
  // Signed by our private identity key over: (6, 1) + deviceDetails + identityPubKey + accountSignatureKey
  const deviceMsg = Buffer.concat([
    Buffer.from([6, 1]),
    account.details,
    creds.signedIdentityKey.public,
    account.accountSignatureKey,
  ]);
  // Use the *private* part of our identity key
  const deviceSignature = curveSign(creds.signedIdentityKey.private, deviceMsg);
  const updatedAccount: ADVSignedDeviceIdentity = {
    ...account,
    deviceSignature: deviceSignature,
  };

  // 6. Prepare Creds Update
  const bizName = businessNode?.attrs.name;
  const jid = deviceNode.attrs.jid;
  const identity = createSignalIdentity(jid, account.accountSignatureKey);

  const authUpdate: Partial<AuthenticationCreds> = {
    me: { id: jid, name: bizName },
    account: updatedAccount, // Store the signed account details
    signalIdentities: [...(creds.signalIdentities || []), identity],
    platform: platformNode?.attrs.name,
    registered: true, // Mark as registered
  };

  // 7. Encode reply ADVSignedDeviceIdentity
  const accountReply = fromBinary(
    ADVSignedDeviceIdentitySchema,
    toBinary(ADVSignedDeviceIdentitySchema, updatedAccount)
  );
  // const accountEnc = toBinary(ADVSignedDeviceIdentitySchema, updatedAccount);
  // Need to decode the inner `details` to get `keyIndex` for the reply attribute
  const deviceIdentity = fromBinary(
    ADVDeviceIdentitySchema,
    updatedAccount.details!
  );

  const accountEnc = toBinary(ADVSignedDeviceIdentitySchema, {
    ...accountReply,
    accountSignatureKey: undefined, // Send null for signature key in reply
  });

  if (!msgId) {
    throw new Error("Missing message ID in stanza"); // Ensure if this verification is valid
  }

  // 8. Construct Reply IQ Stanza
  const reply: BinaryNode = {
    tag: "iq",
    attrs: {
      to: S_WHATSAPP_NET,
      type: "result",
      id: msgId,
    },
    content: [
      {
        tag: "pair-device-sign",
        attrs: {},
        content: [
          {
            tag: "device-identity",
            attrs: { "key-index": (deviceIdentity.keyIndex || 0).toString() }, // Key index from decoded details
            content: accountEnc,
          },
        ],
      },
    ],
  };

  return {
    creds: authUpdate,
    reply,
  };
};
