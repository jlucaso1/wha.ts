import { expect, test } from "bun:test";
import { createWAClient } from "@wha.ts/core";
import type { ClientEventMap } from "@wha.ts/core";
import { GenericAuthState } from "@wha.ts/storage";

const E2E_TEST_TIMEOUT = 10_000;

test(
	"Connect to WhatsApp, display QR",
	async () => {
		const authState = await GenericAuthState.init();
		const client = createWAClient({
			auth: authState,
			logger: console,
		});

		let connectionOpened = false;

		const qrCodePromise = new Promise<string>((resolve, reject) => {
			const handleUpdate = (update: ClientEventMap["connection.update"]) => {
				console.log("[E2E Test] Connection Update:", JSON.stringify(update));
				const { connection, qr, isNewLogin, error } = update;

				if (qr) {
					resolve(qr);
				}

				if (connection === "open") {
					console.log("[E2E Test] ✅ Connection successfully opened!");
					connectionOpened = true;
				}

				if (connection === "close") {
					if (error) {
						console.error(
							`[E2E Test] ❌ Connection closed with error: ${error.message}`,
						);
						if (!connectionOpened && !isNewLogin) {
							reject(error);
						} else {
							console.warn(
								"[E2E Test] Connection closed after being open or during pairing, considered success for this test phase.",
							);
						}
					} else {
						if (!connectionOpened && !isNewLogin) {
							reject(
								new Error(
									"Connection closed before pairing/opening successfully",
								),
							);
						} else {
							console.log(
								"[E2E Test] Connection closed normally after successful operation.",
							);
						}
					}
				}
			};

			client.addListener("connection.update", handleUpdate);
		});

		let qrCode: string | null = null;
		try {
			console.log("[E2E Test] Initiating connection...");
			await client.connect();
			console.log(
				"[E2E Test] Connection initiated. Waiting for QR code or login...",
			);

			qrCode = await qrCodePromise;
			console.log("[E2E Test] QR Code received or connection event resolved.");

			expect(
				qrCode || connectionOpened || client.auth.creds.registered,
			).toBeDefined();

			if (qrCode) {
				console.log("[E2E Test] QR Code was generated successfully.");
			}

			if (connectionOpened || client.auth.creds.registered) {
				console.log(
					`[E2E Test] Successfully connected/paired as ${client.auth.creds.me?.id}`,
				);
			}

			expect(
				qrCode !== null || connectionOpened || client.auth.creds.registered,
			).toBe(true);
		} catch (err) {
			console.error("[E2E Test] Test failed:", err);
			throw err;
		} finally {
			console.log("[E2E Test] Cleaning up: Closing connection...");
			await client
				.logout("E2E test finished")
				.catch((e) => console.error("Error during logout:", e));
			console.log("[E2E Test] Connection closed.");
			console.log("--- Finished Wha.ts E2E Connection Test ---\n");
		}
	},
	E2E_TEST_TIMEOUT,
);
