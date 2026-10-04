// Every write path against a demo visitor. Each exported server function is a POST anyone can aim
// at any page, whatever the UI rendered, so the sweep here calls all of them with no credentials
// and expects a refusal before the store opens or Firecrawl is reached. The one read a visitor may
// run (the command palette's search) is the allowlist. Then the route handlers that write: the
// Research route and the Slack install pair (the MCP server's mark_seen is in demo.test.ts). The
// Slack manage actions are the one token-gated exception: no password, but no valid manage token
// means a refusal before the store opens too. The inventory at the top keeps the sweep honest: a new
// "use server" file or route handler fails it until it is listed with its guard.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const auth = vi.hoisted(() => ({ header: null as string | null }));
const opened = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({
  headers: async () => new Headers(auth.header ? { authorization: auth.header } : {}),
}));
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  updateTag: () => {},
  cacheLife: () => {},
  cacheTag: () => {},
}));
vi.mock("workflow/api", () => ({ start: vi.fn(async () => undefined) }));
vi.mock("@/lib/db", () => ({
  db: async () => {
    opened();
    throw new Error("the store opened");
  },
}));
vi.mock("@/lib/firecrawl", () => ({
  getFirecrawl: () => {
    throw new Error("Firecrawl was reached");
  },
}));
vi.mock("@/lib/directory", () => ({ searchDirectory: async () => ({ companies: [], investors: [] }) }));

import * as companyActions from "../app/(dashboard)/companies/actions";
import * as presetActions from "../app/(dashboard)/presets/actions";
import * as reviewActions from "../app/(dashboard)/review/actions";
import { POST as researchPost } from "../app/(dashboard)/review/research/route";
import * as searchActions from "../app/(dashboard)/search/actions";
import * as settingsActions from "../app/(dashboard)/settings/actions";
import * as slackManageActions from "../app/(slack)/slack/actions";
import * as rootActions from "../app/actions";
import { GET as slackInstall } from "../app/api/slack/install/route";
import { GET as slackCallback } from "../app/api/slack/oauth/callback/route";

const MODULES = {
  "app/actions": rootActions,
  "companies/actions": companyActions,
  "presets/actions": presetActions,
  "review/actions": reviewActions,
  "search/actions": searchActions,
  "settings/actions": settingsActions,
};

/** The files behind MODULES and the token-gated manage actions: a new "use server" file fails the inventory until it joins one. */
const SWEPT_FILES = [
  "app/actions.ts",
  "app/(dashboard)/companies/actions.ts",
  "app/(dashboard)/presets/actions.ts",
  "app/(dashboard)/review/actions.ts",
  "app/(dashboard)/search/actions.ts",
  "app/(dashboard)/settings/actions.ts",
  "app/(slack)/slack/actions.ts",
];

/**
 * Every route handler, with the guard each method carries. A new route fails the inventory test until
 * it is listed here, so adding one is a decision about who may call it, not an accident of the matcher.
 */
const ROUTE_GUARDS: Record<string, Record<string, string>> = {
  "app/(dashboard)/review/research/route.ts": { POST: "same origin, then requireDashboard" },
  "app/api/cache/invalidate/route.ts": { POST: "CRON_SECRET bearer, closed without a secret" },
  "app/api/cron/accuracy/route.ts": { GET: "CRON_SECRET", POST: "CRON_SECRET" },
  "app/api/cron/announcements/route.ts": { GET: "CRON_SECRET" },
  "app/api/cron/backfill-apollo/route.ts": { GET: "CRON_SECRET", POST: "CRON_SECRET" },
  "app/api/cron/backfill-dossiers/route.ts": { GET: "CRON_SECRET", POST: "CRON_SECRET" },
  "app/api/cron/company-newsrooms/route.ts": { GET: "CRON_SECRET" },
  "app/api/cron/deliveries/route.ts": { GET: "CRON_SECRET" },
  "app/api/cron/health/route.ts": { GET: "CRON_SECRET" },
  "app/api/cron/history-rounds/route.ts": { GET: "CRON_SECRET", POST: "CRON_SECRET" },
  "app/api/cron/slack-digest/route.ts": { GET: "CRON_SECRET" },
  "app/api/cron/sweep/route.ts": { GET: "CRON_SECRET" },
  "app/api/cron/trending/route.ts": { GET: "CRON_SECRET" },
  "app/api/cron/publication-audit/route.ts": { GET: "CRON_SECRET" },
  "app/api/cron/verify-rounds/route.ts": { GET: "CRON_SECRET" },
  "app/api/digest/unsubscribe/route.ts": {
    GET: "signed link, confirm page only",
    POST: "signed link (HMAC under RESEND_API_KEY), email targets only",
  },
  "app/api/company-requests/route.ts": { POST: "COMPANY_REQUESTS flag, same origin, public website, daily caps" },
  "app/api/company-requests/[id]/route.ts": { GET: "COMPANY_REQUESTS flag, public status only" },
  "app/api/logo/[id]/route.tsx": { GET: "public read, rate limited" },
  "app/api/mcp/route.ts": {
    GET: "MCP_API_KEY when set, else read tools only; request tools behind COMPANY_REQUESTS with the page's daily caps; rate limited",
    POST: "same as GET",
  },
  "app/api/slack/connect/route.ts": { GET: "public install, demo only, rate limited" },
  "app/api/slack/connected/route.ts": { GET: "demo only, OAuth state cookie" },
  "app/api/slack/install/route.ts": { GET: "adminRefusal" },
  "app/api/slack/oauth/callback/route.ts": { GET: "adminRefusal" },
  "app/api/v1/openapi.json/route.ts": { GET: "public read" },
  "app/api/v1/rounds/route.ts": { GET: "public read, rate limited; include_review needs the password" },
  "app/api/v1/runs/route.ts": { GET: "public read, rate limited" },
  "app/api/webhooks/firecrawl/route.ts": { POST: "FIRECRAWL_WEBHOOK_SECRET signature and/or WEBHOOK_BEARER_TOKEN" },
  "app/api/webhooks/slack/route.ts": { POST: "SLACK_SIGNING_SECRET signature and five-minute timestamp window" },
  "app/feeds/[token]/[file]/route.ts": { GET: "feed token (hashed), or the demo's public token" },
};

const ROOT = path.resolve(__dirname, "..");

/** Every source file under app/, relative to the repo root. */
function appFiles(): string[] {
  return (readdirSync(path.join(ROOT, "app"), { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => path.join("app", f).split(path.sep).join("/"));
}

/** Reads a demo visitor may run: nothing here writes a row or spends a credit. */
const VISITOR_READS = new Set(["search/actions.searchEntities"]);

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** The refusal message, whether the action returned an ActionResult or threw. */
async function outcome(fn: (...args: unknown[]) => Promise<unknown>): Promise<string> {
  try {
    const r = (await fn("x", {})) as { ok?: boolean; error?: string } | undefined;
    if (r && r.ok === false) return r.error ?? "";
    return "passed";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function actions(): Array<[string, (...args: unknown[]) => Promise<unknown>]> {
  return Object.entries(MODULES).flatMap(([file, mod]) =>
    Object.entries(mod)
      .filter(([, v]) => typeof v === "function")
      .map(
        ([name, fn]) =>
          [`${file}.${name}`, fn as (...args: unknown[]) => Promise<unknown>] as [string, (...args: unknown[]) => Promise<unknown>],
      ),
  );
}

beforeEach(() => {
  auth.header = null;
  opened.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.DASHBOARD_PASSWORD;
  delete process.env.PUBLIC_DEMO;
});

describe("the inventory", () => {
  test('every file that opens with "use server" is in the sweep', () => {
    const onDisk = appFiles().filter((f) => /^\s*(\/\/[^\n]*\n\s*)*["']use server["']/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(onDisk.sort()).toEqual([...SWEPT_FILES].sort());
  });

  test("every route handler and each method it exports is listed with its guard", () => {
    const routes = appFiles().filter((f) => /\/route\.tsx?$/.test(f));
    expect(routes.sort()).toEqual(Object.keys(ROUTE_GUARDS).sort());
    for (const f of routes) {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      const methods = [
        ...[...src.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1]),
        ...[...src.matchAll(/\bas (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1]),
      ];
      expect(methods.sort(), f).toEqual(Object.keys(ROUTE_GUARDS[f]).sort());
    }
  });
});

describe("server actions in a password-less demo", () => {
  test("the sweep found every action file's exports", () => {
    const names = actions().map(([n]) => n);
    for (const n of ["companies/actions.deepDiveCompany", "app/actions.report", "app/actions.markSeen", "settings/actions.setCoverage"]) {
      expect(names).toContain(n);
    }
  });

  test("every write refuses before the store opens; only the allowlisted reads pass", async () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    for (const [name, fn] of actions()) {
      if (VISITOR_READS.has(name)) continue;
      opened.mockClear();
      expect(await outcome(fn), name).toContain("read-only demo");
      expect(opened, name).not.toHaveBeenCalled();
    }
    // Credentials change nothing: a password-less demo has no admin tier to reach.
    auth.header = `Basic ${b64("u:anything")}`;
    expect(await outcome(companyActions.deepDiveCompany as never)).toContain("read-only demo");
  });

  test("the palette's search stays open to a visitor", async () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    expect(await searchActions.searchEntities(42 as never)).toEqual({ companies: [], investors: [] });
  });
});

describe("the Slack manage actions", () => {
  test("without a manage token every one refuses before the store opens, password or not", async () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    vi.stubEnv("SLACK_CLIENT_ID", "1.2");
    vi.stubEnv("SLACK_CLIENT_SECRET", "s");
    vi.stubEnv("SLACK_WEBHOOK_KEY", "k".repeat(40));
    for (const header of [null, `Basic ${b64("u:anything")}`]) {
      auth.header = header;
      for (const [name, fn] of Object.entries(slackManageActions)) {
        if (typeof fn !== "function") continue;
        opened.mockClear();
        expect(await outcome(fn as (...args: unknown[]) => Promise<unknown>), name).toContain("not valid");
        expect(opened, name).not.toHaveBeenCalled();
      }
    }
  });
});

describe("server actions in a demo with a password", () => {
  test("Deep dive and every other write want the password; with it, the guard lets the call through", async () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    process.env.DASHBOARD_PASSWORD = "secret";
    for (const [name, fn] of actions()) {
      if (VISITOR_READS.has(name)) continue;
      expect(await outcome(fn), name).toContain("Unauthorized");
    }
    auth.header = `Basic ${b64("u:secret")}`;
    // Past the guard, the action opens the store (mocked to throw here), which is the proof it got through.
    expect(await outcome(companyActions.deepDiveCompany as never)).toBe("the store opened");
  });
});

describe("write routes in a password-less demo", () => {
  test("Research refuses a same-origin visitor", async () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    const res = await researchPost(
      new Request("http://app.test/review/research", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://app.test", host: "app.test" },
        body: JSON.stringify({ id: "r1" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("read-only demo");
    expect(opened).not.toHaveBeenCalled();
  });

  test("the Slack install pair answers 404 on its own, whatever the proxy matched", async () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    const { NextRequest } = await import("next/server");
    expect((await slackInstall(new NextRequest("http://app.test/api/slack/install"))).status).toBe(404);
    expect((await slackCallback(new NextRequest("http://app.test/api/slack/oauth/callback?code=c&state=s"))).status).toBe(404);
    expect(opened).not.toHaveBeenCalled();
  });
});
