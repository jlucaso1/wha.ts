import type {
	PreKeySignalMessage,
	SignalMessage,
} from "@wha.ts/proto/gen/signal_pb";

export interface EncryptedSignalMessage {
	type: "pkmsg" | "msg"; // PreKey message or regular message
	ciphertext: Uint8Array; // The fully serialized PreKeySignalMessage or SignalMessage
	// Optional: recipient info if needed by caller
}

export interface ISignalProtocolManager {
	/**
	 * Encrypts a plaintext message for a recipient.
	 * Handles session lookup, creation (X3DH), and Double Ratchet encryption.
	 * @param recipientJid The JID string of the recipient.
	 * @param plaintext The data to encrypt (e.g., serialized inner WA message proto).
	 * @returns The encrypted message structure ready for sending.
	 * @throws Error if keys are missing for session setup or encryption fails.
	 */
	encryptMessage(
		recipientJid: string,
		plaintext: Uint8Array,
	): Promise<EncryptedSignalMessage>;

	/**
	 * Decrypts an incoming PreKeySignalMessage.
	 * Establishes a new session and decrypts the inner SignalMessage.
	 * @param senderJid The JID string of the sender.
	 * @param preKeyMsg The parsed PreKeySignalMessage proto.
	 * @returns The decrypted plaintext payload (e.g., serialized inner WA message proto).
	 * @throws Error if decryption or session setup fails.
	 */
	decryptPreKeyMessage(
		senderJid: string,
		preKeyMsg: PreKeySignalMessage,
	): Promise<Uint8Array>;

	/**
	 * Decrypts an incoming regular SignalMessage using an existing session.
	 * Handles Double Ratchet decryption.
	 * @param senderJid The JID string of the sender.
	 * @param signalMsg The parsed SignalMessage proto.
	 * @returns The decrypted plaintext payload (e.g., serialized inner WA message proto).
	 * @throws Error if decryption fails (no session, bad MAC, counter issues).
	 */
	decryptRegularMessage(
		senderJid: string,
		signalMsg: SignalMessage,
	): Promise<Uint8Array>;

	// Optional: Methods for managing identity keys if needed separately
	// processSenderKeyDistributionMessage(...)
}
