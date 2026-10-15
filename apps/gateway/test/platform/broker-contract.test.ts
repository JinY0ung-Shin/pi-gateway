import { AUD_BROKER, jwtSecretBytes, signInternalToken } from "@pi-gateway/shared";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db.js";
import { McpRegistryService } from "../../src/mcp-registry/service.js";
import {
  BROKER_ADMIN_TOKEN,
  BROKER_JWT_SECRET,
  captureLogger,
  cleanupTempDirs,
  makeConfig,
  startFakeTestBroker,
  startRealBroker,
  type TestBroker,
  tempDir,
  testBrokerEnv,
} from "./helpers.js";

/**
 * 계약 테스트: 다른 테스트가 쓰는 가짜 broker(helpers.ts)와 실제 broker(apps/mcp-broker createBroker)가
 * 같은 요청에 같은 결과를 내는지 확인한다. 둘이 어긋나면 여기서 실패한다.
 * 실제 broker는 upstream에 연결하지 않는 요청만 쓴다 (네트워크 없음).
 */

async function adminCall(b: TestBroker, method: string, path: string, body?: unknown) {
  const res = await fetch(b.adminUrl + path, {
    method,
    headers: { authorization: `Bearer ${BROKER_ADMIN_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: Record<string, any> | undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

const docs = {
  id: "docs",
  runIn: "broker",
  transport: { type: "http", url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer {{secret:T}}" } },
};

/** 같은 순서로 요청하고 관찰 가능한 결과만 모은다 */
async function scenario(b: TestBroker): Promise<unknown[]> {
  const out: unknown[] = [];
  const token = await signInternalToken(jwtSecretBytes(BROKER_JWT_SECRET), AUD_BROKER, { sub: "_admin", sid: "catalog" }, 60);
  const visible = async () => {
    const res = await fetch(`${b.dataUrl}/mcp/servers`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { servers?: { id: string }[] };
    return [res.status, (body.servers ?? []).map((s) => s.id)];
  };
  let r = await adminCall(b, "PUT", "/admin/servers/docs", docs);
  out.push(["create", r.status, r.json?.missingSecrets]);
  r = await adminCall(b, "PUT", "/admin/servers/docs", { ...docs, displayName: "Docs" });
  out.push(["update", r.status]);
  r = await adminCall(b, "GET", "/admin/servers/docs");
  out.push(["get", r.status, r.json?.config?.displayName]);
  out.push(["hidden without secret", await visible()]);
  r = await adminCall(b, "PUT", "/admin/servers/docs/secrets/T", { value: "s3cr3t-value-123" });
  out.push(["put secret", r.status]);
  r = await adminCall(b, "GET", "/admin/servers/docs");
  out.push(["secret set", r.json?.missingSecrets, (r.json?.secrets ?? []).map((s: { name: string }) => s.name), JSON.stringify(r.json).includes("s3cr3t")]);
  out.push(["visible", await visible()]);
  r = await adminCall(b, "PUT", "/admin/servers/docs", { ...docs, displayName: "Docs", timeoutSec: 30 });
  out.push(["cosmetic edit keeps secret", r.status, r.json?.missingSecrets]);
  r = await adminCall(b, "PUT", "/admin/servers/docs", { ...docs, transport: { ...docs.transport, headers: { authorization: "Bearer {{secret:T}}" } } });
  out.push(["header name case keeps secret", r.status, r.json?.missingSecrets]);
  r = await adminCall(b, "PUT", "/admin/servers/docs", {
    ...docs,
    transport: { ...docs.transport, headers: { Authorization: "Bearer {{secret:T}}", "X-Extra": "1" } },
  });
  out.push(["header change clears secret", r.status, r.json?.missingSecrets]);
  out.push(["hidden after clear", await visible()]);
  const rejected: [string, Record<string, unknown>][] = [
    ["literal credential", { ...docs, id: "lit", transport: { type: "http", url: "https://x.example.com/mcp", headers: { Authorization: "Bearer abc" } } }],
    ["npx", { id: "npxsrv", runIn: "broker", transport: { type: "stdio", command: "npx", args: ["-y", "@x/mcp"] } }],
    ["reserved id", { ...docs, id: "servers" }],
    ["plugin_root", { id: "pr", runIn: "broker", transport: { type: "stdio", command: "node", args: ["{{plugin_root}}/x.js"] } }],
    ["sandbox", { id: "sb", runIn: "sandbox", scope: "per-user", transport: { type: "stdio", command: "node", args: ["x.js"] } }],
  ];
  for (const [label, body] of rejected) {
    r = await adminCall(b, "PUT", `/admin/servers/${String(body.id)}`, body);
    out.push([label, r.status, r.json?.error?.code]);
  }
  r = await adminCall(b, "PUT", "/admin/servers/other", docs);
  out.push(["id mismatch", r.status]);
  r = await adminCall(b, "PUT", "/admin/servers/nope/secrets/T", { value: "x" });
  out.push(["secret for missing server", r.status]);
  r = await adminCall(b, "DELETE", "/admin/servers/docs");
  out.push(["delete", r.status]);
  r = await adminCall(b, "DELETE", "/admin/servers/docs");
  out.push(["delete again", r.status]);
  r = await adminCall(b, "GET", "/admin/servers/docs");
  out.push(["get deleted", r.status]);
  return out;
}

/** plugin 업데이트: 같은 stdio 실행 대상으로 다시 등록하면 비밀키가 남고, 경로가 바뀌면 지워진다 */
async function stdioScenario(b: TestBroker): Promise<unknown[]> {
  const out: unknown[] = [];
  const stable = "/opt/plugins/mkt/secret-tools/current/gh.js";
  const env = { GITHUB_TOKEN: "{{secret:GITHUB_TOKEN}}", LOG_LEVEL: "info" };
  const gh = (args: string[], envs: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    id: "gh",
    runIn: "broker",
    transport: { type: "stdio", command: "node", args, env: envs },
    ...extra,
  });
  let r = await adminCall(b, "PUT", "/admin/servers/gh", gh([stable], env));
  out.push(["create", r.status, r.json?.missingSecrets]);
  r = await adminCall(b, "PUT", "/admin/servers/gh/secrets/GITHUB_TOKEN", { value: "ghp_contract_value_1" });
  out.push(["put secret", r.status]);
  r = await adminCall(b, "PUT", "/admin/servers/gh", gh([stable], env, { description: "0.1.1" }));
  out.push(["same target keeps secret", r.status, r.json?.missingSecrets]);
  r = await adminCall(b, "PUT", "/admin/servers/gh", gh([stable], { LOG_LEVEL: "info", GITHUB_TOKEN: "{{secret:GITHUB_TOKEN}}" }));
  out.push(["env order keeps secret", r.status, r.json?.missingSecrets]);
  r = await adminCall(b, "PUT", "/admin/servers/gh", gh(["/opt/plugins/mkt/secret-tools/0.1.1/gh.js"], env));
  out.push(["versioned path clears secret", r.status, r.json?.missingSecrets]);
  r = await adminCall(b, "DELETE", "/admin/servers/gh");
  out.push(["delete", r.status]);
  return out;
}

/** gateway의 McpRegistryService가 broker를 쓰는 흐름 */
async function registryFlow(b: TestBroker): Promise<unknown[]> {
  const out: unknown[] = [];
  const config = makeConfig({
    dataDir: tempDir("contract-data"),
    pluginsDir: tempDir("contract-plugins"),
    env: testBrokerEnv(b),
  });
  const registry = new McpRegistryService(openDatabase(":memory:"), config, captureLogger().logger);
  await registry.assertBrokerReachable();
  const created = await registry.upsert(docs, "contract");
  out.push(["upsert", created.store, created.missingSecrets]);
  await registry.setSecret("docs", "T", { value: "contract-secret-1" }, "contract");
  const entry = await registry.get("docs");
  out.push(["get", entry.missingSecrets, (entry.secrets ?? []).map((s) => s.name)]);
  out.push(["visible", (await registry.brokerServersFor("_admin", "catalog")).map((s) => s.id)]);
  out.push(["literal rejected before broker", await registry.upsert({ ...docs, id: "lit", transport: { type: "http", url: "https://x.example.com/mcp", headers: { Authorization: "Bearer abc" } } }, "c").then(() => "ok", (e: { status: number }) => e.status)]);
  await registry.remove("docs", "contract");
  out.push(["removed", await registry.get("docs").then(() => "found", (e: { status: number }) => e.status)]);
  return out;
}

const started: TestBroker[] = [];
afterAll(async () => {
  for (const b of started) await b.close();
  cleanupTempDirs();
});

describe("broker contract (fake vs real createBroker)", () => {
  it("관리 평면·데이터 평면이 같은 결과를 낸다", async () => {
    const real = await startRealBroker();
    const fake = await startFakeTestBroker();
    started.push(real, fake);
    const realLog = await scenario(real);
    const fakeLog = await scenario(fake);
    expect(fakeLog).toEqual(realLog);
    // 실제 broker 기준으로 기대값도 고정한다
    expect(realLog).toEqual([
      ["create", 201, ["T"]],
      ["update", 200],
      ["get", 200, "Docs"],
      ["hidden without secret", [200, []]],
      ["put secret", 204],
      ["secret set", [], ["T"], false],
      ["visible", [200, ["docs"]]],
      ["cosmetic edit keeps secret", 200, []],
      ["header name case keeps secret", 200, []],
      ["header change clears secret", 200, ["T"]],
      ["hidden after clear", [200, []]],
      ["literal credential", 400, "invalid_request"],
      ["npx", 400, "invalid_request"],
      ["reserved id", 400, "invalid_request"],
      ["plugin_root", 400, "invalid_request"],
      ["sandbox", 400, "invalid_request"],
      ["id mismatch", 400],
      ["secret for missing server", 404],
      ["delete", 204],
      ["delete again", 404],
      ["get deleted", 404],
    ]);
  });

  it("stdio 실행 대상 비교가 두 broker에서 같다 (plugin은 고정 경로를 써서 업데이트해도 비밀키가 남는다)", async () => {
    const real = await startRealBroker();
    const fake = await startFakeTestBroker();
    started.push(real, fake);
    const realLog = await stdioScenario(real);
    expect(await stdioScenario(fake)).toEqual(realLog);
    expect(realLog).toEqual([
      ["create", 201, ["GITHUB_TOKEN"]],
      ["put secret", 204],
      ["same target keeps secret", 200, []],
      ["env order keeps secret", 200, []],
      ["versioned path clears secret", 200, ["GITHUB_TOKEN"]],
      ["delete", 204],
    ]);
  });

  it("gateway registry 흐름이 두 broker에서 같다", async () => {
    const real = await startRealBroker();
    const fake = await startFakeTestBroker();
    started.push(real, fake);
    const realFlow = await registryFlow(real);
    expect(await registryFlow(fake)).toEqual(realFlow);
    expect(realFlow).toEqual([
      ["upsert", "broker", ["T"]],
      ["get", [], ["T"]],
      ["visible", ["docs"]],
      ["literal rejected before broker", 400],
      ["removed", 404],
    ]);
  });
});
