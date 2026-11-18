// Score the feed and the editor lane against a hand-checked gold set: of the rounds each would show,
// how many carry an error a visitor would see, and how many real rounds each leaves out.
//   node scripts/score-editor.ts <gold.json> <shadow.jsonl> [more.jsonl ...] [--list]
// gold.json: [{ id, publishable, company: { website_domain }, amount_usd_millions, currency, announced_on, stage, certainty, leads }]
// shadow.jsonl: lines written by scripts/shadow-editor.ts (the feed's row is recorded beside the editor's).

import { readFileSync } from "node:fs";
import { classifyStage } from "@fireround/core";

type Gold = {
  id: string;
  publishable: boolean;
  company: { name: string; website_domain: string | null };
  stage: string | null;
  amount_usd_millions: number | null;
  currency: string | null;
  announced_on: string | null;
  certainty: string | null;
  leads: string[];
  confidence?: string;
};
type Shown = {
  domain: string | null;
  stage: string | null;
  usd: number | null;
  currency: string | null;
  date: string | null;
  certainty: string;
  leads: string[];
};
type Line = {
  id: string;
  control: {
    disposition: string;
    domain: string | null;
    stage: string;
    amount_currency: string | null;
    amount_usd_millions: number | null;
    announced_on: string | null;
    certainty: string;
    lead_investors: string[];
  };
  shadow:
    | {
        action: "publish";
        round: {
          company: { domain: string | null };
          stage: string | null;
          amount_currency: string | null;
          amount_usd_millions: number | null;
          announced_on: string | null;
          certainty: string;
          lead_investors: string[];
        };
      }
    | { action: "drop"; reason: string }
    | null;
};

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const list = process.argv.includes("--list");
const gold = new Map((JSON.parse(readFileSync(args[0], "utf8")) as Gold[]).map((g) => [g.id, g]));
const lines = new Map<string, Line>();
for (const file of args.slice(1))
  for (const l of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const line = JSON.parse(l) as Line;
    lines.set(line.id, line);
  }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const day = (d: string | null) => (d ? Date.parse(d.slice(0, 10)) / 86_400_000 : null);
const stageOf = (label: string | null) => (label ? classifyStage(label).stage : null);

/** The fields a visitor would see wrong. A field left blank is missing, not wrong. */
function wrongFields(g: Gold, s: Shown): string[] {
  const wrong: string[] = [];
  if (s.domain && g.company.website_domain && norm(s.domain) !== norm(g.company.website_domain)) wrong.push("website");
  if (
    s.usd !== null &&
    g.amount_usd_millions !== null &&
    Math.abs(s.usd - g.amount_usd_millions) > Math.max(0.05 * g.amount_usd_millions, 0.05)
  )
    wrong.push("amount");
  if (s.usd !== null && g.amount_usd_millions === null) wrong.push("amount");
  if (s.currency && g.currency && s.currency !== g.currency) wrong.push("currency");
  const a = day(s.date);
  const b = day(g.announced_on);
  if (a !== null && b !== null && Math.abs(a - b) > 1) wrong.push("date");
  const gs = stageOf(g.stage);
  if (s.stage && gs && s.stage !== gs && s.stage !== "other" && gs !== "other") wrong.push("stage");
  if (g.certainty && s.certainty !== g.certainty) wrong.push("certainty");
  const leads = new Set(g.leads.map(norm));
  if (s.leads.some((l) => !leads.has(norm(l))) || (s.leads.length > 0 && s.leads.length < leads.size)) wrong.push("leads");
  return wrong;
}

function score(name: string, shownOf: (l: Line) => Shown | null) {
  const t = {
    judged: 0,
    real: 0,
    shown: 0,
    shownReal: 0,
    wronglyShown: 0,
    shownWithError: 0,
    missed: 0,
    fields: {} as Record<string, number>,
    rows: [] as string[],
  };
  for (const [id, g] of gold) {
    const line = lines.get(id);
    if (!line) continue;
    t.judged++;
    if (g.publishable) t.real++;
    const s = shownOf(line);
    if (!s) {
      if (g.publishable) {
        t.missed++;
        t.rows.push(`  missed     ${id}`);
      }
      continue;
    }
    t.shown++;
    if (!g.publishable) {
      t.wronglyShown++;
      t.rows.push(`  not a round shown ${id}`);
      continue;
    }
    t.shownReal++;
    const wrong = wrongFields(g, s);
    if (wrong.length) {
      t.shownWithError++;
      t.rows.push(`  wrong ${wrong.join(",")}  ${id}`);
    }
    for (const f of wrong) t.fields[f] = (t.fields[f] ?? 0) + 1;
  }
  const bad = t.wronglyShown + t.shownWithError;
  console.log(
    `${name}: judged ${t.judged} (${t.real} real rounds). Shows ${t.shown}: ${bad} with an error a visitor would see (${t.shown ? Math.round((100 * bad) / t.shown) : 0}%) = ${t.wronglyShown} not a real round + ${t.shownWithError} with a wrong field ${JSON.stringify(t.fields)}. Leaves out ${t.missed} of ${t.real} real rounds.`,
  );
  if (list) console.log(t.rows.sort().join("\n"));
}

score("feed  ", (l) =>
  l.control.disposition === "publish" || l.control.disposition === "flagged"
    ? {
        domain: l.control.domain,
        stage: l.control.stage,
        usd: l.control.amount_usd_millions,
        currency: l.control.amount_currency,
        date: l.control.announced_on,
        certainty: l.control.certainty,
        leads: l.control.lead_investors,
      }
    : null,
);
score("editor", (l) =>
  l.shadow?.action === "publish"
    ? {
        domain: l.shadow.round.company.domain,
        stage: l.shadow.round.stage,
        usd: l.shadow.round.amount_usd_millions,
        currency: l.shadow.round.amount_currency,
        date: l.shadow.round.announced_on,
        certainty: l.shadow.round.certainty,
        leads: l.shadow.round.lead_investors,
      }
    : null,
);
