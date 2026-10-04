// Score the publication audit against hand-checked rounds: does it catch the rows a person found
// wrong, and leave the clean ones alone? Reads the live store and each round's pages; spends Firecrawl
// credits (one per page) and one model call per round. Read only: nothing is written.
//   node scripts/bench-publication-audit.ts <cases.json> [--overlay backup.json ...] [--only id,id]
// cases.json: [{ "id": "...", "clean": true|false, "problems": ["field: what is wrong"] }]
// --overlay: a JSON file of stored rows ({ rounds: [...] } or [...]) whose fields replace the live row's,
// so a row fixed since the audit is scored as it was when the audit found it.

import { readFileSync } from "node:fs";
import { DEFAULT_TIERS, firecrawlReader, publicationAuditModel } from "@fireround/core";
import { closeDb } from "@fireround/core/db";
import { openStore } from "../lib/db.ts";
import { getFirecrawl } from "../lib/firecrawl.ts";
import type { RoundRow } from "../lib/persist.ts";
import { auditRow, roundForAudit } from "../lib/publication-audit.ts";
import { loadPublisherTiers } from "../lib/rules.ts";

type Case = { id: string; clean: boolean; problems: string[] };
type Stored = Record<string, unknown>;

const args = process.argv.slice(2);
const cases: Case[] = JSON.parse(readFileSync(args[0], "utf8"));
const overlays = new Map<string, Stored>();
const investorOverlays = new Map<string, { leads: string[]; others: string[] }>();
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--overlay") continue;
  const data = JSON.parse(readFileSync(args[i + 1], "utf8"));
  const rounds: Stored[] = Array.isArray(data) ? data : (data.rounds ?? []);
  for (const r of rounds ?? []) if (!overlays.has(String(r.id))) overlays.set(String(r.id), r);
}
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null;

function overlay(row: RoundRow, stored: Stored | undefined): RoundRow {
  if (!stored) return row;
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    ...row,
    stage: (stored.stage as RoundRow["stage"]) ?? row.stage,
    stage_as_written: (stored.stage_as_written as string) ?? row.stage_as_written,
    is_extension: (stored.is_extension as boolean) ?? row.is_extension,
    amount: {
      value: num(stored.amount_value),
      currency: (stored.amount_currency as string | null) ?? null,
      as_written: (stored.amount_as_written as string | null) ?? null,
      usd_millions: num(stored.amount_usd_millions),
    },
    financing_total_as_written: (stored.financing_total_as_written as string | null) ?? null,
    amount_scope: (stored.amount_scope as string | null) ?? null,
    valuation_as_written: (stored.valuation_as_written as string | null) ?? null,
    announced_on: (stored.announced_on as string | null) ?? null,
    certainty: (stored.certainty as RoundRow["certainty"]) ?? row.certainty,
  };
}

const handle = await openStore();
const picked = publicationAuditModel();
if (!picked) throw new Error("No model key: set AI_GATEWAY_API_KEY (or another provider key).");
const model = picked;
const read = firecrawlReader(getFirecrawl());
const tiers = { ...DEFAULT_TIERS, ...(await loadPublisherTiers()) };
const tally = { errors: 0, caught: 0, held: 0, clean: 0, cleanHeld: 0, cleanChanged: 0, unread: 0 };
const lines: string[] = [];
const queue = cases.filter((c) => !only || only.has(c.id));
let next = 0;
async function worker() {
  while (next < queue.length) {
    const c = queue[next++];
    const live = await roundForAudit(handle, c.id);
    if (!live) {
      lines.push(`MISSING ${c.id}`);
      continue;
    }
    const row = overlay(live, overlays.get(c.id));
    void investorOverlays;
    const run = await auditRow(row, read, model, tiers).catch((err: unknown) => {
      lines.push(`ERROR ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (!run) {
      tally.unread++;
      lines.push(`UNREAD ${c.id}`);
      continue;
    }
    const { decision } = run;
    const changed = decision.fixes.length + decision.notes.length > 0;
    const verdict = decision.action === "hold" ? `HOLD ${decision.reasons.join("; ")}` : changed ? "FIX" : "PASS";
    const did = [
      ...decision.fixes.map((f) =>
        f.kind === "drop_sources" ? `drop ${f.urls.length} source(s)` : `${f.kind} -> ${"to" in f ? f.to : f.scope}`,
      ),
      ...decision.notes,
    ].join(" | ");
    if (c.clean) {
      tally.clean++;
      if (decision.action === "hold") tally.cleanHeld++;
      else if (changed) tally.cleanChanged++;
      lines.push(
        `${decision.action === "hold" ? "FALSE-HOLD" : changed ? "clean-changed" : "clean-ok"} ${c.id}: ${verdict}${did ? ` [${did}]` : ""}`,
      );
    } else {
      tally.errors++;
      if (decision.action === "hold" || changed) tally.caught++;
      if (decision.action === "hold") tally.held++;
      lines.push(
        `${decision.action === "hold" || changed ? "caught" : "MISSED"} ${c.id}: ${verdict}${did ? ` [${did}]` : ""}\n    expected: ${c.problems.join("; ")}`,
      );
    }
  }
}
await Promise.all(Array.from({ length: 5 }, worker));
console.log(lines.sort().join("\n"));
console.log(
  `\n${tally.caught}/${tally.errors} wrong rows caught (${tally.held} held); ${tally.cleanHeld}/${tally.clean} clean rows held, ${tally.cleanChanged} clean rows changed; ${tally.unread} unreadable`,
);
await closeDb();
