import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import type { Logger } from "pino";
import { z } from "zod";
import { READ_PAGE_BYTES, WikiError, type WikiStore } from "./wiki.js";

/**
 * wiki를 다루는 MCP 도구. 누구의 wiki인지는 인자에 없다: 부르는 쪽이 만든 URL에서 정해진다 (app.ts).
 * 설명과 오류 문구는 모델이 읽으므로 영어로 쓴다.
 */

/** list 결과의 최대 크기. read와 같은 이유로 gateway가 자르는 크기(50KB)보다 작게 둔다. */
const LIST_BUDGET_BYTES = READ_PAGE_BYTES;
/** 검색 결과에 싣는 제목·태그의 최대 길이 (노트가 정하는 값이라 길 수 있다) */
const LABEL_CHARS = 200;
const clip = (value: string) => (value.length > LABEL_CHARS ? `${value.slice(0, LABEL_CHARS)}…` : value);

const pathArg = z.string().describe("Note path relative to the wiki root, ending in .md (e.g. projects/deploy.md).");
const hashArg = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "a hash is the 64 hex characters after `hash:`")
  .describe("The note's `hash`: the `hash:` line of the last read, or the hash the last write/edit of this note returned.");
const prefixArg = z.string().optional().describe("Only notes under this folder (e.g. projects). Omit for the whole wiki.");

interface MemoryTool {
  tool: Tool;
  call(store: WikiStore, owner: string, args: unknown): Promise<string>;
}

function define<S extends z.ZodType>(
  name: string,
  description: string,
  input: S,
  run: (store: WikiStore, owner: string, args: z.infer<S>) => Promise<string>,
): MemoryTool {
  const { $schema: _draft, ...inputSchema } = z.toJSONSchema(input);
  return {
    tool: { name, description, inputSchema: inputSchema as Tool["inputSchema"] },
    call: (store, owner, args) => run(store, owner, input.parse(args ?? {})),
  };
}

const TOOLS: MemoryTool[] = [
  define(
    "search",
    "Search your long-term memory: the notes kept for this user across sessions. Call it before answering anything that may depend on what was learned earlier (the user's preferences, past decisions, people, projects). Ranks notes by keyword hits in title and aliases, then tags, then body; each hit gives the note path and a snippet. Read a hit in full with `read`.",
    z.object({
      query: z.string().min(1).max(500).describe("Keywords to look for."),
      limit: z.number().int().min(1).max(20).optional().describe("Max notes to return (default 8)."),
      prefix: prefixArg,
    }),
    async (store, owner, { query, limit, prefix }) => {
      const { hits, unscanned } = await store.search(owner, query, limit, prefix);
      const partial =
        unscanned > 0
          ? `\n\nNOT A FULL SEARCH: this wiki holds more notes than one search covers — ${unscanned} note(s) (the last ones in path order) were NOT searched. A miss does not mean the wiki lacks it: narrow the search with \`prefix\`, or use list and read.`
          : "";
      if (hits.length === 0) return `No notes matched "${query}".${partial}`;
      const lines = hits.map((h) => `- ${h.path}${h.tags.length ? ` [${clip(h.tags.join(", "))}]` : ""}: ${clip(h.title)}\n  ${h.snippet}`);
      return `Top ${hits.length} note(s) for "${query}":\n${lines.join("\n")}${partial}`;
    },
  ),
  define(
    "list",
    "List the note paths in this user's long-term memory wiki, optionally only those under a folder.",
    z.object({ prefix: prefixArg }),
    async (store, owner, { prefix }) => {
      const notes = await store.list(owner, prefix);
      if (notes.length === 0) return prefix ? `No notes under ${prefix}.` : "This wiki has no notes yet.";
      const shown: string[] = [];
      let size = 0;
      for (const n of notes) {
        const line = `- ${n.path} (${n.bytes} bytes)`;
        size += Buffer.byteLength(line) + 1;
        if (size > LIST_BUDGET_BYTES) break;
        shown.push(line);
      }
      const more = notes.length > shown.length ? `\n…and ${notes.length - shown.length} more (in path order). Narrow the list with \`prefix\`.` : "";
      return `${notes.length} note(s):\n${shown.join("\n")}${more}`;
    },
  ),
  define(
    "read",
    "Read one note of this user's long-term memory wiki. The result starts with the note's `hash`, which write, edit and delete need in order to change this note. A long note comes back in parts: the `part:` line says how to read the next one.",
    z.object({
      path: pathArg,
      offset: z.number().int().min(0).optional().describe("Where to continue a long note from: the offset the previous read of this note gave. Omit to read from the start."),
      hash: hashArg.optional().describe("Needed with `offset`: the `hash:` line of the previous part. If the note changed since then, the read is refused."),
    }),
    async (store, owner, { path, offset, hash }) => {
      const note = await store.read(owner, path, offset, hash);
      const whole = note.offset === 0 && note.next === null;
      const part = whole
        ? ""
        : `part: bytes ${note.offset}–${note.offset + Buffer.byteLength(note.content)} of ${note.total}. ${
            note.next === null ? "This is the end of the note." : `MORE REMAINS: read again with offset ${note.next} and this hash.`
          } This note is too long to replace with write; change it with edit.\n`;
      return `path: ${note.path}\nhash: ${note.hash}\n${part}\n${note.content}`;
    },
  ),
  define(
    "write",
    "Save a note to this user's long-term memory wiki so that later sessions can find it. A new path creates the note. To replace an existing note, pass the `hash` from reading it; a note that changed since it was read is refused, never overwritten, and a note too long to read in one part can only be changed with edit. Notes are markdown; a frontmatter block with `title`, `tags` and `aliases` makes a note easier to find.",
    z.object({
      path: pathArg,
      content: z.string().describe("The whole note, as markdown."),
      hash: hashArg.optional(),
    }),
    async (store, owner, { path, content, hash }) => {
      const saved = await store.write(owner, path, content, hash);
      return `${saved.created ? "Created" : "Replaced"} ${saved.path}.\nhash: ${saved.hash}`;
    },
  ),
  define(
    "edit",
    "Change part of an existing note in this user's long-term memory wiki: replace one exact snippet with new text. `old_text` must occur exactly once in the note. Needs the note's current `hash`.",
    z.object({
      path: pathArg,
      old_text: z.string().min(1).describe("The exact text to replace, copied from the note."),
      new_text: z.string().describe("The text to put in its place."),
      hash: hashArg,
    }),
    async (store, owner, { path, old_text, new_text, hash }) => {
      const saved = await store.edit(owner, path, old_text, new_text, hash);
      return `Saved ${saved.path}.\nhash: ${saved.hash}`;
    },
  ),
  define(
    "delete",
    "Delete a note from this user's long-term memory wiki. Needs the note's current `hash`.",
    z.object({ path: pathArg, hash: hashArg }),
    async (store, owner, { path, hash }) => `Deleted ${(await store.delete(owner, path, hash)).path}.`,
  ),
];

export const TOOL_LIST: Tool[] = TOOLS.map((t) => t.tool);

const text = (value: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });

/** 도구 하나를 실행한다. 거절과 실패는 모두 오류 결과로 돌려준다 (빈 결과로 바꾸지 않는다). */
export async function callTool(store: WikiStore, owner: string, name: string, args: unknown, log: Logger): Promise<CallToolResult> {
  const found = TOOLS.find((t) => t.tool.name === name);
  if (!found) return text(`unknown_tool: this memory server has no tool '${name}'`, true);
  try {
    return text(await found.call(store, owner, args));
  } catch (err) {
    if (err instanceof WikiError) return text(`${err.code}: ${err.message}`, true);
    if (err instanceof z.ZodError) {
      return text(`invalid_arguments: ${err.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ")}`, true);
    }
    log.error({ err, tool: name }, "memory tool failed");
    return text("internal: the memory store failed. This is NOT an empty result: do not conclude that nothing is stored; tell the user memory is unavailable right now.", true);
  }
}
