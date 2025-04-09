import { renderUnicodeCompact } from "uqr";
import { createWAClient, MemoryAuthState } from "./src/client";

async function runExample() {
  console.log("Initializing Wha.ts client...");

  const authState = new MemoryAuthState();
  console.log("Using MemoryAuthState (no persistence).");

  const client = createWAClient({
    auth: authState,
    logger: console,
  });

  console.log("Setting up event listeners...");

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
