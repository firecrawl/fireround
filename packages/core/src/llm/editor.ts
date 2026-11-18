// The editor: one strong-model pass that writes the round a visitor will see, from the pages alone.
// It is given the candidate company's name, the round's best pages, and the websites that could be
// the company's, and returns every shown fact with the sentence that states it. Code then keeps only
// what the pages bear out: a quote that is not on the page it cites does not count, a website that
// was not among the candidates is never shown, a lead the quote does not name is dropped, and a round
// older than the news window or that is not a private company's round is not shown at all.

import { generateText, Output } from "ai";
import { z } from "zod";
import { convertToUsd, type RateTable } from "../records/fx.ts";
import { classifyStage, namesCompany, parseAmount, registrableDomain } from "../records/normalize.ts";
import type { Stage } from "../records/stages.ts";
import type { ReconcileModel } from "./model.ts";
import type { SourceText } from "./reconcile.ts";

export interface SiteCandidate {
  url: string;
  title: string | null;
  description: string | null;
  text: string | null;
}

export interface EditorInput {
  company: string;
  firstSeen: string;
  pages: SourceText[];
  sites: SiteCandidate[];
}

const Cited = {
  quote: z.string().nullable().describe("The sentence that states it, copied exactly from one page."),
  source: z.string().nullable().describe("The URL of that page, copied exactly from the list."),
};

export const EditorVerdict = z.object({
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
      "What the money is. private_company_round: a privately held company sells equity, convertible notes, or SAFEs to investors. public_company_offering: an IPO, follow-on, or registered offering. listed_company_financing: any placement or investment by or in a company whose shares trade on an exchange. debt_or_project_finance: loans, credit or warehouse facilities, project or tax-credit finance. acquisition_or_stake_sale: a company or a stake is bought. fund_close: an investment fund raising capital. secondary_only: existing shares change hands. filing_only: only a regulatory filing states it. not_a_financing: none of these.",
    ),
  kind_quote: Cited.quote,
  kind_source: Cited.source,
  announcement: z
    .enum(["new_announcement", "mention_of_earlier_round", "roundup_or_data_report"])
    .describe(
      "new_announcement: a page reports this round as news when it happened (the company's release, a wire, an article about the round). mention_of_earlier_round: the pages only mention a round that was announced earlier, in passing or as background. roundup_or_data_report: the round appears only in a list, a market report, or quarterly statistics.",
    ),
  source_quality: z
    .enum(["company_or_wire", "established_outlet", "minor_outlet", "unverifiable"])
    .describe(
      "The most credible page that reports the round: the company itself, a press wire, or a regulator; an established news outlet; a small but real outlet; or only auto-generated summaries, content farms, or pages that never name the company clearly.",
    ),
  company: z.object({
    name: z.string().describe("The company's name as its own release or the pages write it."),
    website: z
      .string()
      .nullable()
      .describe(
        "The URL of the candidate website that is this company's own, copied exactly from the candidate list; null when none of them is clearly this company (a namesake, a different product, a parent, a directory).",
      ),
    description: z.string().nullable().describe("One plain sentence on what the company does, from its site or the pages."),
    quote: z
      .string()
      .nullable()
      .describe("The sentence that says this company raised (or is raising) this round, copied exactly from one page."),
    source: Cited.source,
  }),
  stage: z.object({
    label: z.string().nullable().describe("The round label as written: Seed, Series A, Series B extension. Null when no page names one."),
    ...Cited,
  }),
  amount: z.object({
    as_written: z
      .string()
      .nullable()
      .describe(
        'This round\'s new money exactly as written with its currency, in the currency the company itself announced it in ("$12 million", "€8M", "₹250 crore"). Null when undisclosed, or when the only figure is a total to date, a valuation, includes debt or secondary shares, or adds up several rounds.',
      ),
    ...Cited,
  }),
  announced_on: z.object({
    date: z
      .string()
      .nullable()
      .describe("YYYY-MM-DD the company or the first report made this round public (not the close). Null when no page dates it."),
    ...Cited,
  }),
  certainty: z.object({
    value: z
      .enum(["announced", "expected", "reported"])
      .describe(
        "announced: the company or a page says it raised or closed. expected: pages say it is raising, nearing, in talks, or has a term sheet. reported: unnamed sources say it closed. Pick the weakest the most credible pages support.",
      ),
    ...Cited,
  }),
  is_extension: z.boolean(),
  leads: z.object({
    names: z
      .array(z.string())
      .describe("Investors the company's release or an established outlet calls lead or co-lead; empty when none is named."),
    ...Cited,
  }),
  participants: z.array(z.string()).describe("Other investors in this round, as named. Not earlier backers, partners, or advisors."),
  summary: z.string().describe("One sentence on what happened, or why this is not a startup round."),
});
export type EditorVerdict = z.infer<typeof EditorVerdict>;

const PAGE_CHARS = 10_000;
const SITE_CHARS = 600;

export function editorPrompt(input: EditorInput): string {
  const pages = input.pages.map((p, i) =>
    [
      `=== Page ${i + 1}: ${p.url}`,
      p.title ? `Title: ${p.title}` : null,
      p.published ? `Published: ${p.published}` : null,
      p.markdown.slice(0, PAGE_CHARS),
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const sites = input.sites.map((s, i) =>
    [
      `--- Candidate ${i + 1}: ${s.url}`,
      s.title ? `Title: ${s.title}` : null,
      s.description ? `Description: ${s.description}` : null,
      s.text ? s.text.slice(0, SITE_CHARS) : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return [
    "You are the editor of a public startup funding feed that people rely on for accurate information.",
    `Below are pages about a funding round by "${input.company}" (first seen ${input.firstSeen.slice(0, 10)}), then websites that might be the company's own.`,
    "Write the round exactly as the pages support it. Every fact you give must be stated on a page; copy the sentence that states it word for word and give that page's URL. When the pages do not state a fact, give null rather than guessing.",
    "Be strict about what the money is: a listed company's offering or placement, a loan or credit facility, a grant, an acquisition, a fund close, or a filing with no announcement is not a private company round.",
    'Be strict about the amount: it is this round\'s new money only. Read every sentence near a figure: "brings total funding to", "to date", "in total", "including debt", "including secondary" mean it is not this round\'s amount.',
    "Be strict about the company: pick a candidate website only when its own text shows it is this company (same name and the same business the pages describe). A similar name in another industry or country is a different company.",
    "",
    ...pages,
    "",
    "=== Candidate websites",
    ...(sites.length ? sites : ["(none found)"]),
  ].join("\n");
}

export async function generateEditorVerdict(
  model: ReconcileModel,
  prompt: string,
): Promise<{ output: EditorVerdict | null; usage: { input: number; output: number } }> {
  const usage = { input: 0, output: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await generateText({ model: model.model, output: Output.object({ schema: EditorVerdict }), prompt, maxRetries: 2 });
      usage.input += result.usage.inputTokens ?? 0;
      usage.output += result.usage.outputTokens ?? 0;
      const output = (await result.output) ?? null;
      if (output) return { output, usage };
    } catch {
      // A reply that does not parse is asked for once more; a second miss leaves the round undecided.
    }
  }
  return { output: null, usage };
}

const flat = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`\\]/g, "")
    .replace(/[#>|]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ ([,.;:!?)])/g, "$1")
    .replace(/\( /g, "(")
    .trim();

/** Whether the quote is on the page it cites. A quote of a few words proves nothing, so it must be a sentence's worth. */
export function grounded(pages: SourceText[], quote: string | null, source: string | null): boolean {
  if (!quote || !source) return false;
  const q = flat(quote).replace(/^["'.\s]+|["'.\s]+$/g, "");
  if (q.length < 12) return false;
  const page = pages.find((p) => p.url === source) ?? pages.find((p) => flat(p.url) === flat(source));
  return page !== undefined && flat(page.markdown).includes(q);
}

export const NEWS_WINDOW_DAYS = 14;

export interface EditedRound {
  company: { name: string; website: string | null; domain: string | null; description: string | null };
  stage: Stage | null;
  stage_as_written: string | null;
  is_extension: boolean;
  amount_as_written: string | null;
  amount_currency: string | null;
  amount_usd_millions: number | null;
  announced_on: string | null;
  certainty: "announced" | "expected" | "reported";
  lead_investors: string[];
  other_investors: string[];
  evidence: Array<{ field: string; url: string; quote: string }>;
}

export type EditorOutcome =
  | { action: "publish"; round: EditedRound; notes: string[] }
  | { action: "drop"; reason: string; notes: string[] };

/** Keep what the pages bear out and decide whether the round is shown. */
export function finalizeEdit(
  input: EditorInput,
  v: EditorVerdict,
  rates: RateTable | null,
  opts: { history?: boolean } = {},
): EditorOutcome {
  const notes: string[] = [];
  const evidence: EditedRound["evidence"] = [];
  const cite = (field: string, c: { quote: string | null; source: string | null }) => {
    if (!grounded(input.pages, c.quote, c.source)) return false;
    evidence.push({ field, url: c.source as string, quote: c.quote as string });
    return true;
  };

  if (v.kind !== "private_company_round") return { action: "drop", reason: `not a private company round: ${v.kind}`, notes: [v.summary] };
  if (v.announcement !== "new_announcement")
    return { action: "drop", reason: `not news: ${v.announcement.replace(/_/g, " ")}`, notes: [v.summary] };
  if (v.source_quality === "unverifiable") return { action: "drop", reason: "no credible page reports it", notes: [v.summary] };
  if (!cite("company", v.company)) return { action: "drop", reason: "no page sentence states the round", notes: [v.summary] };
  const page = input.pages.find((p) => p.url === v.company.source);
  if (!namesCompany(page?.markdown, v.company.name) && !namesCompany(page?.markdown, input.company))
    return { action: "drop", reason: "the cited page does not name the company", notes: [v.summary] };

  const day = v.announced_on.date?.trim() ?? "";
  let announced: string | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    if (cite("announced_on", v.announced_on) || input.pages.some((p) => p.published?.slice(0, 10) === day)) announced = day;
    else notes.push(`date ${day} not stated on its page`);
  }
  const seen = Date.parse(input.firstSeen);
  if (!opts.history && announced && (seen - Date.parse(announced)) / 86_400_000 > NEWS_WINDOW_DAYS)
    return { action: "drop", reason: `old news: announced ${announced}, first seen ${input.firstSeen.slice(0, 10)}`, notes };

  if (!cite("certainty", v.certainty)) return { action: "drop", reason: `certainty "${v.certainty.value}" not stated on a page`, notes };

  let amountText: string | null = null;
  if (v.amount.as_written) {
    const parsed = parseAmount(v.amount.as_written);
    const digits = (v.amount.as_written.match(/\d+(?:[.,]\d+)?/) ?? [""])[0];
    if (parsed.value !== null && cite("amount", v.amount) && flat(v.amount.quote ?? "").includes(flat(digits)))
      amountText = v.amount.as_written;
    else notes.push(`amount ${v.amount.as_written} not stated in its quote`);
  }
  const parsed = parseAmount(amountText);
  const usd = convertToUsd(parsed.value, parsed.currency, rates, amountText);

  let stageLabel: string | null = null;
  if (v.stage.label && cite("stage", v.stage) && flat(v.stage.quote ?? "").includes(flat(v.stage.label).replace(/ extension$/, "")))
    stageLabel = v.stage.label;
  const stage = stageLabel ? classifyStage(stageLabel).stage : null;

  const leadQuote = grounded(input.pages, v.leads.quote, v.leads.source) ? (v.leads.quote as string) : "";
  const leads = v.leads.names.filter((name) => namesCompany(leadQuote, name));
  if (leads.length < v.leads.names.length)
    notes.push(`leads not named in the quote: ${v.leads.names.filter((n) => !leads.includes(n)).join(", ")}`);
  if (leads.length) cite("leads", v.leads);

  const candidate = v.company.website
    ? input.sites.find((s) => registrableDomain(s.url) === registrableDomain(v.company.website))
    : undefined;
  if (v.company.website && !candidate) notes.push(`website ${v.company.website} was not a candidate`);

  return {
    action: "publish",
    notes,
    round: {
      company: {
        name: v.company.name.trim() || input.company,
        website: candidate?.url ?? null,
        domain: candidate ? registrableDomain(candidate.url) : null,
        description: v.company.description,
      },
      stage,
      stage_as_written: stageLabel,
      is_extension: v.is_extension,
      amount_as_written: amountText,
      amount_currency: parsed.currency,
      amount_usd_millions: usd.usd_millions,
      announced_on: announced,
      certainty: v.certainty.value,
      lead_investors: leads,
      other_investors: v.participants.filter((p) => !leads.includes(p)),
      evidence,
    },
  };
}
