#!/usr/bin/env node
// sandboxd API를 통한 도구 실행 지연을 잰다 (gateway가 실제로 겪는 지연). 의존성 없음.
//
// 운영 sandboxd 컨테이너 안에서:
//   docker compose exec -T sandboxd node --input-type=module - < scripts/bench/sandboxd-latency.mjs
// 호스트에서:
//   node scripts/bench/sandboxd-latency.mjs --url http://127.0.0.1:7070 --secret-file /srv/pi-gateway/secrets/sandboxd_jwt_secret
//
// 측정: 컨테이너 생성(첫 요청), exec(true), bash -c, fs read/write/stat/list/glob 각각의 중앙값·p90.
// 임시 사용자 sandbox를 만들고 끝나면 workspace까지 지운다.
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
let url = "http://127.0.0.1:7070";
let secretFile = process.env.SANDBOXD_JWT_SECRET_FILE;
let rounds = 20;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--url") url = args[++i].replace(/\/+$/, "");
  else if (args[i] === "--secret-file") secretFile = args[++i];
  else if (args[i] === "--rounds") rounds = Number(args[++i]);
}
const SECRET = secretFile ? readFileSync(secretFile, "utf8").replace(/\r?\n$/, "") : process.env.SANDBOXD_JWT_SECRET;
if (!SECRET) {
  console.error("pass --secret-file or set SANDBOXD_JWT_SECRET_FILE");
  process.exit(2);
}
const token = (sub) => {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc({ iss: "pi-gateway:gateway", aud: "pi-gateway:sandboxd", sub, iat: now, exp: now + 120 });
  return `${head}.${body}.${createHmac("sha256", Buffer.from(SECRET)).update(`${head}.${body}`).digest("base64url")}`;
};
const user = `bench-${randomBytes(4).toString("hex")}`;
async function call(route, body) {
  const res = await fetch(`${url}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token(user)}`, "content-type": "application/json" },
    body: JSON.stringify({ user, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${route} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text;
}
async function timed(fn) {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `median ${q(0.5).toFixed(1)}ms  p90 ${q(0.9).toFixed(1)}ms  min ${s[0].toFixed(1)}ms`;
};

try {
  console.log(`sandboxd ${url}, ${rounds}회씩`);
  console.log(`컨테이너 생성 (첫 ensure): ${(await timed(() => call("/v1/sandboxes/ensure", {}))).toFixed(0)}ms`);
  const cases = {
    "exec true": () => call("/v1/exec", { argv: ["true"] }),
    "exec bash -c 'echo hi'": () => call("/v1/exec", { argv: ["bash", "-c", "echo hi"] }),
    "fs write 4KB": () => call("/v1/fs/write", { path: "bench/f.txt", content: Buffer.alloc(4096, 97).toString("base64") }),
    "fs read 4KB": () => call("/v1/fs/read", { path: "bench/f.txt" }),
    "fs stat": () => call("/v1/fs/stat", { path: "bench" }),
    "fs list": () => call("/v1/fs/list", { path: "bench" }),
    "fs glob *.txt": () => call("/v1/fs/glob", { pattern: "*.txt" }),
  };
  for (const [name, fn] of Object.entries(cases)) {
    await fn();
    const xs = [];
    for (let i = 0; i < rounds; i++) xs.push(await timed(fn));
    console.log(`${name.padEnd(26)} ${stats(xs)}`);
  }
} finally {
  await call("/v1/sandboxes/remove", { deleteWorkspace: true }).catch(() => undefined);
}
