// Fold a second reading into a stored round. Fills gaps only: a value the record
// already has is never overwritten, so the agent or a corroborating page can add but
// not contradict. The record is then rescored and, if it still sits in the queue,
// re-dispositioned. Gap-fill (one agent run) and corroboration (a few more articles)
// both land through applyFill; researchRound is the whole gap-fill play for one id.

import type { FeedRecord, GapFill, GapFillInput, RateTable, SourceFitReason } from "@fireround/core";
import {
  canonicalUrl,
  classifyRoundCertainty,
  cleanText,
  convertToUsd,
  DEFAULT_TIERS,
  fetchRates,
  gapFill,
  hostOf,
  namesCompany,
  normalizeCompanyKey,
  normalizeInvestorKey,
  normalizeInvestorName,
  normalizeSector,
  parseAmount,
  parseDate,
  registrableDomain,
  SOCIAL_AND_DIRECTORY_HOSTS,
  scoreConfidence,
  settleDate,
  sourceFit,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { dispositionFor, keptSector, listRounds, type RoundRow, recordRun, sourceClaims, syncRoundInvestors } from "./persist.ts";
import { autoPromotionEligible, investorDomainsForRound, visibilityEvidence } from "./round-verification.ts";
import { loadPublisherTiers } from "./rules.ts";

const { companies, companyAliases, fundingRounds, sources, roundSources } = schema;

/** The Research button's cap per record, and what a gap-fill run is priced at before it runs. */
export const GAP_FILL_CREDITS = 400;

export function toGapFillInput(row: RoundRow): GapFillInput {
  return {
    company_name: row.company.name,
    stage_as_written: row.stage_as_written,
    known: {
      announced_date: row.announced_on,
      amount_as_written: row.amount.as_written,
      lead_investors: row.lead_investors,
      company_website: row.company.website,
    },
    source_urls: row.sources.map((s) => s.url),
  };
}

export interface ApplyOptions {
  rates: RateTable | null;
  tiers: Record<string, number>;
  now?: Date;
  /** A contradictory page may attach as evidence but cannot revise facts before review. */
  protectFacts?: boolean;
}

export interface ApplyResult {
  /** Field names the fill supplied that the record lacked, and "amount" when the company's own release corrected it. */
  filled: string[];
  /** How many sources and investor names the fill added. */
  added: { sources: number; investors: number };
  /** The date on the record after the fill; surfaced so a reviewer sees when a filled date is old. */
  announced_on: string | null;
  confidence: { before: number; after: number };
  disposition: { before: RoundRow["disposition"]; after: RoundRow["disposition"] };
  /** Pages the fill brought that are no source for this company (sourceFit): never attached. */
  refused: Array<{ url: string; reason: SourceFitReason }>;
}

/** What a second reading of a record may add: the gap-fill's one page or corroboration's several. Values are already cleaned. */
export interface RecordFill {
  announced_date: string | null;
  amount_as_written: string | null;
  lead_investors: string[];
  other_investors: string[];
  company_website: string | null;
  headquarters: string | null;
  sector: string | null;
  evidence_quotes: string[];
  /** Each page with the title it carried when read and the sentence read off it, which decide whether it attaches. */
  sources: Array<{ url: string; title?: string | null; published?: string | null; evidence?: string | null; query?: string }>;
  /** Stored as each new source row's query, so News and the company page say where a page came from. */
  query: string;
  officialAnnouncementUrl?: string;
  officialValuation?: string | null;
}

/** A website the agent returned is usable when it is the company's own host, not a publisher or a directory. */
function usableWebsite(url: string | null, sourceHosts: string[]): string | null {
  if (!url) return null;
  const host = hostOf(url);
  if (!host) return null;
  if (sourceHosts.includes(host)) return null;
  if (SOCIAL_AND_DIRECTORY_HOSTS.has(registrableDomain(url) ?? "")) return null;
  return url;
}

/** A gap-fill result as a fill. The agent writes "Not stated" where the schema asked for null, like the extractor does. */
export function gapFillToFill(rawFill: GapFill): RecordFill {
  const sourceUrl = cleanText(rawFill.source_url);
  const quote = cleanText(rawFill.evidence_quote);
  const announced = cleanText(rawFill.announced_date);
  return {
    announced_date: announced,
    amount_as_written: cleanText(rawFill.amount_as_written),
    company_website: cleanText(rawFill.company_website),
    headquarters: cleanText(rawFill.headquarters),
    sector: normalizeSector(cleanText(rawFill.sector)),
    evidence_quotes: quote ? [quote] : [],
    sources: sourceUrl ? [{ url: sourceUrl, published: announced, evidence: quote }] : [],
    lead_investors: rawFill.lead_investors.filter((n) => cleanText(n) !== null),
    other_investors: rawFill.other_investors.filter((n) => cleanText(n) !== null),
    query: "agent:gap-fill",
  };
}

/**
 * Whether the cross-source read confirmed or corrected this row: it stamps how many sources it saw,
 * where the single-page judge does not.
 */
export function isCrossSourceVerified(v: RoundRow["verification"]): boolean {
  return (v?.status === "confirmed" || v?.status === "corrected") && typeof v.sources_seen === "number";
}

export async function applyGapFill(handle: Db, row: RoundRow, rawFill: GapFill, opts: ApplyOptions): Promise<ApplyResult> {
  const filled = gapFillToFill(rawFill);
  if (!rawFill.is_rumor && !rawFill.not_found && filled.sources[0]?.evidence) {
    filled.officialAnnouncementUrl = filled.sources[0].url;
  }
  return applyFill(handle, row, filled, opts);
}

export async function applyFill(handle: Db, row: RoundRow, fill: RecordFill, opts: ApplyOptions): Promise<ApplyResult> {
  const now = opts.now ?? new Date();
  const filled: string[] = [];
  const sourceHosts = row.sources.map((s) => s.host);

  // Date
  let announcedOn = row.announced_on;
  let datePrecision: string | null = null;
  const date = !opts.protectFacts && !announcedOn && fill.announced_date ? parseDate(fill.announced_date, now) : null;
  if (date) {
    announcedOn = date.toISOString().slice(0, 10);
    datePrecision = "day";
    filled.push("date");
  }

  // Money
  let amount = row.amount;
  let fx: ReturnType<typeof convertToUsd> | null = null;
  const written = fill.amount_as_written;
  const parsed = written ? parseAmount(written) : null;
  // A figure the company's own release states outranks one another page gave, as in the read-back:
  // Taktile's row kept a podcast write-up's $120M after the gap-fill brought its release saying $110M.
  const fromOwnRelease =
    written !== null &&
    row.company.domain !== null &&
    fill.sources.some(
      (s) => registrableDomain(s.url) === row.company.domain && (s.evidence ?? fill.evidence_quotes.join(" ")).includes(written),
    );
  const corrects = fromOwnRelease && parsed !== null && (parsed.currency !== amount.currency || parsed.value !== amount.value);
  if (!opts.protectFacts && written && parsed?.value != null && (!amount.as_written || corrects)) {
    fx = convertToUsd(parsed.value, parsed.currency, opts.rates, written);
    amount = { value: parsed.value, currency: parsed.currency, as_written: written, usd_millions: fx.usd_millions };
    filled.push("amount");
  }

  // Investors: add names the record lacks; never demote an existing lead. The fill's names pass
  // the same hygiene as an extraction's: "funds managed by Acme" lands as Acme, a placeholder not at all.
  // A row the cross-source read verified takes none: its lists are what the sources support, and a
  // second reading's names (Ultraviolette's existing backers, off a corroborating page) wait for the
  // read-back that follows a row gaining sources, which lists them only if a source places them in
  // this round.
  const readBack = isCrossSourceVerified(row.verification);
  const fillLeads = readBack ? [] : fill.lead_investors.flatMap((n) => normalizeInvestorName(n) ?? []);
  const fillOthers = readBack ? [] : fill.other_investors.flatMap((n) => normalizeInvestorName(n) ?? []);
  const have = new Set([...row.lead_investors, ...row.other_investors].map(normalizeInvestorKey));
  const newLeads = row.lead_investors.length === 0 ? fillLeads.filter((n) => !have.has(normalizeInvestorKey(n))) : [];
  const newOthers = fillOthers.filter((n) => !have.has(normalizeInvestorKey(n)) && !newLeads.includes(n));
  if (newLeads.length) filled.push("lead");
  if (newOthers.length) filled.push("investors");

  // Website
  const website = row.company.website ? null : usableWebsite(fill.company_website, sourceHosts);
  if (website) filled.push("website");

  // Evidence and sources: what the record does not already hold, one entry per canonical URL, and only
  // a page that is a source for this company: a job posting, a front page, an aggregator's other story,
  // or a page whose title, URL, headline amount, and sentence never place the company there stays off.
  const quotes = fill.evidence_quotes.filter((q, i, all) => !row.evidence_quotes.includes(q) && all.indexOf(q) === i);
  const knownUrls = new Set(row.sources.map((s) => canonicalUrl(s.url)));
  const subject = { name: row.company.name, domain: row.company.domain, aliases: await companyNameAliases(handle, row.company.id) };
  const newSources: RecordFill["sources"] = [];
  const refused: ApplyResult["refused"] = [];
  for (const s of fill.sources) {
    const key = canonicalUrl(s.url);
    if (knownUrls.has(key)) continue;
    knownUrls.add(key);
    // A fill with one page read its sentences off that page.
    const evidence = s.evidence ?? (fill.sources.length === 1 ? fill.evidence_quotes : null);
    const fit = sourceFit({ url: s.url, title: s.title, evidence }, subject, {
      amountValue: amount.value,
      amountCurrency: amount.currency,
    });
    if (!fit.attach) {
      refused.push({ url: s.url, reason: fit.reason });
      continue;
    }
    newSources.push(s);
  }
  const official = fill.sources.find(
    (s) => fill.officialAnnouncementUrl && canonicalUrl(s.url) === canonicalUrl(fill.officialAnnouncementUrl),
  );
  const officialDomain = official && registrableDomain(official.url);
  const officialQuote = official?.evidence ?? null;
  const officialAmount = officialQuote ? parseAmount(officialQuote) : null;
  const currentAmount = parseAmount(row.amount.as_written);
  const previousValuation = parseAmount(row.valuation_as_written);
  const officialValuation = parseAmount(fill.officialValuation);
  const close = (a: number | null, b: number | null) =>
    a !== null && b !== null && a > 0 && b > 0 && Math.abs(a - b) <= 0.25 * Math.max(a, b);
  const officialMatch =
    official &&
    officialDomain &&
    (officialDomain === row.company.domain ||
      ["businesswire.com", "prnewswire.com", "globenewswire.com", "accesswire.com", "newswire.ca"].includes(officialDomain) ||
      (await investorDomainsForRound(handle, row.id)).includes(officialDomain) ||
      (opts.tiers[officialDomain] ?? 0) >= 0.7) &&
    officialQuote &&
    namesCompany(officialQuote, row.company.name) &&
    /\b(?:announc(?:ed|es)|raised|secured|closed|completed)\b/i.test(officialQuote) &&
    classifyRoundCertainty(officialQuote) === "announced" &&
    ((officialAmount?.currency === currentAmount.currency && close(officialAmount?.value ?? null, currentAmount.value)) ||
      (previousValuation.currency === officialValuation.currency && close(previousValuation.value, officialValuation.value))) &&
    (newSources.includes(official) || row.sources.some((s) => canonicalUrl(s.url) === canonicalUrl(official.url)));
  const certainty = !opts.protectFacts && row.certainty !== "announced" && officialMatch ? "announced" : row.certainty;
  if (certainty !== row.certainty) filled.push("certainty");
  if (certainty !== row.certainty && !row.pinned?.announced_on && fill.announced_date) {
    const officialDay = parseDate(fill.announced_date, now);
    if (officialDay) {
      announcedOn = officialDay.toISOString().slice(0, 10);
      datePrecision = "day";
      filled.push("date");
    }
  }
  if (newSources.length) filled.push("source");

  const leads = [...row.lead_investors, ...newLeads];
  const evidence = [...row.evidence_quotes, ...quotes];
  const previousClaims = await handle
    .select({ sourceId: roundSources.sourceId, claims: roundSources.fieldClaims })
    .from(roundSources)
    .where(eq(roundSources.roundId, row.id));
  const previousEvidence = new Map(
    previousClaims.map((claim) => [claim.sourceId, (claim.claims as { evidence?: string | null } | null)?.evidence ?? null]),
  );
  const allSources = [
    ...row.sources.map((s) => ({
      url: s.url,
      host: s.host,
      title: s.title,
      published: s.published ?? null,
      evidence: previousEvidence.get(canonicalUrl(s.url)),
    })),
    ...newSources.map((s) => ({
      url: s.url,
      host: hostOf(s.url),
      title: s.title ?? null,
      published: s.published ?? null,
      evidence: s.evidence,
    })),
  ];

  const unsettled: FeedRecord = {
    id: row.id,
    company_key: normalizeCompanyKey(row.company.name),
    company_name: row.company.name,
    company_domain: row.company.domain ?? registrableDomain(website),
    company_website: row.company.website ?? website,
    company_description: row.company.description,
    stage: row.stage,
    stage_as_written: row.stage_as_written,
    is_extension: row.is_extension,
    amount: { ...amount, fx_rate: fx?.fx_rate ?? null, fx_date: fx?.fx_date ?? null },
    valuation_as_written: row.valuation_as_written,
    lead_investors: leads,
    other_investors: [...row.other_investors, ...newOthers],
    announced_date: announcedOn,
    certainty: row.certainty,
    // A date the agent found on a press release is a day; a date the row already had keeps its own precision.
    date_precision: announcedOn ? (announcedOn === row.announced_on ? row.date_precision : "day") : "unknown",
    date_basis: announcedOn ? (announcedOn === row.announced_on ? (row.date_basis ?? undefined) : "stated") : "none",
    // The judge's verdict rides along, so the recomputed disposition still requires the page's confirmation.
    verification: (row.verification as FeedRecord["verification"]) ?? undefined,
    headquarters: row.company.hq,
    sector: row.company.sector,
    evidence_quotes: evidence,
    sources: allSources.map((s) => ({ url: s.url, host: s.host, title: s.title ?? undefined, published: s.published ?? undefined })),
    confidence: 0,
    status: "updated",
    undated: announcedOn === null,
  };
  // The pages just read may hold a surer day than the row's (a release, a ranked publisher's dated URL):
  // Gimlet kept a republisher's Sep 5 through six audits while SiliconANGLE's Sep 4 sat in its sources.
  // A row that does not know where its day came from moves only a rough date.
  const beforeSettle = { date: announcedOn, precision: datePrecision ?? row.date_precision };
  const scored =
    opts.protectFacts || certainty !== row.certainty ? unsettled : settleDate(unsettled, { onlyRough: unsettled.date_basis === undefined });
  // A pinned day is a person's word (fix-records): settling never moves it.
  if (
    !opts.protectFacts &&
    !row.pinned?.announced_on &&
    (scored.announced_date !== beforeSettle.date || (announcedOn && scored.date_precision !== beforeSettle.precision))
  ) {
    announcedOn = scored.announced_date;
    datePrecision = scored.date_precision;
    if (!filled.includes("date")) filled.push("date");
  }
  scored.confidence = scoreConfidence(scored, opts.tiers);
  const after =
    row.disposition === "review" &&
    row.freshness_checked_on === announcedOn &&
    autoPromotionEligible(row.verification?.notes, row.preset_slug) &&
    Math.max(row.verification?.sources_seen ?? 0, row.verification?.sources_listed ?? 0) >= allSources.length &&
    visibilityEvidence(allSources, row.company.domain, await investorDomainsForRound(handle, row.id), opts.tiers)
      ? dispositionFor(scored)
      : row.disposition;
  const added = { sources: newSources.length, investors: newLeads.length + newOthers.length };

  if (filled.length === 0 && scored.confidence === row.confidence) {
    return {
      filled,
      added,
      announced_on: announcedOn,
      confidence: { before: row.confidence, after: scored.confidence },
      disposition: { before: row.disposition, after: row.disposition },
      refused,
    };
  }

  await handle
    .update(fundingRounds)
    .set({
      announcedOn,
      ...(datePrecision ? { datePrecision, dateBasis: certainty !== row.certainty ? "page" : (scored.date_basis ?? null) } : {}),
      amountValue: amount.value?.toString() ?? null,
      amountCurrency: amount.currency,
      amountAsWritten: amount.as_written,
      amountUsdMillions: amount.usd_millions?.toString() ?? null,
      ...(fx ? { fxRate: fx.fx_rate?.toString() ?? null, fxDate: fx.fx_date } : {}),
      evidenceQuotes: evidence,
      confidence: scored.confidence.toFixed(2),
      certainty,
      ...(certainty !== row.certainty
        ? {
            reportedOn: row.reported_on ?? row.announced_on ?? now.toISOString().slice(0, 10),
            verification: {
              ...(row.verification ?? { status: "unverified", notes: [], url: null }),
              notes: [
                ...new Set([
                  ...(row.verification?.notes ?? []),
                  `Reported before its announcement on ${row.reported_on ?? row.announced_on ?? now.toISOString().slice(0, 10)}`,
                ]),
              ],
            },
          }
        : {}),
      disposition: after,
      // A change is news only to someone who already read the row: an unseen row stays new, and a
      // history row (an earlier round promoted from a dossier) is never unread.
      status: sql`CASE WHEN ${fundingRounds.status} = 'seen' AND NOT ${fundingRounds.history} THEN 'updated' ELSE ${fundingRounds.status} END`,
      updatedAt: now,
    })
    .where(eq(fundingRounds.id, row.id));

  // One write path for investors, shared with the sweep: reconciled against what the round already has.
  await syncRoundInvestors(handle, row.id, newLeads, newOthers);

  if (website) {
    // companies.domain is unique; a domain another company already owns stays theirs.
    const domain = registrableDomain(website);
    const taken = domain
      ? await handle
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.domain, domain), ne(companies.id, row.company.id)))
          .limit(1)
      : [];
    await handle
      .update(companies)
      .set({
        website,
        ...(domain && taken.length === 0 ? { domain: sql`COALESCE(${companies.domain}, ${domain})` } : {}),
        hq: sql`COALESCE(${companies.hq}, ${fill.headquarters})`,
        sector: keptSector(fill.sector),
        updatedAt: now,
      })
      .where(eq(companies.id, row.company.id));
  } else if (fill.headquarters || fill.sector) {
    await handle
      .update(companies)
      .set({
        hq: sql`COALESCE(${companies.hq}, ${fill.headquarters})`,
        sector: keptSector(fill.sector),
        updatedAt: now,
      })
      .where(eq(companies.id, row.company.id));
  }

  for (const s of newSources) {
    const sourceId = canonicalUrl(s.url);
    await handle
      .insert(sources)
      .values({
        id: sourceId,
        url: sourceId,
        host: hostOf(s.url),
        title: s.title ?? null,
        publishedAt: s.published ?? null,
        query: s.query ?? fill.query,
      })
      .onConflictDoNothing();
    await handle
      .insert(roundSources)
      .values({ roundId: row.id, sourceId, fieldClaims: sourceClaims({ title: s.title, evidence: s.evidence }) })
      .onConflictDoNothing();
  }

  return {
    filled,
    added,
    announced_on: announcedOn,
    confidence: { before: row.confidence, after: scored.confidence },
    disposition: { before: row.disposition, after },
    refused,
  };
}

/** The other names a company was seen under (a merge keeps the folded row's name key as one), for the source rule. */
export async function companyNameAliases(handle: Db, companyId: string): Promise<string[]> {
  const rows = await handle
    .select({ alias: companyAliases.alias })
    .from(companyAliases)
    .where(and(eq(companyAliases.companyId, companyId), eq(companyAliases.kind, "name")));
  return rows.map((r) => r.alias);
}

export type ResearchOutcome =
  | { status: "failed"; creditsUsed: number | null }
  | { status: "not_found" | "rumor"; creditsUsed: number | null }
  | {
      status: "completed";
      filled: string[];
      announced_on: string | null;
      confidence: { before: number; after: number };
      disposition: { before: string; after: string };
      creditsUsed: number | null;
    };

/**
 * One bounded /agent run for one review item: read the record's own sources, find the press
 * release, fill what is missing. Known values are never overwritten. The record is rescored and
 * leaves the queue on its own if it now qualifies. Every run lands in Runs, failures included.
 * The Research button and the auto gap-fill step both run this.
 */
export async function researchRound(handle: Db, client: Firecrawl, id: string, opts: { now?: Date } = {}): Promise<ResearchOutcome> {
  const { rows } = await listRounds(handle, { ids: [id], includeReview: true, limit: 1 });
  const row = rows[0];
  if (!row) throw new Error("Record not found.");

  const started = opts.now ?? new Date();
  const result = await gapFill(client, toGapFillInput(row));
  const runBase = {
    id: `gapfill:${id}:${started.getTime()}`,
    presetSlug: "review",
    lane: "agent",
    window: null,
    startedAt: started,
    finishedAt: new Date(),
    creditsEstimated: GAP_FILL_CREDITS,
    creditsMeasured: result.creditsUsed,
  };

  if (result.status !== "completed" || !result.fill) {
    await recordRun(handle, { ...runBase, error: `agent ${result.status}`, counts: { companies: 1 } });
    return { status: "failed", creditsUsed: result.creditsUsed };
  }
  if (result.fill.not_found || result.fill.is_rumor) {
    await recordRun(handle, { ...runBase, counts: { companies: 1, filled: 0 } });
    return { status: result.fill.is_rumor ? "rumor" : "not_found", creditsUsed: result.creditsUsed };
  }

  const rates = await fetchRates("latest").catch(() => null);
  const tiers = { ...DEFAULT_TIERS, ...(await loadPublisherTiers()) };
  const applied = await applyGapFill(handle, row, result.fill, { rates, tiers });
  await recordRun(handle, { ...runBase, counts: { companies: 1, filled: applied.filled.length } });
  return { status: "completed", ...applied, creditsUsed: result.creditsUsed };
}
