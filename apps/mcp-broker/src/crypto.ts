import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

export interface EncryptedValue {
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

const ENC_INFO = "pi-gateway/mcp-broker/secret-encryption/v1";
const FINGERPRINT_INFO = "pi-gateway/mcp-broker/secret-fingerprint/v1";

/**
 * 비밀값 암호화. KEK에서 HKDF로 암호화 키와 fingerprint 키를 따로 만든다.
 * AES-256-GCM, 12바이트 랜덤 IV, AAD = `serverId|name|version`.
 * AAD 덕분에 다른 서버·다른 이름·다른 버전 행으로 복사한 암호문은 복호화되지 않는다.
 */
export class SecretCipher {
  readonly #encKey: Buffer;
  readonly #fpKey: Buffer;

  constructor(kek: Buffer) {
    if (kek.length !== 32) throw new Error("KEK must be 32 bytes");
    this.#encKey = Buffer.from(hkdfSync("sha256", kek, Buffer.alloc(0), ENC_INFO, 32));
    this.#fpKey = Buffer.from(hkdfSync("sha256", kek, Buffer.alloc(0), FINGERPRINT_INFO, 32));
  }

  static aad(serverId: string, name: string, version: number): Buffer {
    return Buffer.from(`${serverId}|${name}|${version}`, "utf8");
  }

  encrypt(plaintext: string, aad: Buffer): EncryptedValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#encKey, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { iv, ciphertext, tag: cipher.getAuthTag() };
  }

  /** 변조됐거나 AAD가 다르면 예외를 던진다. */
  decrypt(value: EncryptedValue, aad: Buffer): string {
    const decipher = createDecipheriv("aes-256-gcm", this.#encKey, value.iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(value.tag);
    return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString("utf8");
  }

  /** 같은 값인지 비교하는 용도의 짧은 식별값. 키가 없으면 원래 값을 추측할 수 없다. */
  fingerprint(plaintext: string): string {
    return createHmac("sha256", this.#fpKey).update(plaintext, "utf8").digest("hex").slice(0, 12);
  }
}
