// The MCP route builds a server for every request, so callers that number their requests alike each get
// their own answers, and a tool call whose arguments hold more elements than any tool takes is refused
// before the SDK validates them one by one.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { expect, test } from "vitest";
import { POST as mcpPost } from "../app/api/mcp/route";

type Reply = { id: number; result: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> } };

/** One JSON-RPC request to the MCP route under the given id, the reply read out of its event stream. */
async function rpc(id: number, method: string, params: Record<string, unknown>): Promise<Reply> {
  const res = await mcpPost(
    new Request("http://app.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
  );
  const body = await res.text();
  const data = body.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(data ? data.slice(6) : body) as Reply;
}

test("concurrent callers that reuse a request id each get their own answer", async () => {
  const replies = await Promise.all(
    Array.from({ length: 6 }, (_, i) => (i % 2 ? rpc(1, "tools/call", { name: "list_presets", arguments: {} }) : rpc(1, "tools/list", {}))),
  );
  for (const [i, reply] of replies.entries()) {
    expect(reply.id).toBe(1);
    if (i % 2) expect(JSON.parse(reply.result.content?.[0]?.text ?? "{}").presets.length).toBeGreaterThan(0);
    else expect(reply.result.tools?.map((t) => t.name)).toContain("list_rounds");
  }
});

test("a call whose arguments hold more elements than any tool takes is refused", async () => {
  const stage = Array.from({ length: 100_000 }, () => "seed");
  const { result } = await rpc(1, "tools/call", { name: "list_rounds", arguments: { stage } });
  expect(result.isError).toBe(true);
  expect(result.content?.[0]?.text).toContain("more than the maximum of 256 elements");
});

test("the largest input a tool takes still fits under the limit", async () => {
  const ids = Array.from({ length: 200 }, (_, i) => `no-such-round-${i}`);
  const { result } = await rpc(1, "tools/call", { name: "mark_seen", arguments: { ids } });
  expect(result.isError ?? false).toBe(false);
  expect(JSON.parse(result.content?.[0]?.text ?? "{}")).toEqual({ updated: 0 });
});
