process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { expect, test, vi } from "vitest";
import { testDb } from "./helpers";

vi.mock("@/lib/db", async () => ({ db: async () => (globalThis as { __db?: unknown }).__db }));
vi.mock("@/lib/dossier-check", () => ({ dossierCheckAvailable: () => true }));
vi.mock("@/lib/firecrawl", () => ({ getFirecrawl: () => ({ cancelAgent: async () => true }) }));

test("a company merged into another after it was queued is skipped, not dived", async () => {
  (globalThis as { __db?: unknown }).__db = await testDb();
  const { startDiveStep } = await import("@/workflows/dossiers");
  expect(await startDiveStep("gone.example", true)).toEqual({ skipped: "company merged into another" });
});

test("a dive whose company was merged away while it ran is recorded as skipped, not failed", async () => {
  (globalThis as { __db?: unknown }).__db = await testDb();
  const { finishDiveStep } = await import("@/workflows/dossiers");
  const result = { status: "completed", seconds: 30, creditsUsed: 40 } as unknown as Parameters<typeof finishDiveStep>[2];
  expect(await finishDiveStep("gone.example", "job", result, new Date().toISOString())).toMatchObject({
    status: "skipped",
    agentCredits: 40,
  });
});
