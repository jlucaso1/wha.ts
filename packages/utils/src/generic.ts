import { Curve } from "./curve";
import type { KeyPair } from "./types";

export const generatePreKeys = (
	startId: number,
	count: number,
): { [id: number]: KeyPair } => {
	const keys: { [id: number]: KeyPair } = {};
	for (let i = 0; i < count; i++) {
		const id = startId + i;
		keys[id] = Curve.generateKeyPair();
	}
	return keys;
};
