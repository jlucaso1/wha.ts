import { createWAClient, MemoryAuthState } from "./src/client";
import * as qrcode from "qrcode-terminal";

async function runExample() {
  console.log("Initializing Wha.ts client...");

  const authState = new MemoryAuthState();
  console.log("Using MemoryAuthState (no persistence).");

  const client = createWAClient({
    auth: authState,
    logger: console,
    wsOptions: {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    }
  });

  console.log("Setting up event listeners...");

  client.on("connection.update", (update) => {
    console.log("[CONNECTION UPDATE]", JSON.stringify(update));

    const { connection, qr, isNewLogin, error } = update;

    if (qr) {
      console.log(
        "\n------------------------- QR CODE -------------------------"
      );
      qrcode.generate(qr, { small: true }, (qrText) => {
        console.log(qrText);
      });
      console.log(
        "-----------------------------------------------------------"
      );
      console.log("Scan the QR code using WhatsApp on your phone:");
      console.log("Settings > Linked Devices > Link a device");
      console.log(
        "-----------------------------------------------------------\n"
      );
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
      const shouldReconnect = (error as any)?.reason !== 401;

      console.log(`❌ Connection closed. Reason: ${reason}`);
      if (shouldReconnect) {
        console.log(
          "   Connection closed unexpectedly. You might need to restart."
        );
        process.exit(1);
      } else {
        console.log(
          "   Connection closed (likely intended, e.g., logout or credential issue)."
        );
        process.exit(0);
      }
    }
  });

  client.on("creds.update", (creds) => {
    console.log("[CREDS UPDATE]", "Credentials were updated.");
  });

  console.log("Attempting to connect to WhatsApp...");
  try {
    await client.connect();
    console.log(
      "Connection process initiated. Waiting for events (QR code or login success)..."
    );
  } catch (error) {
    console.error("💥 Failed to initiate connection:", error);
    process.exit(1);
  }

  console.log("Script running, monitoring connection...");

  process.on("SIGINT", async () => {
    console.log("\nReceived SIGINT (Ctrl+C). Logging out...");
    try {
      await client.logout("User interrupted");
    } catch (err) {
      console.error("Error during logout:", err);
    } finally {
      console.log("Exiting.");
      process.exit(0);
    }
  });
}

runExample().catch((err) => {
  console.error("Unhandled error during script execution:", err);
  process.exit(1);
});
