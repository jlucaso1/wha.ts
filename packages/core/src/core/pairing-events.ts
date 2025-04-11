import type { BinaryNode } from "@wha.ts/binary/src/types";
import type { AuthenticationCreds } from "../state/interface";

interface QrUpdatePayload {
	qr: string;
}

interface PairingSuccessPayload {
	creds: Partial<AuthenticationCreds>;
	reply: BinaryNode;
}

interface PairingFailurePayload {
	error: Error;
}

export interface PairingManagerEventMap {
	"qr.update": QrUpdatePayload;
	"pairing.success": PairingSuccessPayload;
	"pairing.failure": PairingFailurePayload;
}
