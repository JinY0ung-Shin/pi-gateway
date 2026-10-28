import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, last, startHarness } from "./helpers.js";

const PERSON_SCHEMA = {
  type: "object",
  properties: { name: { type: "string" }, age: { type: "integer" } },
  required: ["name", "age"],
  additionalProperties: false,
};
const FORMAT = { text: { format: { type: "json_schema", name: "person", schema: PERSON_SCHEMA, strict: true } } };
const ADA = { name: "Ada", age: 36 };

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe("text.format json_schema", () => {
  it("returns the StructuredOutput arguments as structured_output and output_text (non-stream)", async () => {
    h.llm.enqueue({ text: "Here it is.", toolCalls: [{ id: "call_so_1", name: "StructuredOutput", arguments: ADA }] });
    const before = h.llm.requests.length;
    const res = await h.post({ input: "Extract the person", ...FORMAT });
    expect(res.status).toBe(200);
    // terminate: 호출 뒤에 LLM을 다시 부르지 않는다
    expect(h.llm.requests.length - before).toBe(1);
    const tool = h.llm.requests.at(-1)!.tools!.find((t: any) => t.function.name === "StructuredOutput")!;
    expect(tool.function.parameters).toMatchObject(PERSON_SCHEMA);
    expect(res.json.status).toBe("completed");
    expect(res.json.structured_output).toEqual(ADA);
    // 앞에 쓴 문장은 빼고 JSON만 둔다
    expect(res.json.output[0].content[0].text).toBe(JSON.stringify(ADA));

    // 같은 스키마로 이어가면 통과, 다른 스키마면 400
    h.llm.enqueue({ toolCalls: [{ id: "call_so_2", name: "StructuredOutput", arguments: { name: "Bob", age: 7 } }] });
    const next = await h.post({ input: "Another", previous_response_id: res.json.id, ...FORMAT });
    expect(next.status).toBe(200);
    expect(next.json.structured_output).toEqual({ name: "Bob", age: 7 });
    const changed = await h.post({
      input: "x",
      previous_response_id: next.json.id,
      text: { format: { type: "json_schema", name: "other", schema: { type: "object", properties: {} } } },
    });
    expect(changed.status).toBe(400);
  });

  it("puts structured_output on response.completed (stream)", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "call_so_3", name: "StructuredOutput", arguments: ADA }] });
    const res = await h.stream({ input: "Extract", ...FORMAT });
    const completed = last(res.events);
    expect(completed.type).toBe("response.completed");
    expect((completed.data.response as any).structured_output).toEqual(ADA);
  });

  it("lets the model retry after arguments that do not match the schema", async () => {
    h.llm.enqueue(
      { toolCalls: [{ id: "call_so_bad", name: "StructuredOutput", arguments: { name: "Ada" } }] },
      { toolCalls: [{ id: "call_so_ok", name: "StructuredOutput", arguments: ADA }] },
    );
    const res = await h.post({ input: "Extract", ...FORMAT });
    expect(res.json.structured_output).toEqual(ADA);
  });

  it("fails when the model ends without calling StructuredOutput", async () => {
    h.llm.enqueue({ text: "Ada, 36" });
    const res = await h.post({ input: "Extract", ...FORMAT });
    expect(res.status).toBe(502);
    expect(res.json.error.message).toContain("StructuredOutput");
  });

  it("rejects unsupported formats and non-object schemas", async () => {
    expect((await h.post({ input: "x", text: { format: { type: "json_object" } } })).status).toBe(400);
    expect((await h.post({ input: "x", text: { format: { type: "json_schema", schema: { type: "array" } } } })).status).toBe(400);
  });

  it("does not add the tool without text.format", async () => {
    h.llm.enqueue({ text: "hi" });
    const res = await h.post({ input: "hi" });
    expect(res.json.structured_output).toBeNull();
    expect(h.llm.requests.at(-1)!.tools!.map((t: any) => t.function.name)).not.toContain("StructuredOutput");
  });
});
