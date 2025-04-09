export const S_WHATSAPP_NET = "@s.whatsapp.net";
export const GROUP_JID_SUFFIX = "@g.us";
export const BROADCAST_JID_SUFFIX = "@broadcast";
export const STATUS_JID_SUFFIX = "status@broadcast";
export const NEWSLETTER_JID_SUFFIX = "@newsletter";
export const LID_JID_SUFFIX = "@lid";

export type JidServer =
  | "s.whatsapp.net"
  | "g.us"
  | "broadcast"
  | "lid"
  | "newsletter"
  | "c.us"
  | string;

export type JidWithDevice = {
  user?: string;
  device?: number;
};

export type FullJid = JidWithDevice & {
  server: JidServer;
  domainType?: number;
};

/** Encodes JID components into a string */
export const jidEncode = (
  user?: string | number | null,
  server?: JidServer,
  device?: number
): string => {
  const deviceSuffix = device !== undefined ? `:${device}` : "";
  return `${user || ""}${deviceSuffix}@${server}`;
};

/** Decodes a JID string into its components */
export const jidDecode = (jid: string | undefined): FullJid | undefined => {
  const sepIdx = typeof jid === "string" ? jid.indexOf("@") : -1;
  if (sepIdx < 0) {
    return undefined;
  }

  const server = jid!.slice(sepIdx + 1);
  const userCombined = jid!.slice(0, sepIdx);

  const [userAgent, device] = userCombined.split(":");
  const user = userAgent?.split("_")[0];

  return {
    server: server as JidServer,
    user,
    domainType: server === "lid" ? 1 : 0,
    device: device ? +device : undefined,
  };
};

/** Checks if two JIDs belong to the same user (ignoring device and server type changes like c.us vs s.whatsapp.net) */
export const areJidsSameUser = (
  jid1: string | undefined,
  jid2: string | undefined
): boolean => {
  return (
    jidDecode(jidNormalizedUser(jid1))?.user ===
    jidDecode(jidNormalizedUser(jid2))?.user
  );
};

/** Is the JID a standard user JID (@s.whatsapp.net)? */
export const isJidUser = (jid: string | undefined): boolean =>
  !!jid && jid.endsWith(S_WHATSAPP_NET);

/** Is the JID a LID user JID (@lid)? */
export const isLidUser = (jid: string | undefined): boolean =>
  !!jid && jid.endsWith(LID_JID_SUFFIX);

/** Is the JID a broadcast JID (@broadcast)? */
export const isJidBroadcast = (jid: string | undefined): boolean =>
  !!jid && jid.endsWith(BROADCAST_JID_SUFFIX);

/** Is the JID a group JID (@g.us)? */
export const isJidGroup = (jid: string | undefined): boolean =>
  !!jid && jid.endsWith(GROUP_JID_SUFFIX);

/** Is the JID the specific status broadcast JID? */
export const isJidStatusBroadcast = (jid: string | undefined): boolean =>
  jid === STATUS_JID_SUFFIX;

/** Is the JID a newsletter JID (@newsletter)? */
export const isJidNewsletter = (jid: string | undefined): boolean =>
  !!jid && jid.endsWith(NEWSLETTER_JID_SUFFIX);

/** Normalizes a JID for user comparison (changes @c.us to @s.whatsapp.net) */
export const jidNormalizedUser = (jid: string | undefined): string => {
  const result = jidDecode(jid);
  if (!result) {
    return "";
  }
  const server = result.server === "c.us" ? S_WHATSAPP_NET : result.server;
  return jidEncode(result.user, server as JidServer);
};
