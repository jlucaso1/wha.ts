import { create } from "@bufbuild/protobuf";
import { jidDecode } from "../binary";
import {
  ClientPayload_ConnectReason,
  ClientPayload_ConnectType,
  ClientPayload_UserAgent_Platform,
  ClientPayload_WebInfo_WebSubPlatform,
  ClientPayloadSchema,
  type ClientPayload,
} from "../gen/whatsapp_pb";

// Placeholder for generateLoginNode - requires auth state
export function generateLoginNode(userJid: string, config: any): ClientPayload {
  const { user, device } = jidDecode(userJid)!;
  console.warn("generateLoginNode using placeholder implementation");
  // This needs to be replaced with actual ClientPayload generation using protobuf-es
  // and real user/device data from auth state.
  const payload = create(ClientPayloadSchema, {
    passive: false,
    connectType: ClientPayload_ConnectType.WIFI_UNKNOWN,
    connectReason: ClientPayload_ConnectReason.USER_ACTIVATED,
    username: BigInt(user), // Protobuf expects number or bigint for uint64
    device: device || 0,
    userAgent: {
      platform: ClientPayload_UserAgent_Platform.WEB,
      appVersion: {
        primary: config.version[0],
        secondary: config.version[1],
        tertiary: config.version[2],
      },
      osVersion: config.browser[2] || "0.1",
      manufacturer: config.browser[0] || "Wha.ts",
      device: config.browser[1] || "NodeJS",
    },
    webInfo: {
      webSubPlatform: ClientPayload_WebInfo_WebSubPlatform.WEB_BROWSER, // Example
    },
    pull: true, // For MD login? Check Baileys logic
  });
  return payload;
}
