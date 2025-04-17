export const S_WHATSAPP_NET = "@s.whatsapp.net";
const GROUP_JID_SUFFIX = "@g.us";
const BROADCAST_JID_SUFFIX = "@broadcast";
const STATUS_JID_SUFFIX = "status@broadcast";
const NEWSLETTER_JID_SUFFIX = "@newsletter";
const LID_JID_SUFFIX = "@lid";

type JidServer =
	| "s.whatsapp.net"
	| "g.us"
	| "broadcast"
	| "lid"
	| "newsletter"
	| "c.us"
	| string;

type JidWithDevice = {
	user?: string;
	device?: number;
};

export type FullJid = JidWithDevice & {
	server: JidServer;
	domainType?: number;
};

export const jidEncode = (
	user?: string | number | null,
	server?: JidServer,
	device?: number,
): string => {
	const deviceSuffix = device !== undefined ? `:${device}` : "";
	return `${user != null ? user : ""}${deviceSuffix}@${server}`;
};

export const jidDecode = (jid: string | undefined): FullJid | undefined => {
	const sepIdx = typeof jid === "string" ? jid.indexOf("@") : -1;
	if (sepIdx < 0) {
		return undefined;
	}

	const server = jid?.slice(sepIdx + 1);
	const userCombined = jid?.slice(0, sepIdx);

	const [userAgent, device] = userCombined?.split(":") || [];
	const user = userAgent?.split("_")[0];

	return {
		server: server as JidServer,
		user,
		domainType: server === "lid" ? 1 : 0,
		device: device ? +device : undefined,
	};
};

export const areJidsSameUser = (
	jid1: string | undefined,
	jid2: string | undefined,
): boolean => {
	return (
		jidDecode(jidNormalizedUser(jid1))?.user ===
		jidDecode(jidNormalizedUser(jid2))?.user
	);
};

export const isJidUser = (jid: string | undefined): boolean =>
	!!jid && jid.endsWith(S_WHATSAPP_NET);

export const isLidUser = (jid: string | undefined): boolean =>
	!!jid && jid.endsWith(LID_JID_SUFFIX);

export const isJidBroadcast = (jid: string | undefined): boolean =>
	!!jid && jid.endsWith(BROADCAST_JID_SUFFIX);

export const isJidGroup = (jid: string | undefined): boolean =>
	!!jid && jid.endsWith(GROUP_JID_SUFFIX);

export const isJidStatusBroadcast = (jid: string | undefined): boolean =>
	jid === STATUS_JID_SUFFIX;

export const isJidNewsletter = (jid: string | undefined): boolean =>
	!!jid && jid.endsWith(NEWSLETTER_JID_SUFFIX);

export const jidNormalizedUser = (jid: string | undefined): string => {
	const result = jidDecode(jid);
	if (!result) {
		return "";
	}
	const server = result.server === "c.us" ? S_WHATSAPP_NET : result.server;
	return jidEncode(result.user, server as JidServer);
};
