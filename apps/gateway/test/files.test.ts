import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE_KEY, BOB_KEY, type Harness, last, ofType, SERVICE_KEY, startHarness } from "./helpers.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
  const ws = h.sandbox.workspaceOf("alice");
  mkdirSync(join(ws, "out"), { recursive: true });
  writeFileSync(join(ws, "out", "chart.png"), PNG);
  writeFileSync(join(ws, "report.html"), "<script>alert(1)</script>");
});
afterAll(async () => {
  await h.close();
});

const download = (query: string, key = ALICE_KEY) =>
  fetch(`${h.url}/v1/files/content?${query}`, { headers: { authorization: `Bearer ${key}` } });

describe("present_file", () => {
  it("streams a file item between text items and lists it in the final output", async () => {
    h.llm.enqueue({ text: "Here is the chart.", toolCalls: [{ id: "call_pf_1", name: "present_file", arguments: { path: "out/chart.png" } }] }, { text: "Done." });
    const res = await h.stream({ input: "draw a chart" });

    const file = { type: "file", path: "/workspace/out/chart.png", filename: "chart.png", mime_type: "image/png", size: PNG.length };
    const added = ofType(res.events, "response.output_item.added").map((e) => e.data.item as any);
    expect(added.map((i) => i.type)).toEqual(["message", "file", "message"]);
    expect(added[1]).toMatchObject(file);
    expect(added[1].id).toMatch(/^file_/);
    expect(ofType(res.events, "response.tool_result")[0]!.data).toMatchObject({ tool_use_id: "call_pf_1", is_error: false });

    const completed = last(res.events);
    expect(completed.type).toBe("response.completed");
    const output = (completed.data.response as any).output;
    expect(output.map((i: any) => i.type)).toEqual(["message", "file", "message"]);
    expect(output[1]).toEqual(added[1]);
  });

  it("puts file items after the message in non-streaming output", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "call_pf_2", name: "present_file", arguments: { path: "/workspace/report.html" } }] }, { text: "Done." });
    const res = await h.post({ input: "make a report" });
    expect(res.status).toBe(200);
    expect(res.json.output.map((i: any) => i.type)).toEqual(["message", "file"]);
    expect(res.json.output[1]).toMatchObject({ path: "/workspace/report.html", mime_type: "text/html" });
  });

  it("returns a tool error and no file item for a missing file or a path outside /workspace", async () => {
    h.llm.enqueue(
      {
        toolCalls: [
          { id: "call_pf_3", name: "present_file", arguments: { path: "missing.png" } },
          { id: "call_pf_4", name: "present_file", arguments: { path: "/etc/passwd" } },
        ],
      },
      { text: "Sorry." },
    );
    const res = await h.stream({ input: "show it" });
    expect(ofType(res.events, "response.tool_result").map((e) => e.data.is_error)).toEqual([true, true]);
    expect(ofType(res.events, "response.output_item.added").some((e) => (e.data.item as any).type === "file")).toBe(false);
  });
});

describe("GET /v1/files/content", () => {
  it("serves the user's workspace file with headers that keep HTML from running on the gateway origin", async () => {
    const res = await download("path=/workspace/out/chart.png");
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''chart.png");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    writeFileSync(join(h.sandbox.workspaceOf("alice"), "it's (1).png"), PNG);
    const quoted = await download(`path=${encodeURIComponent("it's (1).png")}`);
    expect(quoted.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''it%27s%20%281%29.png");

    const html = await download("path=report.html");
    expect(html.headers.get("content-type")).toMatch(/^text\/html/);
    expect(html.headers.get("content-security-policy")).toBe("sandbox");
  });

  it("reads only the caller's workspace", async () => {
    expect((await download("path=/workspace/out/chart.png", BOB_KEY)).status).toBe(404);
    expect((await download("path=/workspace/out/chart.png&user=alice", SERVICE_KEY)).status).toBe(200);
    expect((await download("path=/workspace/out/chart.png", SERVICE_KEY)).status).toBe(400);
  });

  it("rejects paths outside /workspace, directories and missing files", async () => {
    expect((await download("path=/etc/passwd")).status).toBe(400);
    expect((await download("path=/workspace/../etc/passwd")).status).toBe(400);
    expect((await download("path=/workspace/out")).status).toBe(400);
    expect((await download("path=/workspace/nope.png")).status).toBe(404);
    expect((await download("")).status).toBe(400);
  });

  it("requires an API key", async () => {
    const res = await fetch(`${h.url}/v1/files/content?path=/workspace/out/chart.png`);
    expect(res.status).toBe(401);
  });
});
