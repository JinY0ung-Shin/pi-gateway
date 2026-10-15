import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { constantTimeEqual, SecretCipher } from "../src/crypto.js";
import { openDatabase } from "../src/db.js";
import { BrokerStore } from "../src/store.js";

describe("SecretCipher", () => {
  const cipher = new SecretCipher(randomBytes(32));
  const aad = SecretCipher.aad("github", "TOKEN", 1);

  it("암호화한 값을 다시 복호화한다", () => {
    const enc = cipher.encrypt("ghp_s3cr3t-value", aad);
    expect(enc.iv).toHaveLength(12);
    expect(enc.ciphertext.toString("utf8")).not.toContain("s3cr3t");
    expect(cipher.decrypt(enc, aad)).toBe("ghp_s3cr3t-value");
  });

  it("같은 값도 매번 다른 IV로 암호화한다", () => {
    const a = cipher.encrypt("same", aad);
    const b = cipher.encrypt("same", aad);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("AAD(서버·이름·버전)가 다르면 복호화하지 않는다", () => {
    const enc = cipher.encrypt("value", aad);
    expect(() => cipher.decrypt(enc, SecretCipher.aad("other", "TOKEN", 1))).toThrow();
    expect(() => cipher.decrypt(enc, SecretCipher.aad("github", "OTHER", 1))).toThrow();
    expect(() => cipher.decrypt(enc, SecretCipher.aad("github", "TOKEN", 2))).toThrow();
  });

  it("암호문이나 tag가 변조되면 복호화하지 않는다", () => {
    const enc = cipher.encrypt("value", aad);
    const flipped = Buffer.from(enc.ciphertext);
    flipped[0] = flipped[0]! ^ 1;
    expect(() => cipher.decrypt({ ...enc, ciphertext: flipped }, aad)).toThrow();
    const tag = Buffer.from(enc.tag);
    tag[0] = tag[0]! ^ 1;
    expect(() => cipher.decrypt({ ...enc, tag }, aad)).toThrow();
  });

  it("다른 KEK로는 복호화하지 않는다", () => {
    const enc = cipher.encrypt("value", aad);
    expect(() => new SecretCipher(randomBytes(32)).decrypt(enc, aad)).toThrow();
  });

  it("fingerprint는 같은 키·값이면 같고 원래 값을 드러내지 않는다", () => {
    expect(cipher.fingerprint("abc")).toBe(cipher.fingerprint("abc"));
    expect(cipher.fingerprint("abc")).not.toBe(cipher.fingerprint("abd"));
    expect(cipher.fingerprint("abc")).toMatch(/^[0-9a-f]{12}$/);
    expect(new SecretCipher(randomBytes(32)).fingerprint("abc")).not.toBe(cipher.fingerprint("abc"));
  });

  it("constantTimeEqual", () => {
    expect(constantTimeEqual("a", "a")).toBe(true);
    expect(constantTimeEqual("a", "ab")).toBe(false);
  });
});

describe("BrokerStore secrets", () => {
  const makeStore = () => {
    const db = openDatabase(":memory:");
    return { db, store: new BrokerStore(db, new SecretCipher(randomBytes(32))) };
  };
  const config = {
    id: "svc",
    runIn: "broker" as const,
    enabled: true,
    scope: "shared" as const,
    timeoutSec: 60,
    source: { kind: "manual" as const },
    transport: { type: "http" as const, url: "https://example.com/mcp", headers: { Authorization: "Bearer {{secret:TOKEN}}" } },
  };

  it("DB에는 평문이 남지 않고, 버전이 오르며, missingSecrets를 계산한다", () => {
    const { db, store } = makeStore();
    store.upsertServer(config);
    expect(store.missingSecrets(store.getServer("svc")!)).toEqual(["TOKEN"]);
    const first = store.putSecret("svc", "TOKEN", "plain-text-secret-1")!;
    const second = store.putSecret("svc", "TOKEN", "plain-text-secret-2")!;
    expect(second.version).toBe(first.version + 1);
    expect(store.missingSecrets(store.getServer("svc")!)).toEqual([]);
    const dump = JSON.stringify(db.prepare("SELECT * FROM secrets").all());
    expect(dump).not.toContain("plain-text-secret");
    expect(store.resolveSecrets("svc").values.get("TOKEN")).toBe("plain-text-secret-2");
  });

  it("다른 행으로 복사한 암호문은 복호화되지 않는다 (AAD)", () => {
    const { db, store } = makeStore();
    store.upsertServer(config);
    store.upsertServer({ ...config, id: "other" });
    store.putSecret("svc", "TOKEN", "victim-secret");
    store.putSecret("other", "TOKEN", "attacker-secret");
    db.prepare(
      "UPDATE secrets SET iv = (SELECT iv FROM secrets WHERE server_id='svc'), ciphertext = (SELECT ciphertext FROM secrets WHERE server_id='svc'), tag = (SELECT tag FROM secrets WHERE server_id='svc') WHERE server_id='other'",
    ).run();
    const resolved = store.resolveSecrets("other");
    expect(resolved.values.has("TOKEN")).toBe(false);
    expect(resolved.failed).toEqual(["TOKEN"]);
  });

  it("비밀키를 지웠다 다시 넣어도 버전(AAD)을 재사용하지 않는다", () => {
    const { store } = makeStore();
    store.upsertServer(config);
    const a = store.putSecret("svc", "TOKEN", "v1")!;
    store.deleteSecret("svc", "TOKEN");
    const b = store.putSecret("svc", "TOKEN", "v2")!;
    expect(b.version).toBeGreaterThan(a.version);
  });

  it("서버를 지우면 비밀키도 지운다", () => {
    const { db, store } = makeStore();
    store.upsertServer(config);
    store.putSecret("svc", "TOKEN", "value-1234");
    store.deleteServer("svc");
    expect(db.prepare("SELECT count(*) AS n FROM secrets").get()).toEqual({ n: 0 });
  });
});
