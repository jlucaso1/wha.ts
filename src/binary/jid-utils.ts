// src/binary/jid-utils.ts

// Common WhatsApp JID servers/suffixes
export const S_WHATSAPP_NET = "@s.whatsapp.net"; // Standard user JIDs
export const GROUP_JID_SUFFIX = "@g.us"; // Group JIDs
export const BROADCAST_JID_SUFFIX = "@broadcast"; // Broadcast JIDs
export const STATUS_JID_SUFFIX = "status@broadcast"; // Status JID
export const NEWSLETTER_JID_SUFFIX = "@newsletter"; // Newsletter JIDs
export const LID_JID_SUFFIX = "@lid"; // LID JIDs (alternative identifier)
// Add others like @c.us, @call if needed for specific features later

// Define JidServer type more strictly if possible based on known suffixes
export type JidServer =
  | "s.whatsapp.net"
  | "g.us"
  | "broadcast"
  | "lid"
  | "newsletter"
  | "c.us"
  | string; // Allow string for future flexibility

export type JidWithDevice = {
  user: string;
  device?: number;
};

export type FullJid = JidWithDevice & {
  server: JidServer;
  // domainType might be specific to AD JID encoding, keep if needed for that
  // domainType?: number;
};

/** Encodes JID components into a string */
export const jidEncode = (
  user: string | number | null,
  server: JidServer,
  device?: number
  // agent?: number // Agent part seems less common in modern WAWeb? Keep minimal for now.
): string => {
  const deviceSuffix = device !== undefined ? `:${device}` : "";
  return `${user || ""}${deviceSuffix}@${server}`;
};

/** Decodes a JID string into its components */
export const jidDecode = (jid: string | undefined): FullJid | undefined => {
  if (typeof jid !== "string") {
    return undefined;
  }
  const sepIdx = jid.indexOf("@");
  if (sepIdx < 0) {
    return undefined; // Not a valid JID format
  }

  const server = jid.slice(sepIdx + 1) as JidServer;
  const userCombined = jid.slice(0, sepIdx);

  // Handle potential device ID (e.g., 12345:6@s.whatsapp.net)
  const [user, deviceStr] = userCombined.split(":");
  const device = deviceStr ? parseInt(deviceStr, 10) : undefined;

  if (deviceStr && isNaN(device!)) {
    // Invalid device format if it exists but isn't a number
    console.warn(`Invalid device ID format in JID: ${jid}`);
    return undefined;
  }

  if (!user) {
    console.warn(`Invalid user format in JID: ${jid}`);

    return undefined;
  }

  return {
    server,
    user,
    device,
  };
};

/** Checks if two JIDs belong to the same user (ignoring device and server type changes like c.us vs s.whatsapp.net) */
export const areJidsSameUser = (
  jid1: string | undefined,
  jid2: string | undefined
): boolean => {
  // Normalize both JIDs before comparing users
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

// Simplified Bot check - Adjust regex if specific patterns are needed
// const botRegexp = /^\d+@c\.us$/; // Example: Any number ending in @c.us
// export const isJidBot = (jid: string | undefined): boolean => !!jid && botRegexp.test(jid);

/** Normalizes a JID for user comparison (changes @c.us to @s.whatsapp.net) */
export const jidNormalizedUser = (jid: string | undefined): string => {
  const result = jidDecode(jid);
  if (!result) {
    return "";
  }
  // Treat @c.us the same as @s.whatsapp.net for user identification
  const server = result.server === "c.us" ? S_WHATSAPP_NET : result.server;
  // Re-encode with potentially normalized server and without device info
  return jidEncode(result.user, server as JidServer);
};
