import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const effects = vi.hoisted(() => ({
  start: vi.fn(async () => ({ runId: "workflow-test" })),
  health: vi.fn(async () => ({ ok: true })),
  testAlert: vi.fn(async () => true),
  deliveries: vi.fn(async () => ({})),
  digests: vi.fn(async () => ({})),
}));
let handle: Db;
vi.mock("@/lib/db", () => ({ db: vi.fn(async () => handle) }));
vi.mock("workflow/api", () => ({ start: effects.start, getRun: vi.fn() }));
vi.mock("@/lib/health-check", () => ({ runHealthCheck: effects.health, sendTestAlert: effects.testAlert }));
vi.mock("@/lib/delivery", async (original) => ({ ...(await original<object>()), flushDeliveries: effects.deliveries }));
vi.mock("@/lib/slack-delivery", async (original) => ({ ...(await original<object>()), sendDailyDigests: effects.digests }));

import { claimCronTick } from "../lib/cron-lease";
import { db } from "../lib/db";
import { testDb } from "./helpers";

beforeAll(async () => {
  handle = await testDb();
});

beforeEach(async () => {
  await handle.delete(schema.cronLeases);
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-30T12:00:10Z"));
  vi.stubEnv("CRON_SECRET", "cron-test-secret");
  vi.stubEnv("FIRECRAWL_API_KEY", "test-key");
  vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test("the cron lease migration is safe to execute twice without losing claims", async () => {
  const migration = readFileSync(new URL("../packages/core/drizzle/20260930110000_cron_leases/migration.sql", import.meta.url), "utf8");
  expect(await claimCronTick(handle, "sweep")).toBe(true);
  await handle.execute(sql.raw(migration));
  await handle.execute(sql.raw(migration));
  expect(await claimCronTick(handle, "sweep")).toBe(false);
  expect(await handle.select().from(schema.cronLeases)).toHaveLength(1);
});

test("a database claim has one winner across concurrent callers, with independent routes and minutes", async () => {
  const winners = await Promise.all(Array.from({ length: 20 }, () => claimCronTick(handle, "sweep")));
  expect(winners.filter(Boolean)).toHaveLength(1);
  expect(await claimCronTick(handle, "sweep", new Date("2026-09-30T12:00:59.999Z"))).toBe(false);
  expect(await claimCronTick(handle, "trending")).toBe(true);
  expect(await claimCronTick(handle, "sweep", new Date("2026-09-30T12:01:00Z"))).toBe(true);
  expect(await claimCronTick(handle, "sweep", new Date("2026-09-30T12:00:00Z"))).toBe(false);
});

const cases = [
  { name: "accuracy", method: "GET", query: "" },
  { name: "announcements", method: "GET", query: "?force=1" },
  { name: "backfill-apollo", method: "POST", query: "" },
  { name: "backfill-dossiers", method: "POST", query: "" },
  { name: "company-newsrooms", method: "GET", query: "" },
  { name: "deliveries", method: "GET", query: "" },
  { name: "health", method: "GET", query: "" },
  { name: "publication-audit", method: "GET", query: "" },
  { name: "history-rounds", method: "POST", query: "" },
  { name: "slack-digest", method: "GET", query: "" },
  { name: "sweep", method: "GET", query: "?force=1" },
  { name: "trending", method: "GET", query: "?force=1" },
  { name: "verify-rounds", method: "GET", query: "" },
];

function request(name: string, method = "GET", query = "") {
  return new Request(`http://app.test/api/cron/${name}${query}`, {
    method,
    headers: { authorization: "Bearer cron-test-secret" },
  });
}

test("the lease cases cover every cron route", () => {
  expect(cases.map(({ name }) => name).sort()).toEqual(readdirSync(path.resolve(__dirname, "../app/api/cron")).sort());
});

describe.each(cases)("$method /api/cron/$name", ({ name, method, query }) => {
  test("overlapping requests launch work once and later requests for that tick skip", async () => {
    const route = await import(`../app/api/cron/${name}/route.ts`);
    const responses = await Promise.all(Array.from({ length: 5 }, () => route[method](request(name, method, query))));
    const bodies = await Promise.all(responses.map((response: Response) => response.json()));
    expect(responses.every((response: Response) => response.status === 200)).toBe(true);
    expect(bodies.filter((body) => body.skipped === "already claimed")).toHaveLength(4);
    const calls = Object.values(effects).map((effect) => effect.mock.calls.length);
    expect(calls.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
    expect(await (await route[method](request(name, method, query))).json()).toEqual({ ok: true, skipped: "already claimed" });
    expect(Object.values(effects).map((effect) => effect.mock.calls.length)).toEqual(calls);
  });
});

test.each(["enrich", "corroborate"])("the sweep's forced %s branch also claims the same tick", async (lane) => {
  const { GET } = await import("../app/api/cron/sweep/route");
  await GET(request("sweep", "GET", `?force=1&lane=${lane}`));
  expect(effects.start).toHaveBeenCalled();
  const calls = effects.start.mock.calls.length;
  expect(await (await GET(request("sweep", "GET", "?force=1"))).json()).toEqual({ ok: true, skipped: "already claimed" });
  expect(effects.start).toHaveBeenCalledTimes(calls);
});

test("accuracy GET and POST share a claim, including when parameters change", async () => {
  const { GET, POST } = await import("../app/api/cron/accuracy/route");
  await GET(request("accuracy"));
  expect(await (await POST(request("accuracy", "POST", "?remedies=0"))).json()).toEqual({ ok: true, skipped: "already claimed" });
  expect(effects.start).toHaveBeenCalledTimes(1);
});

test("a launch failure retains the claim because the workflow may already have started", async () => {
  const { GET } = await import("../app/api/cron/verify-rounds/route");
  effects.start.mockRejectedValueOnce(new Error("launch response lost"));
  await expect(GET(request("verify-rounds"))).rejects.toThrow("launch response lost");
  expect(await (await GET(request("verify-rounds"))).json()).toEqual({ ok: true, skipped: "already claimed" });
  expect(effects.start).toHaveBeenCalledTimes(1);
});

test("the next UTC minute can launch a new tick", async () => {
  const { GET } = await import("../app/api/cron/verify-rounds/route");
  await GET(request("verify-rounds"));
  vi.setSystemTime(new Date("2026-09-30T12:01:00Z"));
  expect((await (await GET(request("verify-rounds"))).json()).skipped).toBeUndefined();
  expect(effects.start).toHaveBeenCalledTimes(2);
});

test("backfill status requests do not claim a tick", async () => {
  for (const name of ["backfill-apollo", "backfill-dossiers", "history-rounds"]) {
    const { GET } = await import(`../app/api/cron/${name}/route.ts`);
    expect((await GET(request(name))).status).toBe(200);
  }
  expect(await handle.select().from(schema.cronLeases)).toEqual([]);
  expect(effects.start).not.toHaveBeenCalled();
});

test("health test alerts claim the tick even alongside dry=1", async () => {
  const { GET } = await import("../app/api/cron/health/route");
  await GET(request("health", "GET", "?test=1&dry=1"));
  expect(await (await GET(request("health", "GET", "?test=1"))).json()).toEqual({ ok: true, skipped: "already claimed" });
  expect(effects.testAlert).toHaveBeenCalledTimes(1);
});

test("health still probes and alerts when the lease store is unavailable", async () => {
  const { GET } = await import("../app/api/cron/health/route");
  vi.mocked(db).mockRejectedValueOnce(new Error("database unavailable"));
  expect((await GET(request("health"))).status).toBe(200);
  expect(effects.health).toHaveBeenCalledWith({ origin: "http://app.test", dry: false });
  vi.spyOn(handle, "insert").mockImplementationOnce(() => {
    throw new Error("lease table unavailable");
  });
  expect((await GET(request("health"))).status).toBe(200);
  expect(effects.health).toHaveBeenCalledTimes(2);
});

test("workflow launch routes fail closed when lease storage is unavailable", async () => {
  const { GET } = await import("../app/api/cron/verify-rounds/route");
  vi.mocked(db).mockRejectedValueOnce(new Error("database unavailable"));
  await expect(GET(request("verify-rounds"))).rejects.toThrow("database unavailable");
  expect(effects.start).not.toHaveBeenCalled();
});

test("dry runs, estimates, invalid requests, and unauthorized requests do not consume a tick", async () => {
  const accuracy = await import("../app/api/cron/accuracy/route");
  const health = await import("../app/api/cron/health/route");
  const sweep = await import("../app/api/cron/sweep/route");
  expect((await accuracy.GET(request("accuracy", "GET", "?dry=1"))).status).toBe(200);
  expect((await health.GET(request("health", "GET", "?dry=1"))).status).toBe(200);
  expect((await sweep.GET(request("sweep", "GET", "?backfill=2&estimate=1"))).status).toBe(200);
  expect((await sweep.GET(request("sweep", "GET", "?backfill=99"))).status).toBe(400);
  expect((await accuracy.GET(new Request("http://app.test/api/cron/accuracy"))).status).toBe(401);
  expect(await handle.select().from(schema.cronLeases)).toEqual([]);
  expect(effects.start).not.toHaveBeenCalled();
});
