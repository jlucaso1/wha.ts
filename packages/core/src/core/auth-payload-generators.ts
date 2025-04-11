import { create, toBinary } from "@bufbuild/protobuf";
import { jidDecode } from "@wha.ts/binary/src/jid-utils";
import {
	type ClientPayload,
	ClientPayloadSchema,
	ClientPayload_ConnectReason,
	ClientPayload_ConnectType,
	ClientPayload_UserAgentSchema,
	ClientPayload_UserAgent_Platform,
	ClientPayload_UserAgent_ReleaseChannel,
	ClientPayload_WebInfoSchema,
	ClientPayload_WebInfo_WebSubPlatform,
	DevicePropsSchema,
	DeviceProps_PlatformType,
} from "@wha.ts/proto";
import { DEFAULT_BROWSER, KEY_BUNDLE_TYPE, WA_VERSION } from "../defaults";
import { sha256 } from "../signal/crypto";
import type { AuthenticationCreds } from "../state/interface";
import { utf8ToBytes } from "../utils/bytes-utils";
import { encodeBigEndian } from "../utils/generics";

const getPlatformType = (platform: string): DeviceProps_PlatformType => {
	const platformUpper = platform.toUpperCase();
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
		default:
			return DeviceProps_PlatformType.UNKNOWN;
	}
};

const getUserAgent = (
	version: number[] = WA_VERSION,
	browser: readonly [string, string, string] = DEFAULT_BROWSER,
): ClientPayload["userAgent"] => {
	return create(ClientPayload_UserAgentSchema, {
		platform: ClientPayload_UserAgent_Platform.WEB,
		appVersion: {
			primary: version[0],
			secondary: version[1],
			tertiary: version[2],
		},
		mcc: "000",
		mnc: "000",
		osVersion: browser[2] || "0.1",
		device: browser[1] || "Desktop",
		osBuildNumber: "0.1",
		releaseChannel: ClientPayload_UserAgent_ReleaseChannel.RELEASE,
		localeLanguageIso6391: "en",
		localeCountryIso31661Alpha2: "US",
	});
};

const getWebInfo = (
	browser: readonly [string, string, string] = DEFAULT_BROWSER,
): ClientPayload["webInfo"] => {
	let webSubPlatform = ClientPayload_WebInfo_WebSubPlatform.WEB_BROWSER;
	if (browser[0] === "Mac OS") {
		webSubPlatform = ClientPayload_WebInfo_WebSubPlatform.DARWIN;
	} else if (browser[0] === "Windows") {
		webSubPlatform = ClientPayload_WebInfo_WebSubPlatform.WIN32;
	}
	return create(ClientPayload_WebInfoSchema, {
		webSubPlatform,
	});
};

const getBaseClientPayload = (
	version: number[] = WA_VERSION,
	browser: readonly [string, string, string] = DEFAULT_BROWSER,
): Partial<ClientPayload> => ({
	userAgent: getUserAgent(version, browser),
	webInfo: getWebInfo(browser),
});

export const generateLoginPayload = (
	userJid: string,
	version: number[] = WA_VERSION,
	browser: readonly [string, string, string] = DEFAULT_BROWSER,
): ClientPayload => {
	const jidDecoded = jidDecode(userJid);

	if (!jidDecoded) {
		throw new Error("Invalid JID");
	}

	const { user, device } = jidDecoded;

	return create(ClientPayloadSchema, {
		...(getBaseClientPayload(version, browser) as ClientPayload),
		connectReason: ClientPayload_ConnectReason.USER_ACTIVATED,
		connectType: ClientPayload_ConnectType.WIFI_UNKNOWN,
		username: BigInt(user || "0"),
		device: device || 0,
		pull: true,
		passive: false,
	});
};

export const generateRegisterPayload = (
	creds: AuthenticationCreds,
	version: number[] = WA_VERSION,
	browser: readonly [string, string, string] = DEFAULT_BROWSER,
): ClientPayload => {
	const appVersionBuf = sha256(utf8ToBytes(version.join("."))); // maybe md5
	const devicePropsObject = create(DevicePropsSchema, {
		os: browser[0],
		platformType: getPlatformType(browser[1]),
		requireFullSync: false,
	});
	const devicePropsBytes = toBinary(DevicePropsSchema, devicePropsObject);
	return create(ClientPayloadSchema, {
		...(getBaseClientPayload(version, browser) as ClientPayload),
		connectReason: ClientPayload_ConnectReason.USER_ACTIVATED,
		connectType: ClientPayload_ConnectType.WIFI_UNKNOWN,
		passive: false,
		pull: false,
		devicePairingData: {
			$typeName: "ClientPayload.DevicePairingRegistrationData",
			buildHash: appVersionBuf,
			deviceProps: devicePropsBytes,
			eRegid: encodeBigEndian(creds.registrationId),
			eKeytype: KEY_BUNDLE_TYPE,
			eIdent: creds.signedIdentityKey.public,
			eSkeyId: encodeBigEndian(creds.signedPreKey.keyId, 3),
			eSkeyVal: creds.signedPreKey.keyPair.public,
			eSkeySig: creds.signedPreKey.signature,
		},
	});
};
