import { utf8ToBytes } from "@wha.ts/utils/src/bytes-utils";
import { hkdfSignalDeriveSecrets } from "@wha.ts/utils/src/crypto";
import { Curve } from "@wha.ts/utils/src/curve";
import { Mutex } from "@wha.ts/utils/src/mutex-utils";
import { BaseKeyType } from "./base_key_type";
import { ChainType } from "./chain_type";
import type { ProtocolAddress } from "./protocol_address";
import { type SessionEntry, SessionRecord } from "./session_record";

export class SessionBuilder {
	private readonly addr: string;
	private readonly storage: any;
	private readonly mutex: Mutex;

	constructor(storage: any, protocolAddress: ProtocolAddress) {
		this.addr = protocolAddress.toString();
		this.storage = storage;
		this.mutex = new Mutex();
	}

	async initOutgoing(device: {
		identityKey: Uint8Array;
		signedPreKey: {
			publicKey: Uint8Array;
			keyId: number;
			signature: Uint8Array;
		};
		preKey?: { publicKey: Uint8Array; keyId: number };
		registrationId: number;
	}): Promise<void> {
		const fqAddr = this.addr;

		return await this.mutex.runExclusive(async () => {
			if (
				!(await this.storage.isTrustedIdentity(
					this.addr,
					device.identityKey,
					ChainType.SENDING,
				))
			) {
				throw new Error("Untrusted identity");
			}
			Curve.verify(
				device.identityKey,
				device.signedPreKey.publicKey,
				device.signedPreKey.signature,
			);
			const baseKey = Curve.generateKeyPair();
			const devicePreKey = device.preKey?.publicKey;
			const session = await this.initSession(
				true,
				baseKey,
				undefined,
				device.identityKey,
				devicePreKey,
				device.signedPreKey.publicKey,
				device.registrationId,
			);
			session.pendingPreKey = {
				signedKeyId: device.signedPreKey.keyId,
				baseKey: baseKey.publicKey,
			};
			if (device.preKey) {
				session.pendingPreKey.preKeyId = device.preKey.keyId;
			}
			let record = await this.storage.loadSession(fqAddr);
			if (!record) {
				record = new SessionRecord();
			} else {
				const openSession = record.getOpenSession();
				if (openSession) {
					console.warn(
						"Closing stale open session for new outgoing prekey bundle",
					);
					record.closeSession(openSession);
				}
			}
			record.setSession(session);
			await this.storage.storeSession(fqAddr, record);
		});
	}

	async initIncoming(
		record: SessionRecord,
		message: {
			identityKey: Uint8Array;
			baseKey: Uint8Array;
			preKeyId?: number;
			signedPreKeyId?: number;
			registrationId?: number;
		},
	): Promise<number | undefined> {
		const fqAddr = this.addr.toString();
		if (
			!(await this.storage.isTrustedIdentity(
				fqAddr,
				message.identityKey,
				ChainType.RECEIVING,
			))
		) {
			throw new Error("Untrusted identity");
		}
		if (record.getSession(message.baseKey)) {
			return;
		}
		let preKeyPair:
			| { privateKey: Uint8Array; publicKey: Uint8Array }
			| undefined = undefined;
		if (typeof message.preKeyId !== "undefined") {
			preKeyPair = await this.storage.loadPreKey(message.preKeyId);
			if (!preKeyPair) {
				throw new Error("Invalid PreKey ID");
			}
		}
		let signedPreKeyPair:
			| { privateKey: Uint8Array; publicKey: Uint8Array }
			| undefined = undefined;
		if (typeof message.signedPreKeyId !== "undefined") {
			signedPreKeyPair = await this.storage.loadSignedPreKey(
				message.signedPreKeyId,
			);
			if (!signedPreKeyPair) {
				throw new Error("Missing SignedPreKey");
			}
		}
		const existingOpenSession = record.getOpenSession();
		if (existingOpenSession) {
			console.warn("Closing open session in favor of incoming prekey bundle");
			record.closeSession(existingOpenSession);
		}

		if (!preKeyPair) {
			throw new Error("Missing preKeyPair");
		}

		record.setSession(
			await this.initSession(
				false,
				preKeyPair,
				signedPreKeyPair,
				message.identityKey,
				message.baseKey,
				undefined,
				message.registrationId,
			),
		);
		return message.preKeyId;
	}

	async initSession(
		isInitiator: boolean,
		ourEphemeralKey: { privateKey: Uint8Array; publicKey: Uint8Array },
		ourSignedKey: { privateKey: Uint8Array; publicKey: Uint8Array } | undefined,
		theirIdentityPubKey: Uint8Array,
		theirEphemeralPubKey: Uint8Array | undefined,
		theirSignedPubKey: Uint8Array | undefined,
		registrationId: number | undefined,
	) {
		let localOurSignedKey = ourSignedKey;
		let localTheirSignedPubKey = theirSignedPubKey;
		if (isInitiator) {
			if (localOurSignedKey) {
				throw new Error("Invalid call to initSession");
			}
			localOurSignedKey = ourEphemeralKey;
		} else {
			if (localTheirSignedPubKey) {
				throw new Error("Invalid call to initSession");
			}
			localTheirSignedPubKey = theirEphemeralPubKey;
		}

		if (!ourEphemeralKey) {
			throw new Error("Missing ourEphemeralKey");
		}
		if (!theirEphemeralPubKey) {
			throw new Error("Missing theirEphemeralPubKey");
		}
		if (!localOurSignedKey) {
			throw new Error("Missing ourSignedKey");
		}
		if (!localTheirSignedPubKey) {
			throw new Error("Missing theirSignedPubKey");
		}

		let sharedSecret: Uint8Array;
		if (!ourEphemeralKey || !theirEphemeralPubKey) {
			sharedSecret = new Uint8Array(32 * 4);
		} else {
			sharedSecret = new Uint8Array(32 * 5);
		}
		for (let i = 0; i < 32; i++) {
			sharedSecret[i] = 0xff;
		}
		const ourIdentityKey = await this.storage.getOurIdentity();
		const a1 = Curve.sharedKey(
			ourIdentityKey.privateKey,
			localTheirSignedPubKey,
		);
		const a2 = Curve.sharedKey(
			localOurSignedKey.privateKey,
			theirIdentityPubKey,
		);
		const a3 = Curve.sharedKey(
			localOurSignedKey.privateKey,
			localTheirSignedPubKey,
		);
		if (isInitiator) {
			sharedSecret.set(new Uint8Array(a1), 32);
			sharedSecret.set(new Uint8Array(a2), 32 * 2);
		} else {
			sharedSecret.set(new Uint8Array(a1), 32 * 2);
			sharedSecret.set(new Uint8Array(a2), 32);
		}
		sharedSecret.set(new Uint8Array(a3), 32 * 3);
		if (ourEphemeralKey && theirEphemeralPubKey) {
			const a4 = Curve.sharedKey(
				ourEphemeralKey.privateKey,
				theirEphemeralPubKey,
			);
			sharedSecret.set(new Uint8Array(a4), 32 * 4);
		}
		const masterKey = hkdfSignalDeriveSecrets(
			sharedSecret,
			new Uint8Array(32),
			utf8ToBytes("WhisperText"),
		);
		const session = SessionRecord.createEntry();
		session.registrationId = registrationId;
		session.currentRatchet = {
			rootKey: masterKey[0],
			ephemeralKeyPair: isInitiator
				? Curve.generateKeyPair()
				: localOurSignedKey,
			lastRemoteEphemeralKey: localTheirSignedPubKey,
			previousCounter: 0,
		};
		session.indexInfo = {
			created: Date.now(),
			used: Date.now(),
			remoteIdentityKey: theirIdentityPubKey,
			baseKey: isInitiator ? ourEphemeralKey.publicKey : theirEphemeralPubKey,
			baseKeyType: isInitiator ? BaseKeyType.OURS : BaseKeyType.THEIRS,
			closed: -1,
		};
		if (isInitiator) {
			this.calculateSendingRatchet(session, localTheirSignedPubKey);
		}
		return session;
	}

	calculateSendingRatchet(session: SessionEntry, remoteKey: Uint8Array) {
		if (!session.currentRatchet) {
			throw new Error("Missing currentRatchet in session");
		}
		if (!remoteKey) {
			throw new Error("Missing remoteKey for ratchet");
		}
		const ratchet = session.currentRatchet;
		const sharedSecret = Curve.sharedKey(
			ratchet.ephemeralKeyPair.privateKey,
			remoteKey,
		);
		const masterKey = hkdfSignalDeriveSecrets(
			sharedSecret,
			ratchet.rootKey,
			utf8ToBytes("WhisperRatchet"),
		);
		session.addChain(ratchet.ephemeralKeyPair.publicKey, {
			messageKeys: {},
			chainKey: {
				counter: -1,
				key: masterKey[1],
			},
			chainType: ChainType.SENDING,
		});
		ratchet.rootKey = masterKey[0];
	}
}
