// Run the editor lane beside the feed: for each round, read its pages, let the editor write the round
// from them, and record what it would show next to what the feed shows. Read only: nothing is written
// to the store. Spends Firecrawl credits (pages, a search, candidate sites) and one model call per round.
//   node scripts/shadow-editor.ts --out shadow.jsonl [--ids ids.json] [--since-days 14] [--concurrency 4]
// ids.json: ["id", ...] or [{ "id": "..." }, ...]. Rounds already in the output file are skipped.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { DEFAULT_TIERS, editorModel, fetchRates, firecrawlReader } from "@fireround/core";
import { closeDb } from "@fireround/core/db";
import { sql } from "drizzle-orm";
import { openStore } from "../lib/db.ts";
import { editRow } from "../lib/editor-lane.ts";
import { getFirecrawl } from "../lib/firecrawl.ts";
import { roundForAudit } from "../lib/publication-audit.ts";
import { loadPublisherTiers } from "../lib/rules.ts";

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const out = flag("--out");
if (!out) throw new Error("--out <file.jsonl> is required");
const concurrency = Number(flag("--concurrency") ?? 4);

const handle = await openStore();
let ids: string[];
const idsFile = flag("--ids");
if (idsFile) {
  const data = JSON.parse(readFileSync(idsFile, "utf8")) as Array<string | { id: string }>;
  ids = data.map((d) => (typeof d === "string" ? d : d.id));
} else {
  const days = Number(flag("--since-days") ?? 14);
  const rows = await handle.execute<{ id: string }>(
    sql`select id from funding_rounds where history = false and first_seen_at > now() - make_interval(days => ${days}) order by first_seen_at desc`,
  );
  ids = ((rows as unknown as { rows?: Array<{ id: string }> }).rows ?? (rows as unknown as Array<{ id: string }>)).map((r) => r.id);
}
const done = new Set(
  existsSync(out)
    ? readFileSync(out, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { id: string }).id)
    : [],
);
const queue = ids.filter((id) => !done.has(id));

const model = editorModel();
if (!model) throw new Error("No model key: set AI_GATEWAY_API_KEY (or another provider key).");
const client = getFirecrawl();
const read = firecrawlReader(client, 30 * 86_400_000);
const tiers = { ...DEFAULT_TIERS, ...(await loadPublisherTiers()) };
const rates = await fetchRates("latest").catch(() => null);
console.error(`editor ${model.label}: ${queue.length} rounds (${done.size} already done)`);

const tally = { publish: 0, drop: 0, unread: 0, error: 0 };
let next = 0;
async function worker() {
  while (next < queue.length) {
    const id = queue[next++];
    const started = Date.now();
    try {
      const row = await roundForAudit(handle, id);
      if (!row) continue;
      const run = await editRow(row, client, read, model as NonNullable<typeof model>, rates, tiers);
      const control = {
        disposition: row.disposition,
        company: row.company.name,
        domain: row.company.domain,
        stage: row.stage,
        stage_as_written: row.stage_as_written,
        amount_as_written: row.amount.as_written,
        amount_currency: row.amount.currency,
        amount_usd_millions: row.amount.usd_millions,
        announced_on: row.announced_on,
        certainty: row.certainty,
        lead_investors: row.lead_investors,
        first_seen_at: row.first_seen_at,
      };
      if (!run) tally.unread++;
      else tally[run.outcome.action]++;
      appendFileSync(
        out as string,
        `${JSON.stringify({ id, history: row.history, control, shadow: run?.outcome ?? null, verdict: run?.verdict ?? null, pages: run?.pages ?? 0, sites: run?.sites ?? 0, usage: run?.usage ?? null, ms: Date.now() - started })}\n`,
      );
    } catch (err) {
      tally.error++;
      console.error(`ERROR ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
console.error(JSON.stringify(tally));
await closeDb();
