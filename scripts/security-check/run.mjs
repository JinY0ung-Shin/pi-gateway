#!/usr/bin/env node
// pi-gateway sandbox 보안 점검
//
// 살아 있는 sandboxd에 점검용 사용자 두 명(secchk-a, secchk-b)의 sandbox를 만들고, 그 안에서 실제로 격리를 깨려고 시도한 뒤
// 결과를 Markdown 리포트로 낸다. 각 차단 항목에는 "격리가 없었다면 새는 것이 보였을 것"을 보여주는
// 대조군을 함께 둔다 (대조군이 실패하면 그 점검은 무효로 본다).
//
// 의존성 없음 (Node 22 내장 모듈만). 운영 서버에서는 sandboxd 컨테이너 안에서 돌리는 것이 가장 쉽다:
//   docker compose exec -T sandboxd node --input-type=module - < scripts/security-check/run.mjs > security-report.md
// 호스트에서 직접:
//   node scripts/security-check/run.mjs --url http://127.0.0.1:7070 --secret-file /srv/pi-gateway/secrets/sandboxd/sandboxd_jwt_secret --out report.md
//
// 옵션
//   --url URL              sandboxd 주소 (기본 http://127.0.0.1:7070)
//   --secret-file PATH     sandboxd JWT 비밀키 파일 (기본 $SANDBOXD_JWT_SECRET_FILE, 또는 $SANDBOXD_JWT_SECRET)
//   --internal NAME:PORT   sandbox에서 닿으면 안 되는 내부 서비스 (여러 번 가능, 기본 gateway:8080 sandboxd:7070
//                          mcp-broker:7080 mcp-broker:7081). 이름은 이 스크립트가 도는 곳에서 IP로 바꿔 시험한다.
//   --egress HOST:PORT     대조군: SANDBOX_EGRESS_ALLOW에 있는 대상 하나. egress 프록시로 연결되는지 본다 (기본 없음)
//   --host-ip IP           sandbox에서 닿으면 안 되는 호스트 주소 (여러 번 가능). 호스트의 LAN·공인 주소(ip -4 addr)를 넣는다.
//                          sandbox에는 경로가 없으므로 egress 프록시가 이 주소를 거부하는지 본다.
//   --host-ports LIST      호스트 주소에서 확인할 포트 (기본 22,80,443,2375,2376,8080)
//   --lan HOST:PORT        사내망 대상 (여러 번 가능, IP 또는 도메인). 결과는 INFO로만 낸다 (SANDBOX_EGRESS_ALLOW 확인용)
//   --scan-secret-dir DIR  이 디렉토리의 파일 내용(비밀값)이 sandbox 어디에도 없는지 확인 (기본 /run/secrets)
//   --out PATH             리포트 파일 (기본 stdout)
//
// 종료 코드: 0 = 실패 없음, 1 = FAIL·INVALID·WARN 있음, 2 = 점검을 돌리지 못함

import { createHash, createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── 인자 ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = { url: "http://127.0.0.1:7070", internal: [], egress: null, scanDir: "/run/secrets", hostIps: [], hostPorts: [22, 80, 443, 2375, 2376, 8080], lan: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => {
    const v = args[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    return v;
  };
  if (a === "--url") opt.url = next().replace(/\/+$/, "");
  else if (a === "--secret-file") opt.secretFile = next();
  else if (a === "--internal") opt.internal.push(next());
  else if (a === "--egress") opt.egress = next();
  else if (a === "--host-ip") opt.hostIps.push(next());
  else if (a === "--host-ports") opt.hostPorts = next().split(",").map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  else if (a === "--lan") opt.lan.push(next());
  else if (a === "--scan-secret-dir") opt.scanDir = next();
  else if (a === "--out") opt.out = next();
  else if (a === "--help" || a === "-h") {
    process.stdout.write(readFileSync(new URL(import.meta.url)).toString().split("\n").filter((l) => l.startsWith("//")).join("\n") + "\n");
    process.exit(0);
  } else throw new Error(`unknown option ${a}`);
}
if (opt.internal.length === 0) opt.internal = ["gateway:8080", "sandboxd:7070", "mcp-broker:7080", "mcp-broker:7081"];

function loadSecret() {
  const file = opt.secretFile ?? process.env.SANDBOXD_JWT_SECRET_FILE;
  if (file) return readFileSync(file, "utf8").replace(/\r?\n$/, "");
  if (process.env.SANDBOXD_JWT_SECRET) return process.env.SANDBOXD_JWT_SECRET;
  throw new Error("no sandboxd secret: pass --secret-file or set SANDBOXD_JWT_SECRET_FILE");
}

// ── sandboxd 클라이언트 (packages/shared/src/internal-auth.ts와 같은 HS256 JWT) ──
const SECRET = loadSecret();
const b64url = (buf) => Buffer.from(buf).toString("base64url");
function token(sub) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iss: "pi-gateway:gateway", aud: "pi-gateway:sandboxd", sub, iat: now, exp: now + 120 }));
  const sig = createHmac("sha256", Buffer.from(SECRET, "utf8")).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/** sandboxd에 POST하고 응답 본문(텍스트)을 돌려준다 */
async function call(route, user, body) {
  const res = await fetch(`${opt.url}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token(user)}`, "content-type": "application/json" },
    body: JSON.stringify({ user, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${route} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

async function post(route, user, body) {
  const text = await call(route, user, body);
  return text ? JSON.parse(text) : {};
}

/** sandbox 안에서 명령을 실행하고 stdout을 모은다 (body: /v1/exec 요청에서 user를 뺀 것) */
async function exec(user, body) {
  let stdout = "";
  for (const line of (await call("/v1/exec", user, body)).split("\n")) {
    if (!line) continue;
    const ev = JSON.parse(line);
    if (ev.type === "stdout") stdout += Buffer.from(ev.data, "base64").toString("utf8");
    else if (ev.type === "error") throw new Error(`exec error ${ev.code}: ${ev.message}`);
  }
  return { stdout };
}

/** sandbox 안에서 bash 스크립트를 실행한다 */
const sh = (user, script, timeoutSec = 60) => exec(user, { argv: ["bash", "-c", script], timeoutSec });

/** sandbox 안에서 python 코드를 stdin으로 넘겨 실행한다 (따옴표 문제 없이) */
const py = (user, code, timeoutSec = 60) =>
  exec(user, { argv: ["python3", "-"], stdin: Buffer.from(code).toString("base64"), timeoutSec, maxOutputBytes: 64 * 1024 * 1024 });

// 파일시스템(/proc, /sys, /dev 제외)과 /proc/1/environ에서 24자 이상 토큰을 찾아 sha256(전체), sha256(앞 40자)를 출력한다.
// 토큰 문자에 "="와 "."를 넣지 않는다: KEY=value 줄에서도 value만 토큰이 되고, base64 패딩은 떨어진다.
const TOKEN_SCAN = `
import hashlib, os, re
pat = re.compile(rb"[A-Za-z0-9+/_-]{24,}")
seen = set()
def scan(data):
    for m in pat.finditer(data):
        t = m.group(0)
        for v in (t, t[:40]):
            if len(v) >= 24:
                seen.add(hashlib.sha256(v).hexdigest())
for root, dirs, files in os.walk("/", topdown=True):
    if root in ("/proc", "/sys", "/dev"):
        dirs[:] = []
        continue
    dirs[:] = [d for d in dirs if os.path.join(root, d) not in ("/proc", "/sys", "/dev")]
    for f in files:
        p = os.path.join(root, f)
        try:
            if os.path.islink(p) or not os.path.isfile(p) or os.path.getsize(p) > 16 * 1024 * 1024:
                continue
            with open(p, "rb") as fh:
                scan(fh.read())
        except OSError:
            pass
try:
    with open("/proc/1/environ", "rb") as fh:
        for kv in fh.read().split(b"\\0"):
            scan(kv.split(b"=", 1)[-1])
except OSError:
    pass
print("\\n".join(sorted(seen)))
`;

// ── 결과 기록 ───────────────────────────────────────────────────────
const results = [];
const details = [];
/**
 * @param {string} area
 * @param {string} check
 * @param {"PASS"|"FAIL"|"WARN"|"INFO"|"INVALID"} status
 * @param {string} evidence
 * @param {string} [control]
 */
function record(area, check, status, evidence, control = "—") {
  results.push({ area, check, status, evidence, control });
}
const detail = (title, text) => details.push({ title, text: text.trim().slice(0, 4000) });
const short = (s, n = 160) => s.replace(/\s+/g, " ").trim().slice(0, n) || "(출력 없음)";

const run = randomBytes(4).toString("hex");
// 사용자 이름을 고정해 점검할 때마다 workspace가 늘지 않게 한다 (점검 후 비운다)
const A = "secchk-a";
const B = "secchk-b";
const MARK = `pi-secchk-marker-${run}`;
/**
 * 대상마다 line(host, port)이 만든 셸 명령을 한 스크립트로 sandbox에서 돌리고,
 * 각 명령이 출력한 "host:port 결과" 줄을 Map으로 돌려준다. 이상한 대상은 건너뛴다.
 */
async function perTarget(user, targets, secs, line) {
  const valid = targets.filter(([h, p]) => /^[0-9A-Za-z.:-]+$/.test(h) && Number.isInteger(Number(p)));
  if (valid.length === 0) return new Map();
  const out = (await sh(user, valid.map(([h, p]) => line(h, p)).join("\n"), 30 + valid.length * (secs + 1))).stdout;
  const results = new Map();
  for (const l of out.split("\n")) {
    const [target, value] = l.trim().split(" ");
    if (target && value) results.set(target, value);
  }
  return results;
}

/**
 * sandbox 안에서 여러 대상에 직접 TCP 연결을 시도하고 상태를 돌려준다.
 * OPEN = 연결됨, REFUSED = 거절됨(RST, 네트워크로는 닿는다), FILTERED = 응답 없음(방화벽 DROP), NOROUTE = 경로 없음
 */
const probe = (user, targets, secs = 3) =>
  perTarget(
    user,
    targets,
    secs,
    (h, p) =>
      `err=$(timeout ${secs} bash -c 'exec 3<>/dev/tcp/${h}/${p}' 2>&1); rc=$?; if [ $rc -eq 0 ]; then s=OPEN; elif [ $rc -eq 124 ]; then s=FILTERED; elif printf '%s' "$err" | grep -qi unreachable; then s=NOROUTE; else s=REFUSED; fi; echo "${h}:${p} $s"`,
  );

const tcp = (host, port, secs = 3) =>
  `timeout ${secs} bash -c 'exec 3<>/dev/tcp/${host}/${port}' 2>/dev/null && echo OPEN || echo CLOSED`;

/** sandbox 안의 egress 프록시 주소 (sbx-proxy-bridge → egress-proxy의 unix socket) */
const PROXY = "http://127.0.0.1:3128";

/**
 * sandbox 안에서 egress 프록시로 각 대상에 CONNECT를 보내고 프록시의 응답 코드를 돌려준다.
 * 200 = 연결됨, 407 = 프록시가 거부함, 그 밖(502·503·000 등) = 프록시가 허용했지만 연결하지 못함(000은 응답 없음)
 */
const proxyCodes = (user, targets, secs = 15) =>
  perTarget(
    user,
    targets,
    secs,
    (h, p) => `echo "${h}:${p} $(curl -s -o /dev/null -p -x ${PROXY} --noproxy '' -w '%{http_connect}' --max-time ${secs} https://${h}:${p}/ 2>/dev/null)"`,
  );

async function main() {
  const started = new Date();
  await post("/v1/sandboxes/ensure", A, {});
  await post("/v1/sandboxes/ensure", B, {});

  // ── 1. workspace 격리 ─────────────────────────────────────────────
  await post("/v1/fs/write", A, { path: `secret-${run}.txt`, content: Buffer.from(MARK).toString("base64") });
  const aOwn = await sh(A, `cat /workspace/secret-${run}.txt`);
  const ctl1 = aOwn.stdout.includes(MARK);
  const bScan = await sh(
    B,
    `ls -A /workspace; find / -xdev -name 'secret-${run}*' 2>/dev/null; grep -rsl --exclude-dir=proc --exclude-dir=sys '${MARK}' / 2>/dev/null | head -5; echo SCAN-DONE`,
    120,
  );
  const leak1 = bScan.stdout.includes(`secret-${run}`) || bScan.stdout.split("\n").some((l) => l.startsWith("/") && !l.startsWith("/proc"));
  record(
    "workspace",
    "다른 사용자의 workspace 파일이 보이지 않는다 (find, grep -r 전체 검색)",
    !ctl1 ? "INVALID" : leak1 ? "FAIL" : "PASS",
    leak1 ? short(bScan.stdout) : "사용자 B의 sandbox에서 A의 파일 이름·내용을 찾지 못함",
    ctl1 ? "A 자신은 같은 파일을 읽음" : "A가 자기 파일을 읽지 못함",
  );

  const guesses = ["/srv/workspaces", "/host", "/var/lib/docker", "/data", "/app", "/run/secrets", "/workspace/.."];
  const g = await sh(B, guesses.map((p) => `[ -e '${p}' ] && echo "EXISTS ${p}" && ls -A '${p}' 2>&1 | head -5`).join("; ") + "; ls -A /; true");
  const exists = g.stdout.split("\n").filter((l) => l.startsWith("EXISTS ") && l !== "EXISTS /workspace/..");
  record(
    "workspace",
    "호스트 경로·다른 workspace 루트를 추측해도 없다",
    exists.length ? "FAIL" : "PASS",
    exists.length ? exists.join(", ") : `없음: ${guesses.filter((p) => p !== "/workspace/..").join(", ")}`,
  );
  const mounts = await sh(B, "awk '{print $5, $4}' /proc/self/mountinfo | sort");
  detail("sandbox mount 목록 (/proc/self/mountinfo: mount point, root)", mounts.stdout);
  // /usr/sbin/docker-init: --init이 넣는 init 바이너리 (읽기 전용)
  // /run/pi-proxy: egress 프록시 socket 볼륨 (읽기 전용)
  const allowedMounts = /^(\/|\/workspace|\/opt\/plugins|\/run\/pi-proxy|\/tmp|\/dev(\/.*)?|\/proc(\/.*)?|\/sys(\/.*)?|\/etc\/(hosts|hostname|resolv\.conf)|\/usr\/sbin\/docker-init)$/;
  const unexpected = mounts.stdout
    .split("\n")
    .map((l) => l.split(" ")[0])
    .filter((m) => m && !allowedMounts.test(m));
  record(
    "workspace",
    "mount는 /workspace(본인), /opt/plugins(ro), /run/pi-proxy(ro, 프록시 socket), /tmp 및 기본 시스템 mount뿐이다",
    unexpected.length ? "FAIL" : "PASS",
    unexpected.length ? `예상 밖 mount: ${unexpected.join(", ")}` : "예상한 mount만 있음",
  );

  // ── 2. 프로세스 격리 ─────────────────────────────────────────────
  await sh(A, "nohup sleep 7777 >/dev/null 2>&1 &");
  const aPs = await sh(A, "ps -eo args");
  const ctl2 = aPs.stdout.includes("sleep 7777");
  const bPs = await sh(B, "ps -eo user,pid,args; for p in /proc/[0-9]*; do cat $p/cmdline 2>/dev/null | tr '\\0' ' '; echo; done");
  detail("사용자 B sandbox의 프로세스 목록", bPs.stdout.split("\n").slice(0, 20).join("\n"));
  record(
    "process",
    "다른 사용자의 프로세스와 명령줄(/proc/<pid>/cmdline)이 보이지 않는다",
    !ctl2 ? "INVALID" : bPs.stdout.includes("sleep 7777") ? "FAIL" : "PASS",
    bPs.stdout.includes("sleep 7777") ? "B에서 A의 'sleep 7777'이 보임" : "B에는 자기 프로세스만 보임",
    ctl2 ? "A에서는 'sleep 7777'이 보임" : "A의 대조 프로세스를 띄우지 못함",
  );

  // ── 3. 환경변수·비밀값 ───────────────────────────────────────────
  const env1 = await sh(B, "cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n'; echo ---; env");
  detail("/proc/1/environ 과 env (sandbox B)", env1.stdout);
  const suspicious = env1.stdout
    .split("\n")
    .filter((l) => /^(?:[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|API_KEY|APIKEY|CREDENTIAL|KEK)[A-Z0-9_]*|ANTHROPIC_[A-Z_]+|OPENAI_[A-Z_]+)=/i.test(l));
  const probeValue = `probe-${run}`;
  const envCtl = await exec(B, { argv: ["bash", "-c", "cat /proc/self/environ | tr '\\0' '\\n'"], env: { PROBE_SECRET: probeValue } });
  const ctl3 = envCtl.stdout.includes(`PROBE_SECRET=${probeValue}`);
  record(
    "secrets",
    "sandbox 프로세스 환경에 비밀처럼 보이는 변수가 없다 (/proc/1/environ, env)",
    !ctl3 ? "INVALID" : suspicious.length ? "FAIL" : "PASS",
    suspicious.length ? suspicious.map((l) => l.split("=")[0]).join(", ") : "SECRET/TOKEN/KEY/PASSWORD 계열 변수 없음",
    ctl3 ? "일부러 넣은 PROBE_SECRET은 environ에서 읽힘" : "대조 변수를 읽지 못함",
  );

  // 이 스크립트가 아는 비밀값(sandboxd JWT 비밀키, --scan-secret-dir의 파일들)이 sandbox 어디에도 없는지.
  // 비밀값은 sandbox로 보내지 않는다: sandbox 안에서 긴 토큰들의 sha256만 계산해 받아 와서 여기서 비교한다.
  const secrets = [SECRET];
  try {
    for (const name of readdirSync(opt.scanDir)) {
      const p = join(opt.scanDir, name);
      try {
        if (statSync(p).isFile()) {
          const v = readFileSync(p, "utf8").trim();
          if (v.length >= 24) secrets.push(v);
        }
      } catch {
        // 읽을 수 없는 비밀은 건너뛴다
      }
    }
  } catch {
    // 디렉토리가 없으면 sandboxd 비밀키만 본다
  }
  const canary = randomBytes(36).toString("base64");
  await post("/v1/fs/write", B, { path: `.canary-${run}`, content: Buffer.from(`token=${canary}\n`).toString("base64") });
  const scan = await py(B, TOKEN_SCAN, 300);
  const found = new Set(scan.stdout.split("\n").filter(Boolean));
  const sha = (v) => createHash("sha256").update(v).digest("hex");
  const tokensOf = (v) => v.match(/[A-Za-z0-9+/_-]{24,}/g) ?? [];
  const hit = (v) => tokensOf(v).some((t) => [t, t.slice(0, 40)].some((x) => found.has(sha(x))));
  const ctl4 = hit(canary);
  const leaked = secrets.filter((v) => hit(v));
  await sh(B, `rm -f /workspace/.canary-${run}`);
  record(
    "secrets",
    `알려진 비밀값 ${secrets.length}개(sandboxd JWT 키${secrets.length > 1 ? `, ${opt.scanDir}의 파일` : ""})가 sandbox 파일시스템과 /proc/1/environ에 없다`,
    !ctl4 ? "INVALID" : leaked.length ? "FAIL" : "PASS",
    leaked.length ? `${leaked.length}개 발견` : `토큰 ${found.size}개를 해시로 비교, 일치 없음 (비밀값은 sandbox로 보내지 않음)`,
    ctl4 ? "같은 방법으로 workspace에 넣어 둔 canary 토큰은 찾아냄" : "canary를 찾지 못함 (검색 방법 확인 필요)",
  );

  // ── 4. /etc ───────────────────────────────────────────────────────
  const etc = await sh(B, "ls -la /etc | head -80; echo ===passwd; cat /etc/passwd; echo ===group; cat /etc/group; echo ===hostname; cat /etc/hostname; hostname; echo ===hosts; cat /etc/hosts; echo ===resolv; cat /etc/resolv.conf; echo ===shadow; ls -la /etc/shadow /etc/gshadow 2>&1");
  detail("/etc 내용 (sandbox B)", etc.stdout);
  const passwdUsers = (etc.stdout.split("===passwd\n")[1] ?? "").split("===group")[0].trim().split("\n").map((l) => l.split(":")[0]).filter(Boolean);
  record(
    "etc",
    "/etc/passwd에는 root와 agent만 있다 (다른 사용자·서버 계정이 없다)",
    passwdUsers.join(",") === "root,agent" ? "PASS" : "FAIL",
    `계정: ${passwdUsers.join(", ")}`,
  );
  const hostnameOk = /===hostname\nsandbox\nsandbox\n/.test(etc.stdout);
  record("etc", "hostname은 고정값 'sandbox'다 (서버 이름이 드러나지 않는다)", hostnameOk ? "PASS" : "FAIL", short(etc.stdout.split("===hostname\n")[1]?.split("===hosts")[0] ?? ""));
  record(
    "etc",
    "/etc/shadow, /etc/gshadow가 없다",
    /No such file/.test(etc.stdout.split("===shadow")[1] ?? "") ? "PASS" : "WARN",
    short(etc.stdout.split("===shadow")[1] ?? ""),
  );

  // ── 5. 권한 ──────────────────────────────────────────────────────
  // no_new_privs는 prctl(PR_GET_NO_NEW_PRIVS=39)로 본다. 옛 gVisor(20260810 등)는 /proc/self/status에 NoNewPrivs 줄이 없다
  const priv = await sh(
    B,
    "echo uid=$(id -u) gid=$(id -g); grep -E '^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|Seccomp):' /proc/self/status; echo no_new_privs=$(python3 -c 'import ctypes; print(ctypes.CDLL(None).prctl(39, 0, 0, 0, 0))'); echo setuid=$(find / -xdev -perm /6000 -type f 2>/dev/null | wc -l); (su -c id root </dev/null >/dev/null 2>&1 && echo SU=OK) || echo SU=DENIED; (sudo -n id >/dev/null 2>&1 && echo SUDO=OK) || echo SUDO=DENIED; (unshare -Ur true >/dev/null 2>&1 && echo USERNS=OK) || echo USERNS=DENIED; (mount -t tmpfs none /mnt >/dev/null 2>&1 && echo MOUNT=OK) || echo MOUNT=DENIED",
  );
  detail("권한 상태 (sandbox B)", priv.stdout);
  const capZero = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].every((c) => new RegExp(`^${c}:\\s*0+$`, "m").test(priv.stdout));
  record("privilege", "root가 아니다 (uid/gid 1000)", /uid=1000 gid=1000/.test(priv.stdout) ? "PASS" : "FAIL", short(priv.stdout.split("\n")[0] ?? ""));
  record("privilege", "capability가 하나도 없다 (Inh/Prm/Eff/Bnd/Amb 모두 0)", capZero ? "PASS" : "FAIL", short(priv.stdout.split("\n").filter((l) => l.startsWith("Cap")).join(" ")));
  record("privilege", "no_new_privs가 켜져 있다", /^no_new_privs=1$/m.test(priv.stdout) ? "PASS" : "FAIL", short(priv.stdout.match(/^no_new_privs=.*/m)?.[0] ?? ""));
  record("privilege", "setuid/setgid 실행 파일이 없다", /setuid=0\b/.test(priv.stdout) ? "PASS" : "FAIL", short(priv.stdout.match(/setuid=\d+/)?.[0] ?? ""));
  record(
    "privilege",
    "su·sudo·user namespace·mount로 권한을 얻을 수 없다",
    /SU=OK|SUDO=OK|USERNS=OK|MOUNT=OK/.test(priv.stdout) ? "FAIL" : "PASS",
    short(priv.stdout.split("\n").filter((l) => /^(SU|SUDO|USERNS|MOUNT)=/.test(l)).join(" ")),
  );
  record("privilege", "seccomp 필터가 걸려 있다", /Seccomp:\s*2/.test(priv.stdout) ? "PASS" : "WARN", short(priv.stdout.match(/Seccomp:.*/)?.[0] ?? ""));

  // ── 6. 쓰기 위치 ─────────────────────────────────────────────────
  const targets = ["/etc", "/usr/local/bin", "/opt/plugins", "/", "/var/tmp", "/root", "/home"];
  const w = await sh(
    B,
    targets.map((t) => `(touch '${t}/.w-${run}' 2>/dev/null && echo "WRITABLE ${t}" && rm -f '${t}/.w-${run}') || echo "DENIED ${t}"`).join("; ") +
      `; (touch /workspace/.w-${run} && rm /workspace/.w-${run} && echo CTL-WS) ; (touch /tmp/.w-${run} && rm /tmp/.w-${run} && echo CTL-TMP)`,
  );
  const writable = w.stdout.split("\n").filter((l) => l.startsWith("WRITABLE "));
  const ctl6 = w.stdout.includes("CTL-WS") && w.stdout.includes("CTL-TMP");
  record(
    "filesystem",
    `/workspace와 /tmp 밖에는 쓸 수 없다 (${targets.join(", ")})`,
    !ctl6 ? "INVALID" : writable.length ? "FAIL" : "PASS",
    writable.length ? writable.join(", ") : "모두 거부됨",
    ctl6 ? "/workspace, /tmp에는 쓸 수 있음" : "/workspace 또는 /tmp에 쓰지 못함",
  );
  const sock = await sh(B, "ls -la /var/run/docker.sock /run/docker.sock 2>&1; find / -xdev -name 'docker.sock' 2>/dev/null; echo DONE");
  const hasSock = /^srw/m.test(sock.stdout) || sock.stdout.split("\n").some((l) => l.endsWith("docker.sock") && l.startsWith("/"));
  record("filesystem", "docker.sock이 sandbox에 없다", hasSock ? "FAIL" : "PASS", hasSock ? short(sock.stdout) : "찾지 못함");

  // ── 7. 네트워크 ─────────────────────────────────────────────────
  // sandbox는 network_mode none이고, 바깥으로는 egress 프록시(127.0.0.1:3128 → unix socket)로만 나간다.
  // 대상마다 직접 연결과 프록시 경유(CONNECT)를 둘 다 시도한다.
  let ctlNet = null;
  if (opt.egress) {
    const [h, p] = opt.egress.split(":");
    ctlNet = (await proxyCodes(B, [[h, p]])).get(`${h}:${p}`) === "200";
  }
  const netCtlText =
    ctlNet === null
      ? "대조군 생략 (--egress로 허용 목록의 대상을 주면 확인한다)"
      : ctlNet
        ? `프록시로 ${opt.egress}에 접속됨`
        : `프록시로도 ${opt.egress}에 접속되지 않음 (허용 목록에 없거나, 대상이 꺼졌거나, egress-proxy가 멈춤)`;
  const codeList = (codes) => [...codes.entries()].map(([t, c]) => `${t}→${c}`).join(", ");

  for (const target of opt.internal) {
    const [name, port] = target.split(":");
    const byName = (await sh(B, `getent hosts ${name} || echo NORESOLVE; ${tcp(name, port)}`)).stdout;
    let ip = null;
    try {
      ip = (await lookup(name)).address;
    } catch {
      ip = null;
    }
    const byIp = ip ? (await sh(B, tcp(ip, port))).stdout.includes("OPEN") : false;
    const proxied = await proxyCodes(B, ip ? [[name, port], [ip, port]] : [[name, port]]);
    const viaProxy = [...proxied.entries()].filter(([, c]) => c === "200").map(([t]) => t);
    const open = byName.includes("OPEN") || byIp || viaProxy.length > 0;
    record(
      "network",
      `내부 서비스 ${target}에 닿지 않는다 (이름${ip ? ` 및 IP ${ip}` : ""}, 직접·프록시)`,
      open ? "FAIL" : "PASS",
      open
        ? `접속됨 (${viaProxy.length ? `프록시: ${viaProxy.join(", ")}` : byName.includes("OPEN") ? "직접, 이름" : "직접, IP"})`
        : `직접: 이름 해석 ${byName.includes("NORESOLVE") ? "안 됨" : "됨"}, 접속 안 됨 / 프록시: ${codeList(proxied)}`,
      netCtlText,
    );
  }

  // 허용 목록에 없는 목적지: 프록시가 연결하기 전에 거부해야 한다 (407). 인터넷이 막힌 곳에서도 판정할 수 있다
  const unlisted = [["1.1.1.1", 443], ["example.com", 443]];
  const unlistedCodes = await proxyCodes(B, unlisted);
  const notDenied = [...unlistedCodes.entries()].filter(([, c]) => c !== "407" && c !== "000");
  const noAnswer = unlisted.every(([h, p]) => (unlistedCodes.get(`${h}:${p}`) ?? "000") === "000");
  record(
    "network",
    `허용 목록에 없는 목적지는 프록시가 거부한다 (${unlisted.map(([h, p]) => `${h}:${p}`).join(", ")})`,
    notDenied.length ? "FAIL" : noAnswer ? "INVALID" : "PASS",
    notDenied.length
      ? `거부하지 않음: ${codeList(new Map(notDenied))} — SANDBOX_EGRESS_ALLOW 확인 (docs/OPERATIONS.md §6)`
      : noAnswer
        ? "프록시가 응답하지 않음 (egress-proxy가 멈춤)"
        : `프록시: ${codeList(unlistedCodes)}`,
    netCtlText,
  );

  const metaDirect = (await probe(B, [["169.254.169.254", 80]])).get("169.254.169.254:80") ?? "FILTERED";
  const metaProxy = (
    await sh(B, `curl -s -o /dev/null -x ${PROXY} --noproxy '' -w '%{http_code}' --max-time 15 http://169.254.169.254/latest/meta-data/ 2>/dev/null`)
  ).stdout.trim();
  // 407 = 프록시가 거부, 000 = 프록시 응답 없음. 그 밖의 코드는 프록시가 metadata로 연결을 시도했다는 뜻이다
  const metaBad = metaDirect === "OPEN" || !["407", "000"].includes(metaProxy);
  record(
    "network",
    "클라우드 metadata 주소(169.254.169.254:80)에 닿지 않는다 (직접·프록시)",
    metaBad ? "FAIL" : "PASS",
    metaBad
      ? `${metaDirect === "OPEN" ? "직접 접속됨" : `프록시가 거부하지 않음 (HTTP ${metaProxy})`} — egress-proxy 설정 확인 (docs/OPERATIONS.md §6)`
      : `직접: ${metaDirect === "NOROUTE" ? "경로 없음" : metaDirect === "FILTERED" ? "응답 없음" : "거절됨"} / 프록시: ${metaProxy === "407" ? "407 (거부)" : "응답 없음"}`,
    netCtlText,
  );

  // 다른 sandbox: sandbox마다 network namespace가 따로 있고 loopback 밖의 인터페이스가 없다
  await sh(A, "nohup python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 &");
  await new Promise((r) => setTimeout(r, 1500));
  const ctl7 = (await sh(A, tcp("127.0.0.1", 8765))).stdout.includes("OPEN");
  const sib = (await sh(B, tcp("127.0.0.1", 8765))).stdout.includes("OPEN");
  // /sys/class/net은 gVisor에 없으므로 /proc/net/dev로 본다
  const ifs = (await sh(B, "tail -n +3 /proc/net/dev | cut -d: -f1")).stdout.split(/\s+/).filter(Boolean);
  const others = ifs.filter((i) => i !== "lo");
  record(
    "network",
    "다른 사용자의 sandbox에 네트워크로 닿지 않는다 (network_mode none: 인터페이스는 lo뿐)",
    !ctl7 ? "INVALID" : sib || others.length ? "FAIL" : "PASS",
    `B의 인터페이스: ${ifs.join(", ") || "(없음)"}; B → 127.0.0.1:8765 ${sib ? "접속됨 (A와 같은 network namespace)" : "접속 안 됨"}`,
    ctl7 ? "A 자신은 127.0.0.1:8765(A의 서버)에 접속됨" : "A의 대조 서버에 접속하지 못함",
  );

  // 호스트 주소: 허용 목록에 넣지 않았다면 프록시가 모든 포트를 거부한다
  for (const ip of opt.hostIps) {
    const targets = opt.hostPorts.map((p) => [ip, p]);
    const direct = await probe(B, targets, 2);
    const codes = await proxyCodes(B, targets);
    const code = (p) => codes.get(`${ip}:${p}`) ?? "000";
    const directOpen = opt.hostPorts.filter((p) => direct.get(`${ip}:${p}`) === "OPEN");
    const open = opt.hostPorts.filter((p) => code(p) === "200");
    const tried = opt.hostPorts.filter((p) => !["200", "407"].includes(code(p)));
    record(
      "network",
      `호스트 주소 ${ip}에 닿지 않는다 (포트 ${opt.hostPorts.join(", ")}, 직접·프록시)`,
      directOpen.length || open.length ? "FAIL" : tried.length ? "WARN" : "PASS",
      directOpen.length
        ? `직접 접속됨: ${directOpen.join(", ")}`
        : open.length
          ? `프록시로 열린 포트 ${open.join(", ")} — SANDBOX_EGRESS_ALLOW에서 이 주소를 빼거나 필요한 포트만 적으세요 (docs/OPERATIONS.md §6)`
          : tried.length
            ? `열린 포트는 없지만 프록시가 이 주소를 막지 않는다 (${tried.map((p) => `${p}→${code(p)}`).join(", ")}) — SANDBOX_EGRESS_ALLOW에서 이 주소를 빼거나 필요한 포트만 적으세요`
            : "직접 경로 없음, 프록시가 모든 포트를 거부함 (407)",
      netCtlText,
    );
  }
  if (opt.hostIps.length === 0) {
    record(
      "network",
      "호스트의 LAN·공인 주소 점검",
      "INFO",
      "--host-ip로 호스트 주소를 주면 egress 프록시가 그 주소(공개 포트 포함)를 막는지 확인한다 (ip -4 addr show로 확인)",
    );
  }

  // 사내망(LAN): 허용 목록이 의도대로인지 보는 용도라 INFO로만 낸다
  if (opt.lan.length) {
    const lanTargets = opt.lan.map((t) => t.split(":")).filter((t) => t.length === 2);
    const codes = await proxyCodes(B, lanTargets);
    for (const [h, p] of lanTargets) {
      const c = codes.get(`${h}:${p}`) ?? "000";
      record(
        "network",
        `사내망 대상 ${h}:${p} (프록시)`,
        "INFO",
        c === "200" ? "접속됨 (허용됨)" : c === "407" ? "프록시가 거부함 (허용 목록에 없음)" : `프록시가 허용했지만 연결하지 못함 (${c})`,
      );
    }
  } else {
    record(
      "network",
      "사내망 접근",
      "INFO",
      "egress 프록시는 SANDBOX_EGRESS_ALLOW의 도메인·IP만 연다 (docs/OPERATIONS.md §6). --lan HOST:PORT로 대상을 지정해 확인한다",
    );
  }

  // ── 8. 참고 정보 ─────────────────────────────────────────────────
  const info = await sh(
    B,
    "echo kernel=$(uname -r); echo cpus=$(nproc); echo mem=$(awk '/MemTotal/ {print $2\" kB\"}' /proc/meminfo); echo memory.max=$(cat /sys/fs/cgroup/memory.max 2>/dev/null); echo pids.max=$(cat /sys/fs/cgroup/pids.max 2>/dev/null); echo cpu.max=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null); df -h /workspace /tmp | tail -2",
  );
  detail("자원 제한과 커널 정보 (sandbox B)", info.stdout);
  record("info", "자원 제한 (cgroup. gVisor에서는 sandbox 안에 보이지 않는다)", "INFO", short(info.stdout.split("\n").filter((l) => /^(memory|pids|cpu)\.max=/.test(l)).join(" ")));
  record(
    "info",
    "커널 버전·CPU·메모리 총량 (runc면 호스트 값이 보인다. SANDBOX_RUNTIME=runsc(gVisor)면 gVisor 값이 보인다)",
    "INFO",
    short(info.stdout.split("\n").filter((l) => /^(kernel|cpus|mem)=/.test(l)).join(" ")),
  );

  return { started, finished: new Date() };
}

function render(meta) {
  const count = (s) => results.filter((r) => r.status === s).length;
  const failed = count("FAIL") + count("INVALID") + count("WARN");
  const icon = { PASS: "✅ PASS", FAIL: "❌ FAIL", WARN: "⚠️ WARN", INFO: "ℹ️ INFO", INVALID: "❓ INVALID" };
  const areaName = {
    workspace: "workspace 격리",
    process: "프로세스 격리",
    secrets: "비밀값",
    etc: "/etc 정보",
    privilege: "권한",
    filesystem: "파일시스템",
    network: "네트워크",
    info: "참고",
  };
  const lines = [];
  lines.push("# pi-gateway sandbox 보안 점검 리포트", "");
  lines.push("## 요약", "");
  lines.push(`- 결과: **${failed === 0 ? "통과" : "실패"}** — PASS ${count("PASS")}, FAIL ${count("FAIL")}, WARN ${count("WARN")}, INVALID ${count("INVALID")}, INFO ${count("INFO")}`);
  lines.push(`- 점검 시각: ${meta.started.toISOString()} ~ ${meta.finished.toISOString()}`);
  lines.push(`- 대상: sandboxd ${opt.url}, 점검용 사용자 \`${A}\`, \`${B}\` (점검 후 workspace 비움)`);
  lines.push("- 방법: 각 사용자 sandbox 안에서 실제 명령으로 접근을 시도했다. 차단 항목마다 대조군(격리가 없으면 보였을 것)을 함께 확인했다. 대조군이 실패한 항목은 INVALID로 표시하고 실패로 센다.", "");
  lines.push("## 결과", "");
  lines.push("| 영역 | 점검 | 결과 | 근거 | 대조군 |", "|---|---|---|---|---|");
  for (const r of results) {
    const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${areaName[r.area] ?? r.area} | ${esc(r.check)} | ${icon[r.status]} | ${esc(r.evidence)} | ${esc(r.control)} |`);
  }
  lines.push("", "## 상세 출력", "");
  for (const d of details) lines.push(`### ${d.title}`, "", "```", d.text, "```", "");
  lines.push("## 해석", "");
  lines.push("- sandbox 안에서 보이는 `/etc`는 sandbox 이미지의 최소한의 파일이다. 운영 서버나 gateway의 `/etc`가 아니다.");
  lines.push("- LLM 키와 MCP 키는 sandbox에 처음부터 존재하지 않는다 (gateway·mcp-broker 컨테이너에만 있다).");
  lines.push("- sandbox에는 네트워크가 없고(network_mode none) egress 프록시로만 나간다. WARN 항목은 허용 목록(SANDBOX_EGRESS_ALLOW)에서 그 주소를 빼거나 포트를 좁혀 막는다 (docs/OPERATIONS.md \"네트워크 차단 규칙\").");
  return { text: lines.join("\n") + "\n", failed };
}

let exitCode = 0;
try {
  const meta = await main();
  const { text, failed } = render(meta);
  if (opt.out) writeFileSync(opt.out, text);
  else process.stdout.write(text);
  const summary = results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
  process.stderr.write(`security-check: ${failed === 0 ? "OK" : "FAILED"} ${JSON.stringify(summary)}\n`);
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  process.stderr.write(`security-check could not run: ${err instanceof Error ? err.message : err}\n`);
  exitCode = 2;
} finally {
  for (const u of [A, B]) await sh(u, "find /workspace -mindepth 1 -delete 2>/dev/null; true").catch(() => undefined);
}
process.exit(exitCode);
