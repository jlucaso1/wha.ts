import type { BinaryNode } from "@wha.ts/binary";
import type { IAuthStateProvider } from "@wha.ts/types";
import { TypedEventTarget } from "@wha.ts/types/generics/typed-event-target";
import { bytesToBase64, bytesToUtf8 } from "@wha.ts/utils";
import type { ILogger } from "../transport/types";

export interface QRCodeGeneratorEventMap {
	qr: { qr: string };
	error: { error: Error };
}

export class QRCodeGenerator extends TypedEventTarget<QRCodeGeneratorEventMap> {
	private authStateProvider: IAuthStateProvider;
	private logger: ILogger;
	private qrTimeout?: ReturnType<typeof setTimeout>;
	private qrRetryCount = 0;
	private refNodes: BinaryNode[] = [];

	private initialQrTimeoutMs = 60_000;
	private subsequentQrTimeoutMs = 20_000;

	constructor(authStateProvider: IAuthStateProvider, logger: ILogger) {
		super();
		this.authStateProvider = authStateProvider;
		this.logger = logger;
	}

	public start(refNodes: BinaryNode[]): void {
		this.qrRetryCount = 0;
		this.refNodes = refNodes;
		this.generateAndEmitQR();
	}

	public stop(): void {
		if (this.qrTimeout) {
			clearTimeout(this.qrTimeout);
			this.qrTimeout = undefined;
		}
	}

	private generateAndEmitQR(): void {
		this.stop();

		const refNode = this.refNodes[this.qrRetryCount];
		if (!refNode?.content) {
			this.logger.error(
				{ refsAvailable: this.refNodes.length, count: this.qrRetryCount },
				"No more QR refs available, pairing timed out/failed",
			);
			const error = new Error("QR code generation failed (no refs left)");
			this.dispatchTypedEvent("error", { error });
			return;
		}

		if (!(refNode.content instanceof Uint8Array)) {
			throw new Error("Invalid reference node content");
		}

		const ref = bytesToUtf8(refNode.content);
		const noiseKeyB64 = bytesToBase64(
			this.authStateProvider.creds.noiseKey.publicKey,
		);
		const identityKeyB64 = bytesToBase64(
			this.authStateProvider.creds.signedIdentityKey.publicKey,
		);
		const advSecretB64 = bytesToBase64(
			this.authStateProvider.creds.advSecretKey,
		);

		const qr = [ref, noiseKeyB64, identityKeyB64, advSecretB64].join(",");

		this.dispatchTypedEvent("qr", { qr });

		const timeoutMs =
			this.qrRetryCount === 0
				? this.initialQrTimeoutMs
				: this.subsequentQrTimeoutMs;

		this.qrTimeout = setTimeout(() => {
			this.qrRetryCount += 1;
			this.logger.info(
				`QR timeout, generating new QR (retry ${this.qrRetryCount})`,
			);
			this.generateAndEmitQR();
		}, timeoutMs);
	}
}
