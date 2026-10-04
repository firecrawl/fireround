// The publication audit: the last read before a round is shown to anyone. The read-back is blind (it
// reads the round off the pages and is never shown the record); this is the opposite. It is shown the
// row exactly as a visitor would see it, company profile included, beside the round's best pages, and
// asked to find what is wrong with it: a namesake's website, a stock offering filed as a venture round,
// a total to date shown as the round, a "nearing" shown as closed, a day off, a participant called a
// lead, a page about another company. It runs on a different model family from the read-back, so the
// two do not share blind spots. The verdicts are applied in lib/publication-audit.ts.

import { generateText, Output } from "ai";
import { z } from "zod";
import { namesCompany } from "../records/normalize.ts";
import type { ReconcileModel } from "./model.ts";
import type { SourceText } from "./reconcile.ts";

/** What the audit is shown: the row as published, and its company as its page shows it. */
export interface AuditedRound {
  company: {
    name: string;
    domain: string | null;
    website: string | null;
    description: string | null;
    hq: string | null;
    sector: string | null;
  };
  stage: string;
  stage_as_written: string | null;
  amount_as_written: string | null;
  amount_currency: string | null;
  amount_usd_millions: number | null;
  financing_total_as_written: string | null;
  valuation_as_written: string | null;
  announced_on: string | null;
  certainty: string;
  is_extension: boolean;
  history: boolean;
  lead_investors: string[];
  other_investors: string[];
  sources: Array<{ url: string; host: string; title: string | null }>;
}

const Check = z.object({
  verdict: z
    .enum(["ok", "wrong", "unsure"])
    .describe("ok when the pages support the shown value; wrong when they contradict it; unsure when they say nothing either way."),
  correct: z.string().nullable().describe("The right value as the best page states it, when verdict is wrong; null otherwise."),
  quote: z.string().nullable().describe("The sentence from a page that proves the verdict, copied exactly. Required for wrong."),
  source: z.string().nullable().describe("The URL of that page, copied exactly from the list."),
});

export const PublicationAudit = z.object({
  company: Check.describe(
    "Is the shown company (name, website, description, headquarters) the company the pages say raised this money? wrong when the website, description, or headquarters belongs to a different organisation with a similar name (a sports team, a different biotech, a parent company). correct: the right company's name and, if a page gives it, its website.",
  ),
  round_type: z.object({
    kind: z
      .enum([
        "private_company_round",
        "public_company_offering",
        "listed_company_financing",
        "debt_or_project_finance",
        "grant",
        "acquisition_or_stake_sale",
        "fund_close",
        "secondary_only",
        "filing_only",
        "not_a_financing",
      ])
      .describe(
        "What the money is. private_company_round: a privately held company sells equity, convertible notes, or SAFEs to investors. public_company_offering: an IPO, follow-on, or registered offering of a listed company's shares or notes. listed_company_financing: any placement or investment by or in a company whose shares trade on an exchange (Nasdaq, NYSE, TSX/TSXV, LSE, ASX, a ticker). debt_or_project_finance: loans, credit or warehouse facilities, project finance, tax-credit financing. acquisition_or_stake_sale: a company or a stake in a subsidiary is bought. fund_close: an investment fund raising capital. secondary_only: existing shares change hands, no new money. filing_only: only a regulatory filing (a Form D) states it and no announcement exists. not_a_financing: none of these.",
      ),
    quote: z.string().nullable(),
    source: z.string().nullable(),
  }),
  amount: Check.extend({
    scope: z
      .enum(["round", "cumulative", "includes_secondary", "includes_debt", "combined_rounds", "valuation", "unstated"])
      .describe(
        "What the shown amount is per the pages: round (this round's new money), cumulative (total raised to date), includes_secondary, includes_debt, combined_rounds (several rounds added up), valuation (a valuation shown as money raised), unstated (no page gives this round's amount).",
      ),
  }).describe(
    "The shown amount and its currency. correct: this round's new money as written with its currency, when the shown value is wrong.",
  ),
  stage: Check.describe(
    "The shown round label (Series A, seed, extension). correct: the label the company's release or the most specific page uses.",
  ),
  date: Check.describe(
    "The shown announced_on. The announcement day is the day the company or the first report made the round public, not the day it closed. ok within one day. correct: YYYY-MM-DD.",
  ),
  certainty: Check.describe(
    "announced: a page says the round closed or was raised. expected: pages say it is being raised, nearing, in talks, set to raise. reported: unnamed sources say it closed. wrong when the shown certainty is stronger than the most credible page supports. correct: announced, expected, or reported.",
  ),
  leads: Check.describe(
    "The shown lead investors. wrong when a shown lead only participated per the company's release or established outlets, or when the pages name a lead not shown. correct: the leads, comma-separated, or an empty string when no page names a lead.",
  ),
  unrelated_sources: z
    .array(z.string())
    .describe("URLs from the list whose page is about a different company or a different round, copied exactly."),
  summary: z.string().describe("One sentence: what a visitor would get wrong from this row, or that it is right."),
});
export type PublicationAudit = z.infer<typeof PublicationAudit>;

const PAGE_CHARS = 8_000;

export function auditPrompt(round: AuditedRound, pages: SourceText[]): string {
  const shown = [
    `Company: ${round.company.name}`,
    `  website: ${round.company.website ?? round.company.domain ?? "none"}`,
    `  description: ${round.company.description ?? "none"}`,
    `  headquarters: ${round.company.hq ?? "none"}`,
    `  sector: ${round.company.sector ?? "none"}`,
    `Round: ${round.stage_as_written ?? round.stage}${round.is_extension ? " (extension)" : ""}${round.history ? " (an earlier round, shown on the company's history)" : ""}`,
    `Amount: ${round.amount_as_written ?? "undisclosed"}${round.amount_currency ? ` [${round.amount_currency}${round.amount_usd_millions !== null ? `, US$${round.amount_usd_millions}M` : ", not converted"}]` : ""}`,
    round.financing_total_as_written ? `Stated total beside it: ${round.financing_total_as_written}` : null,
    round.valuation_as_written ? `Valuation: ${round.valuation_as_written}` : null,
    `Announced: ${round.announced_on ?? "undated"}`,
    `Certainty: ${round.certainty}`,
    `Lead investors: ${round.lead_investors.join(", ") || "none named"}`,
    `Other investors: ${round.other_investors.join(", ") || "none named"}`,
    "Sources listed on the row:",
    ...round.sources.map((s) => `  - ${s.url}${s.title ? ` (${s.title})` : ""}`),
  ].filter((line): line is string => line !== null);
  const read = pages.map((p, i) =>
    [
      `=== Page ${i + 1}: ${p.url}`,
      p.title ? `Title: ${p.title}` : null,
      p.published ? `Published: ${p.published}` : null,
      p.markdown.slice(0, PAGE_CHARS),
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return [
    "You are the last check before a startup funding round is published on a public feed that people rely on for accurate information.",
    "Below is the round exactly as visitors will see it, then the text of its best source pages. Your job is to find anything a visitor would get wrong.",
    "Judge only from the pages and from well-known public facts about organisations (that vikings.com is an NFL team, that a ticker means a listed company). Do not invent figures.",
    "Be strict about the company and the kind of financing: a near-same name with the wrong website or headquarters is wrong; a listed company's offering or placement is not a private company round.",
    "Be strict about the amount: read every sentence near the figure. It is not this round's money when a page says it brings total funding to that figure, that it was raised to date or in total, that it includes an existing investor's exit or shares bought from shareholders, that it includes loans or debt, or that it adds up several rounds. Then the amount is wrong and scope says which.",
    "Be strict about certainty: a round a credible page says is being raised, nearing, in talks, or has a signed term sheet is expected, even if another page says raised.",
    "For every field marked wrong, quote the sentence that proves it and give its URL. When the pages do not settle a field, answer unsure, not wrong.",
    "",
    "=== The row as published",
    ...shown,
    "",
    ...read,
  ].join("\n");
}

export async function generatePublicationAudit(
  model: ReconcileModel,
  prompt: string,
): Promise<{ output: PublicationAudit | null; usage: { input: number; output: number } }> {
  const usage = { input: 0, output: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await generateText({ model: model.model, output: Output.object({ schema: PublicationAudit }), prompt, maxRetries: 2 });
      usage.input += result.usage.inputTokens ?? 0;
      usage.output += result.usage.outputTokens ?? 0;
      const output = (await result.output) ?? null;
      if (output) return { output, usage };
    } catch {
      // A reply that does not parse is asked for once more; a second miss leaves the row for the next run.
    }
  }
  return { output: null, usage };
}

export type AuditFix =
  | { kind: "certainty"; to: "expected" | "reported"; quote: string; source: string }
  | {
      kind: "amount_scope";
      scope: "cumulative" | "includes_secondary" | "includes_debt" | "combined_rounds";
      quote: string;
      source: string;
    }
  | { kind: "date"; to: string; quote: string; source: string }
  | { kind: "stage"; to: string; quote: string; source: string }
  | { kind: "drop_sources"; urls: string[] };

export type AuditDecision = { action: "pass" | "hold"; reasons: string[]; fixes: AuditFix[]; notes: string[] };

const bareHost = (s: string) =>
  s
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");

const quoted = (c: { quote: string | null; source: string | null }) => Boolean(c.quote?.trim() && c.source?.trim());

/**
 * What a verdict does to the row. A wrong company, a financing that is not a private company's round,
 * a wrong amount or currency, or a day more than a month off hides the row until a person fixes it. A
 * certainty stronger than the pages support, a total shown as the round, a day off, a label, and pages
 * about something else are corrected from the quote that proves them. Wrong leads are noted for a person.
 */
export function decideAudit(round: AuditedRound, audit: PublicationAudit): AuditDecision {
  const reasons: string[] = [];
  const fixes: AuditFix[] = [];
  const notes: string[] = [];
  // A "wrong company" whose right answer is on the row's own website is a detail of the profile (a
  // headquarters, a description), not a namesake: noted for a person, not hidden.
  const sites = [round.company.domain, round.company.website].flatMap((s) => (s ? [bareHost(s)] : []));
  const named = [...(audit.company.correct ?? "").matchAll(/https?:\/\/[^\s),;]+/gi)].map((m) => bareHost(m[0]));
  const sameSite =
    named.length > 0 && named.every((host) => sites.includes(host)) && namesCompany(audit.company.correct, round.company.name);
  if (audit.company.verdict === "wrong" && quoted(audit.company)) {
    if (sameSite) notes.push(`publication audit: company profile: ${audit.company.correct} (${audit.company.source})`);
    else reasons.push(`wrong company: ${audit.company.correct ?? "the pages name another organisation"} (${audit.company.source})`);
  }
  if (audit.round_type.kind !== "private_company_round")
    reasons.push(
      `not a private company's round: ${audit.round_type.kind.replace(/_/g, " ")}${audit.round_type.source ? ` (${audit.round_type.source})` : ""}`,
    );
  if (audit.amount.verdict === "wrong" && quoted(audit.amount)) {
    const scope = audit.amount.scope;
    if (scope === "cumulative" || scope === "includes_secondary" || scope === "includes_debt" || scope === "combined_rounds")
      fixes.push({ kind: "amount_scope", scope, quote: audit.amount.quote ?? "", source: audit.amount.source ?? "" });
    // A row that shows no amount misleads no one; the figure a page states is noted for a person.
    else if (!round.amount_as_written)
      notes.push(`publication audit: amount stated as ${audit.amount.correct ?? "a figure"} (${audit.amount.source})`);
    else reasons.push(`amount: ${round.amount_as_written} should be ${audit.amount.correct ?? "something else"} (${audit.amount.source})`);
  }
  const weaker = audit.certainty.correct === "expected" || audit.certainty.correct === "reported";
  if (audit.certainty.verdict === "wrong" && quoted(audit.certainty) && weaker && round.certainty === "announced")
    fixes.push({
      kind: "certainty",
      to: audit.certainty.correct as "expected" | "reported",
      quote: audit.certainty.quote ?? "",
      source: audit.certainty.source ?? "",
    });
  const day = audit.date.correct?.trim() ?? "";
  if (audit.date.verdict === "wrong" && quoted(audit.date) && /^\d{4}-\d{2}-\d{2}$/.test(day) && round.announced_on) {
    const apart = Math.abs(Date.parse(day) - Date.parse(round.announced_on)) / 86_400_000;
    if (apart <= 31) fixes.push({ kind: "date", to: day, quote: audit.date.quote ?? "", source: audit.date.source ?? "" });
    else reasons.push(`date: ${round.announced_on} should be ${day} (${audit.date.source})`);
  }
  if (audit.stage.verdict === "wrong" && quoted(audit.stage) && audit.stage.correct?.trim())
    fixes.push({ kind: "stage", to: audit.stage.correct.trim(), quote: audit.stage.quote ?? "", source: audit.stage.source ?? "" });
  if (audit.leads.verdict === "wrong" && quoted(audit.leads))
    notes.push(`publication audit: leads should be ${audit.leads.correct?.trim() || "none named"} (${audit.leads.source})`);
  const listed = new Set(round.sources.map((s) => s.url));
  const unrelated = audit.unrelated_sources.filter((u) => listed.has(u));
  if (unrelated.length > 0 && unrelated.length < round.sources.length) fixes.push({ kind: "drop_sources", urls: unrelated });
  return { action: reasons.length > 0 ? "hold" : "pass", reasons, fixes, notes };
}
