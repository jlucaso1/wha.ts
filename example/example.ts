import { renderUnicodeCompact } from "uqr";
import { createWAClient } from "../src/client";
import { GenericAuthState } from "../src/state/providers/generic-auth-state";
import localStorageDriver from "unstorage/drivers/localstorage";
import fsDriver from "unstorage/drivers/fs-lite";
import { createStorage } from "unstorage";

const IS_BROWSER = typeof window !== "undefined";

async function runExample() {
  const storage = IS_BROWSER
    ? createStorage({ driver: localStorageDriver({ base: "wha.ts" }) })
    : createStorage({ driver: fsDriver({ base: "./storage" }) });

  const authState = await GenericAuthState.init(storage);

  const client = createWAClient({
    auth: authState,
    logger: console,
  });

  client.addListener("connection.update", (update) => {
    console.log("[CONNECTION UPDATE]", JSON.stringify(update));

    const { connection, qr, isNewLogin, error } = update;

    if (qr) {
      console.log(renderUnicodeCompact(qr));
    }

    if (connection === "connecting") {
      console.log("🔌 Connecting...");
    }

    if (connection === "open") {
      console.log("✅ Connection successful!");
      console.log("   Your JID:", client.auth.creds.me?.id);
    }

    if (isNewLogin) {
      console.log("✨ Pairing successful (new login)!");
      console.log(
        "   Credentials saved. Waiting for server to close connection for restart..."
      );
    }

    if (connection === "close") {
      const reason = error?.message || "Unknown reason";

      console.log(`❌ Connection closed. Reason: ${reason}`);
    }
  });

  client.addListener("creds.update", (_creds) => {
    console.log("[CREDS UPDATE]", "Credentials were updated.");
  });

  try {
    await client.connect();
    console.log(
      "Connection process initiated. Waiting for events (QR code or login success)..."
    );
  } catch (error) {
    console.error("💥 Failed to initiate connection:", error);
  }
}

runExample().catch((err) => {
  console.error("Unhandled error during script execution:", err);
});
