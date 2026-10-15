#!/usr/bin/env node
// 테스트용 최소 ripgrep: `rg --json [--ignore-case] [--fixed-strings] [--glob G] [--context N] -- PATTERN PATH`
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// 가짜 sandbox 안에서는 /workspace가 이 머신의 임시 디렉토리다.
const WS = process.env.FAKE_SANDBOX_WS;
const toHost = (p) => (WS && (p === "/workspace" || p.startsWith("/workspace/")) ? join(WS, relative("/workspace", p)) : p);
const toSandbox = (p) => (WS && p.startsWith(WS) ? join("/workspace", relative(WS, p)) : p);

const args = process.argv.slice(2);
let ignoreCase = false;
let fixed = false;
let context = 0;
let i = 0;
for (; i < args.length; i++) {
  const a = args[i];
  if (a === "--") break;
  if (a === "--ignore-case") ignoreCase = true;
  else if (a === "--fixed-strings") fixed = true;
  else if (a === "--context") context = Number(args[++i]);
  else if (a === "--glob") i++;
}
const pattern = args[i + 1];
const target = args[i + 2];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const re = new RegExp(fixed ? escape(pattern) : pattern, ignoreCase ? "i" : "");

const files = [];
const walk = (p) => {
  const st = statSync(p);
  if (st.isDirectory()) for (const name of readdirSync(p).sort()) walk(join(p, name));
  else files.push(p);
};
walk(toHost(target));

let matches = 0;
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  const emitted = new Set();
  lines.forEach((line, idx) => {
    if (!re.test(line)) return;
    matches++;
    for (let c = Math.max(0, idx - context); c <= Math.min(lines.length - 1, idx + context); c++) {
      if (emitted.has(c)) continue;
      emitted.add(c);
      const type = c === idx || re.test(lines[c]) ? "match" : "context";
      process.stdout.write(`${JSON.stringify({ type, data: { path: { text: toSandbox(file) }, lines: { text: `${lines[c]}\n` }, line_number: c + 1 } })}\n`);
    }
  });
}
process.exit(matches > 0 ? 0 : 1);
