// History rounds at the store. A checked dossier lists a company's earlier rounds as text; each is
// promoted to a real round only when its own announcement is found and read through the normal
// pipeline: one search (and a map of the company's site) for the announcement, the best pages read
// with the rounds schema, the resolver's rules and dating inside a window around the dossier's date,
// the read-back against every source (the reconcile step, or the judge without a model key), and
// persist with its identity and merge rules. A round with no page that states it stays dossier text.
// A funding event Apollo lists that the store lacks joins the same ledger as a lead (origin apollo,
// lib/apollo.ts) and goes through the same steps; it needs no dossier, and it is never a fact until
// a page states it. So do two more kinds of lead: a prior round the dossier check dropped only because
// the pages it read were silent (origin check), a hand-checked round an audit queued with the page
// that states it (origin audit, `pnpm fix-records`), and an earlier round a page stated beside the
// later round it announced, a stealth launch's seed with its Series A (origin page, lib/persist.ts).
// A lead's own page keeps the earlier rounds it states beside a later one (keepEarlierRounds): it is
// often the only announcement such a round gets.
//
// What persists is marked history (funding_rounds.history): never delivered, never unread, never
// trending, left out of the feed's default view, listed and counted on company and investor pages.
// The ledger (history_promotions) holds one row per prior round, so every promotion is idempotent
// and a failure retries on a backoff. The durable wrapper is workflows/history.ts; the pure rules are
// packages/core/src/records/history.ts.

import type {
  CompanyDossier,
  ExtractResult,
  ExtractTarget,
  FeedRecord,
  HistoryCandidate,
  PageClassifier,
  PageVerdict,
  RateTable,
} from "@fireround/core";
import {
  canonicalUrl,
  companySite,
  convertToUsd,
  DEFAULT_TIERS,
  extractionCredits,
  extractRounds,
  fetchRates,
  firecrawlReader,
  HISTORY_STAGES,
  historyQuery,
  historyWindow,
  isArticleUrl,
  isFundingAggregatorUrl,
  isStageless,
  jevClassifier,
  judgeRecords,
  knownRound,
  matchPriorRound,
  newsroomSearch,
  notAPrimarySource,
  parseStoredDossier,
  priorAsKnown,
  priorDateRange,
  priorKey,
  promotable,
  RATE,
  rankHistoryCandidates,
  reconcileModel,
  reconcileRecords,
  resolveRounds,
  STAGE_BANDS,
  searchCredits,
  settleDate,
  verdictSummary,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import type { HistoryOrigin, HistoryPrior } from "@fireround/core/db/schema";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Document, Firecrawl, SearchResultNews, SearchResultWeb } from "firecrawl";
import { verifiedDossierSql } from "./deepdive.ts";
import {
  failedOutcome,
  HISTORY_BACKOFF_HOURS,
  HISTORY_MAX_ATTEMPTS,
  type HistoryTally,
  type PromotionOutcome,
  skippedOutcome,
} from "./history-tally.ts";
import { persistRecords, recordRun } from "./persist.ts";
import { loadAliases, loadPublisherTiers } from "./rules.ts";

export * from "./history-tally.ts";

const { companies, enrichments, fundingRounds, historyPromotions } = schema;

/**
 * A round announced this recently is the feed's to find, not history's: its promotion waits until the
 * news window has passed, so a history row never lands in this week's numbers or next to the news.
 */
export const HISTORY_RECENT_DAYS = 7;
/** Pages read at most per prior round, best first; reading stops at the first page that states it. */
export const HISTORY_PAGES = 5;
/** Search results asked for: one search credit unit is ten. */
export const HISTORY_SEARCH_RESULTS = 10;
/** How long a claim on a prior round holds: a pass that died mid-round lets another pass take it after this. */
export const HISTORY_CLAIM_MINUTES = 30;
/** The preset a history row files under when the company has no other round to borrow one from. */
const FALLBACK_PRESET = "series-a-b";

const DAY = 86_400_000;

export type PromotionStatus = "pending" | "running" | "promoted" | "no_source" | "failed" | "skipped";

/** The company as a promotion reads it: its identity, the preset its rows file under, and the pages its dossier cited for prior rounds. */
export interface HistorySubject {
  id: string;
  name: string;
  nameKey: string;
  domain: string | null;
  website: string | null;
  aliasKeys: string[];
  /** Other sites the company publishes on (its homepage's links to a blog on another domain), stored as domain aliases. */
  sites: string[];
  presetSlug: string;
  /** Prior round key to the pages the dossier check cited for it; `*` holds the ones it could not place. */
  citedUrls: Record<string, string[]>;
}

/**
 * The prior rounds a check dropped only for want of evidence, kept whole on its record: leads, not
 * facts. Microsoft's $10 billion in OpenAI was dropped by a check that read eight pages, none of them
 * its announcement; the history pass looks for exactly that page.
 */
export function droppedPriorLeads(data: unknown): HistoryPrior[] {
  const dropped = (data as { verification?: { dropped?: Array<{ field?: string; prior?: HistoryPrior }> } } | null)?.verification?.dropped;
  if (!Array.isArray(dropped)) return [];
  return dropped
    .filter((d) => d.field === "prior_rounds" && d.prior && typeof d.prior.stage_as_written === "string")
    .map((d) => ({
      stage_as_written: d.prior?.stage_as_written ?? "",
      amount_as_written: d.prior?.amount_as_written ?? null,
      announced_date: d.prior?.announced_date ?? null,
      lead_investors: Array.isArray(d.prior?.lead_investors) ? (d.prior?.lead_investors ?? []) : [],
    }));
}

/** The dossier's prior rounds with their keys, when the company has a checked dossier, and the rounds its check left as leads. */
async function checkedDossier(
  handle: Db,
  companyId: string,
): Promise<{ dossier: CompanyDossier; citations: Record<string, string>; leads: HistoryPrior[] } | null> {
  const [row] = await handle
    .select({ data: enrichments.data })
    .from(enrichments)
    .where(and(eq(enrichments.companyId, companyId), eq(enrichments.kind, "deep_dive"), verifiedDossierSql))
    .limit(1);
  if (!row) return null;
  const dossier = parseStoredDossier(row.data);
  if (!dossier) return null;
  const citations = (row.data as { verification?: { citations?: Record<string, string> } }).verification?.citations ?? {};
  return { dossier, citations, leads: droppedPriorLeads(row.data) };
}

/**
 * The pages the dossier check cited for each kept prior round. The check keys a citation by the
 * round's index before it dropped any, and keeps the survivors in order, so when every kept round has
 * a citation the two lists zip; otherwise the cited pages are offered to every prior round (`*`).
 */
export function citedPriorUrls(dossier: Pick<CompanyDossier, "prior_rounds">, citations: Record<string, string>): Record<string, string[]> {
  const cited = Object.entries(citations)
    .map(([k, url]) => ({ i: Number(/^prior_rounds\[(\d+)\]$/.exec(k)?.[1] ?? Number.NaN), url }))
    .filter((c) => Number.isInteger(c.i) && /^https?:\/\//i.test(c.url))
    .sort((a, b) => a.i - b.i);
  if (cited.length > 0 && cited.length === dossier.prior_rounds.length) {
    return Object.fromEntries(dossier.prior_rounds.map((p, i) => [priorKey(p), [cited[i].url]]));
  }
  return { "*": [...new Set(cited.map((c) => c.url))] };
}

/**
 * The company as the promotion reads it, or null when it (or, for a dossier's prior round, its
 * checked dossier) is gone. A lead needs no dossier: `requireDossier: false` reads the company alone.
 */
export async function historySubject(
  handle: Db,
  companyId: string,
  opts: { requireDossier?: boolean } = {},
): Promise<HistorySubject | null> {
  const [[company], aliasRows, presetRows, checked] = await Promise.all([
    handle.select().from(companies).where(eq(companies.id, companyId)).limit(1),
    handle
      .select({ key: schema.companyAliases.aliasKey, kind: schema.companyAliases.kind })
      .from(schema.companyAliases)
      .where(and(eq(schema.companyAliases.companyId, companyId), inArray(schema.companyAliases.kind, ["name", "domain"]))),
    // The preset its newest feed round files under, so a preset-filtered page shows the company's whole history.
    handle
      .select({ preset: fundingRounds.presetSlug })
      .from(fundingRounds)
      .where(and(eq(fundingRounds.companyId, companyId), ne(fundingRounds.presetSlug, "form-d"), eq(fundingRounds.history, false)))
      .orderBy(sql`${fundingRounds.announcedOn} desc nulls last`)
      .limit(1),
    checkedDossier(handle, companyId),
  ]);
  if (!company || (!checked && opts.requireDossier !== false)) return null;
  return {
    id: company.id,
    name: company.name,
    nameKey: company.nameKey,
    domain: company.domain,
    website: company.website,
    aliasKeys: aliasRows.filter((a) => a.kind === "name").map((a) => a.key),
    sites: aliasRows.filter((a) => a.kind === "domain").map((a) => a.key),
    presetSlug: presetRows[0]?.preset ?? FALLBACK_PRESET,
    citedUrls: checked ? citedPriorUrls(checked.dossier, checked.citations) : {},
  };
}

/** A ledger row needs its company's checked dossier only when the row came from one; a lead of any origin does not. */
function needsDossier(origin: HistoryOrigin | null | undefined): boolean {
  return !origin || origin === "dossier";
}

/** Whether a ledger row is due: queued, failed with tries left and its backoff over, or claimed by a pass whose claim lapsed. */
export function due(row: { status: string; attempts: number; nextAttemptAt: Date }, now: Date): boolean {
  if (row.nextAttemptAt.getTime() > now.getTime()) return false;
  return row.status === "pending" || row.status === "running" || (row.status === "failed" && row.attempts < HISTORY_MAX_ATTEMPTS);
}

/**
 * Take one prior round for this pass: a due row becomes running, held by `claimer` for
 * HISTORY_CLAIM_MINUTES. A row this claimer already holds is taken again (a retried step), so the
 * backfill and a dossier's own pass never search the same prior round at once. False when the round
 * is not due or another pass holds it.
 */
export async function claimPrior(handle: Db, companyId: string, key: string, claimer: string, now: Date = new Date()): Promise<boolean> {
  const rows = await handle
    .update(historyPromotions)
    .set({ status: "running", claimedBy: claimer, nextAttemptAt: new Date(now.getTime() + HISTORY_CLAIM_MINUTES * 60_000), updatedAt: now })
    .where(
      and(
        eq(historyPromotions.companyId, companyId),
        eq(historyPromotions.priorKey, key),
        sql`(
          (${historyPromotions.status} = 'pending' and ${historyPromotions.nextAttemptAt} <= ${now})
          or (${historyPromotions.status} = 'failed' and ${historyPromotions.attempts} < ${HISTORY_MAX_ATTEMPTS} and ${historyPromotions.nextAttemptAt} <= ${now})
          or (${historyPromotions.status} = 'running' and (${historyPromotions.claimedBy} = ${claimer} or ${historyPromotions.nextAttemptAt} <= ${now}))
        )`,
      ),
    )
    .returning({ key: historyPromotions.priorKey });
  return rows.length > 0;
}

/**
 * Put a company's prior rounds on the ledger (a round already there is left as it is) and return the
 * keys due now, in the dossier's order, then its Apollo leads that are due. A round too vague to
 * recognise (no specific stage, no amount, no dated day) is written skipped and never searched. Only
 * the rounds the current dossier lists are returned: one a newer dossier dropped is not looked for.
 */
export async function queueCompanyHistory(handle: Db, companyId: string, now: Date = new Date()): Promise<string[]> {
  const checked = await checkedDossier(handle, companyId);
  // The rounds the check left as leads join the ledger first, so they are among the leads due below.
  for (const p of checked?.leads ?? []) {
    const vague = !promotable(p);
    await handle
      .insert(historyPromotions)
      .values({
        companyId,
        priorKey: priorKey(p),
        prior: p,
        origin: "check",
        status: vague ? "skipped" : "pending",
        nextAttemptAt: now,
        outcome: vague ? { reason: "too vague to recognise: no stage, amount, or day" } : null,
      })
      .onConflictDoNothing();
  }
  const leads = await dueLeads(handle, companyId, now);
  if (!checked) return leads;
  const priors = checked.dossier.prior_rounds;
  if (priors.length === 0) return leads;
  const keys = priors.map(priorKey);
  // A round a request's funding search already put on the ledger is worked once, as that lead.
  const searched = await handle
    .select({ key: historyPromotions.priorKey, prior: historyPromotions.prior })
    .from(historyPromotions)
    .where(and(eq(historyPromotions.companyId, companyId), eq(historyPromotions.origin, "search")));
  for (const p of priors) {
    const vague = !promotable(p);
    const same = searched.find((row) => knownRound(priorAsKnown(p), [priorAsKnown(row.prior)]));
    await handle
      .insert(historyPromotions)
      .values({
        companyId,
        priorKey: priorKey(p),
        prior: p satisfies HistoryPrior,
        status: vague || same ? "skipped" : "pending",
        // Due from this call's clock, not the database's, which can read a moment later.
        nextAttemptAt: now,
        outcome: same
          ? { reason: "the same round as a funding search lead", duplicateOf: same.key }
          : vague
            ? { reason: "too vague to recognise: no stage, amount, or day" }
            : null,
      })
      .onConflictDoNothing();
  }
  const rows = await handle
    .select()
    .from(historyPromotions)
    .where(and(eq(historyPromotions.companyId, companyId), inArray(historyPromotions.priorKey, keys)));
  const byKey = new Map(rows.map((r) => [r.priorKey, r]));
  const fromDossier = [...new Set(keys)].filter((k) => {
    const r = byKey.get(k);
    return r ? due(r, now) : false;
  });
  return [...fromDossier, ...leads.filter((k) => !fromDossier.includes(k))];
}

/** A company's leads (Apollo, check, audit) that are due now. */
async function dueLeads(handle: Db, companyId: string, now: Date): Promise<string[]> {
  const rows = await handle
    .select()
    .from(historyPromotions)
    .where(and(eq(historyPromotions.companyId, companyId), ne(historyPromotions.origin, "dossier")))
    .orderBy(historyPromotions.createdAt);
  return rows.filter((r) => due(r, now)).map((r) => r.priorKey);
}

/** Verified dossiers of visible companies, newest round first, with their prior rounds. */
async function dossiersWithPriors(
  handle: Db,
): Promise<Array<{ companyId: string; latest: string | null; priors: HistoryPrior[]; leads: HistoryPrior[] }>> {
  // The outer table is named in full: drizzle writes a single table's columns unqualified, and a bare
  // `company_id` inside the subquery binds to funding_rounds' own column, matching every visible round.
  const rows = await handle
    .select({
      companyId: enrichments.companyId,
      data: enrichments.data,
      latest: sql<
        string | null
      >`(select max(f.announced_on) from funding_rounds f where f.company_id = enrichments.company_id and f.disposition in ('publish', 'flagged'))`,
    })
    .from(enrichments)
    .where(
      and(
        eq(enrichments.kind, "deep_dive"),
        verifiedDossierSql,
        sql`exists (select 1 from funding_rounds f where f.company_id = enrichments.company_id and f.disposition in ('publish', 'flagged'))`,
      ),
    );
  return rows
    .map((r) => ({
      companyId: r.companyId,
      latest: r.latest,
      priors: parseStoredDossier(r.data)?.prior_rounds ?? [],
      leads: droppedPriorLeads(r.data),
    }))
    .filter((r) => r.priors.length > 0 || r.leads.length > 0)
    .sort((a, b) => (b.latest ?? "").localeCompare(a.latest ?? "") || a.companyId.localeCompare(b.companyId));
}

/**
 * The companies the backfill works: a visible company's checked dossier with a prior round never put
 * on the ledger, or one queued or failed and due. Newest round first; `limit` counts dossiers, so a
 * pilot of ten works ten companies whatever their prior rounds number.
 */
export async function historyTargets(handle: Db, opts: { limit?: number | null; now?: Date } = {}): Promise<string[]> {
  const now = opts.now ?? new Date();
  const [dossiers, leadCompanies] = await Promise.all([dossiersWithPriors(handle), companiesWithDueLeads(handle, now)]);
  if (dossiers.length === 0) return opts.limit ? leadCompanies.slice(0, opts.limit) : leadCompanies;
  const ledger = await handle
    .select({
      companyId: historyPromotions.companyId,
      priorKey: historyPromotions.priorKey,
      status: historyPromotions.status,
      attempts: historyPromotions.attempts,
      nextAttemptAt: historyPromotions.nextAttemptAt,
    })
    .from(historyPromotions)
    .where(
      inArray(
        historyPromotions.companyId,
        dossiers.map((d) => d.companyId),
      ),
    );
  const rows = new Map(ledger.map((r) => [`${r.companyId} ${r.priorKey}`, r]));
  const out: string[] = [];
  for (const d of dossiers) {
    if (opts.limit && out.length >= opts.limit) break;
    const work = [...d.priors, ...d.leads].some((p) => {
      const r = rows.get(`${d.companyId} ${priorKey(p)}`);
      return r ? due(r, now) : promotable(p);
    });
    if (work) out.push(d.companyId);
  }
  // Then the companies with a lead due and no dossier work of their own.
  for (const id of leadCompanies) {
    if (opts.limit && out.length >= opts.limit) break;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Visible companies with a lead due (Apollo, check, audit), newest round first. An audit's lead is
 * worked even when the company has no visible round: a hand check that rejected Anthropic's two
 * bogus rows left its real history, cited round by round, as the only way back onto the feed, and
 * a filter on visibility kept it off for good. Those come last.
 */
async function companiesWithDueLeads(handle: Db, now: Date): Promise<string[]> {
  // history_promotions is named in full for the reason dossiersWithPriors gives.
  const rows = await handle
    .select({
      companyId: historyPromotions.companyId,
      origin: historyPromotions.origin,
      status: historyPromotions.status,
      attempts: historyPromotions.attempts,
      nextAttemptAt: historyPromotions.nextAttemptAt,
      latest: sql<
        string | null
      >`(select max(f.announced_on) from funding_rounds f where f.company_id = history_promotions.company_id and f.disposition in ('publish', 'flagged'))`,
    })
    .from(historyPromotions)
    .where(and(ne(historyPromotions.origin, "dossier"), inArray(historyPromotions.status, ["pending", "running", "failed"])));
  const ready = rows.filter((r) => (r.latest !== null || r.origin === "audit") && due(r, now));
  ready.sort((a, b) => (b.latest ?? "").localeCompare(a.latest ?? "") || a.companyId.localeCompare(b.companyId));
  return [...new Set(ready.map((r) => r.companyId))];
}

export interface HistoryCoverage {
  /** Visible companies with a checked dossier that lists prior rounds. */
  dossiers: number;
  prior_rounds: number;
  /** Prior rounds not yet on the ledger. */
  unqueued: number;
  pending: number;
  promoted: number;
  no_source: number;
  failed: number;
  skipped: number;
  /** Rows on the store marked history. */
  history_rows: number;
  /** Apollo leads on the ledger by status, kept apart so their yield can be measured. */
  apollo_leads: Record<string, number>;
}

/** Where the store stands: the prior rounds the dossiers list and what became of them. */
export async function historyCoverage(handle: Db): Promise<HistoryCoverage> {
  const [dossiers, ledger, [rows]] = await Promise.all([
    dossiersWithPriors(handle),
    handle
      .select({
        companyId: historyPromotions.companyId,
        priorKey: historyPromotions.priorKey,
        status: historyPromotions.status,
        origin: historyPromotions.origin,
      })
      .from(historyPromotions),
    handle.select({ n: sql<number>`count(*)::int` }).from(fundingRounds).where(eq(fundingRounds.history, true)),
  ]);
  const byKey = new Map(ledger.map((r) => [`${r.companyId} ${r.priorKey}`, r.status]));
  const out: HistoryCoverage = {
    dossiers: dossiers.length,
    prior_rounds: 0,
    unqueued: 0,
    pending: 0,
    promoted: 0,
    no_source: 0,
    failed: 0,
    skipped: 0,
    history_rows: rows?.n ?? 0,
    apollo_leads: {},
  };
  for (const r of ledger) if (r.origin === "apollo") out.apollo_leads[r.status] = (out.apollo_leads[r.status] ?? 0) + 1;
  for (const d of dossiers) {
    for (const key of new Set(d.priors.map(priorKey))) {
      out.prior_rounds++;
      const status = byKey.get(`${d.companyId} ${key}`);
      if (!status) out.unqueued++;
      else if (status === "running") out.pending++;
      else if (status in out) out[status as "pending" | "promoted" | "no_source" | "failed" | "skipped"]++;
    }
  }
  return out;
}

/** What a promotion reads the web with. Injected in tests, so no network is touched. */
export interface HistoryReader {
  search(query: string, limit: number): Promise<HistoryCandidate[]>;
  /** The company's own links for a search term; empty when the site will not map. */
  map(domain: string, search: string): Promise<HistoryCandidate[]>;
  extract(targets: ExtractTarget[]): Promise<ExtractResult>;
  /** The read-back: every source read together by the reconcile model, or the judge on the primary page without a key. */
  verify(
    records: FeedRecord[],
    rates: RateTable | null,
    tiers: Record<string, number>,
  ): Promise<{ records: FeedRecord[]; credits: number }>;
  rates(date: string): Promise<RateTable | null>;
  /** Reads a page's title and snippet before it is paid for (Jev, with TYPESAFE_API_KEY); absent, the rules decide alone. */
  classify?: PageClassifier;
}

/** Results classified at most per search: past it the rest keep the rules' reading. */
const CLASSIFIED_RESULTS = 40;

/**
 * The candidates with the classifier's verdict on each one it can read (a title or a snippet to go
 * on), in the order given. Without a classifier, or for a page it could not read, a candidate is as it was.
 */
export async function classifyCandidates(
  reader: HistoryReader,
  company: string,
  candidates: HistoryCandidate[],
): Promise<HistoryCandidate[]> {
  if (!reader.classify) return candidates;
  const readable = [...new Map(candidates.filter((c) => c.title || c.description).map((c) => [canonicalUrl(c.url), c])).values()].slice(
    0,
    CLASSIFIED_RESULTS,
  );
  const verdicts = await reader
    .classify(readable.map((c) => ({ company, url: c.url, title: c.title, snippet: c.description })))
    .catch(() => []);
  const byUrl = new Map(readable.map((c, i) => [canonicalUrl(c.url), verdicts[i] ?? null]));
  return candidates.map((c) => {
    const verdict = byUrl.get(canonicalUrl(c.url));
    return verdict ? { ...c, verdict } : c;
  });
}

/** The reader over Firecrawl: search, map, the rounds extraction, and the same read-back the ingest runs. */
export function firecrawlHistoryReader(client: Firecrawl): HistoryReader {
  return {
    async search(query, limit) {
      const result = await client.search(query, { sources: ["web", "news"], limit, highlights: true });
      const out: HistoryCandidate[] = [];
      for (const kind of ["web", "news"] as const) {
        for (const item of (result[kind] ?? []) as Array<SearchResultWeb | SearchResultNews | Document>) {
          const url = "url" in item ? item.url : (item as Document).metadata?.sourceURL;
          if (!url) continue;
          const title = ("title" in item ? item.title : (item as Document).metadata?.title) ?? undefined;
          const description =
            "description" in item
              ? (item as SearchResultWeb).description
              : "snippet" in item
                ? (item as SearchResultNews).snippet
                : undefined;
          const published = "date" in item ? (item as SearchResultNews).date : undefined;
          const highlights = "highlights" in item && typeof item.highlights === "string" ? item.highlights : "";
          out.push({ url, title, description: [description, highlights].filter(Boolean).join(" ") || undefined, published, via: "search" });
        }
      }
      return out;
    },
    async map(domain, search) {
      try {
        const result = await client.map(`https://${domain}`, { search, limit: 30, includeSubdomains: true, timeout: 30_000 });
        return (result.links ?? []).map((l) => ({ url: l.url, title: l.title, description: l.description, via: "site" as const }));
      } catch {
        return [];
      }
    },
    extract(targets) {
      // Old announcements rarely change; a week-old cached copy reads the same and costs no fetch.
      return extractRounds(client, targets, { concurrency: 1, maxAge: 7 * DAY });
    },
    async verify(records, rates, tiers) {
      const model = reconcileModel(process.env, "history");
      if (model) {
        const r = await reconcileRecords(records, firecrawlReader(client), model, { rates, tiers });
        return { records: r.records, credits: r.creditsEstimated };
      }
      const r = await judgeRecords(client, records, { rates, tiers });
      return { records: r.records.map((x) => settleDate(x)), credits: r.creditsEstimated };
    },
    async rates(date) {
      return fetchRates(date).catch(() => fetchRates("latest").catch(() => null));
    },
    classify: jevClassifier() ?? undefined,
  };
}

/** The ledger row for one prior round. */
async function ledgerRow(handle: Db, companyId: string, key: string) {
  const [row] = await handle
    .select()
    .from(historyPromotions)
    .where(and(eq(historyPromotions.companyId, companyId), eq(historyPromotions.priorKey, key)))
    .limit(1);
  return row ?? null;
}

/** What the search found for one prior round: the pages to read, best first, or why none will be read. */
export interface HistoryPlan {
  companyId: string;
  priorKey: string;
  prior: HistoryPrior;
  /** Where the prior round came from; a lead needs no dossier. */
  origin: HistoryOrigin;
  query: string | null;
  candidates: HistoryCandidate[];
  credits: number;
  /** Set when nothing is searched: the company or its dossier is gone, the round is too recent, already done, or another pass holds it. */
  skip: "gone" | "recent" | "done" | "claimed" | null;
}

/** Sites mapped for a round's post at most: the company's domain and the first blog its homepage links. */
const MAPPED_SITES = 2;

/** The day a prior round's rates are read for: its own day, the middle of its month or year, or today. */
function rateDay(date: string | null, now: Date): string {
  const range = priorDateRange(date);
  if (!range) return now.toISOString().slice(0, 10);
  return new Date((range.from.getTime() + range.to.getTime()) / 2).toISOString().slice(0, 10);
}

/**
 * Step one: the search. A map of the company's own site (one credit, when the domain is known), one
 * search for the announcement (two credits for ten results), and the pages the dossier check cited
 * for this round, ranked into at most HISTORY_PAGES to read. A round dated inside the news window is
 * left for the feed; a requested company opts out because its rounds are history, not news.
 */
export async function planPromotion(
  handle: Db,
  reader: HistoryReader,
  companyId: string,
  key: string,
  claimer: string,
  now: Date = new Date(),
  includeRecent = false,
): Promise<HistoryPlan> {
  const row = await ledgerRow(handle, companyId, key);
  const origin: HistoryOrigin = row?.origin ?? "dossier";
  const subject = row ? await historySubject(handle, companyId, { requireDossier: needsDossier(origin) }) : null;
  const base = { companyId, priorKey: key, origin, query: null, candidates: [], credits: 0 };
  if (!row || !subject) return { ...base, prior: row?.prior ?? emptyPrior(), skip: "gone" };
  if (row.status === "promoted" || row.status === "no_source" || row.status === "skipped")
    return { ...base, prior: row.prior, skip: "done" };
  const range = priorDateRange(row.prior.announced_date);
  if (!includeRecent && range && range.to.getTime() > now.getTime() - HISTORY_RECENT_DAYS * DAY) {
    // Left for the feed until the news window has passed; the ledger says when to look.
    await handle
      .update(historyPromotions)
      .set({ nextAttemptAt: new Date(range.to.getTime() + (HISTORY_RECENT_DAYS + 1) * DAY), updatedAt: now })
      .where(and(eq(historyPromotions.companyId, companyId), eq(historyPromotions.priorKey, key), eq(historyPromotions.status, "pending")));
    return { ...base, prior: row.prior, skip: "recent" };
  }
  if (!(await claimPrior(handle, companyId, key, claimer, now))) return { ...base, prior: row.prior, skip: "claimed" };
  const query = historyQuery(subject, row.prior);
  // The company's own site and the sites its homepage links as its blog, each mapped for the round's post.
  const sites = subject.domain ? [subject.domain, ...subject.sites.slice(0, MAPPED_SITES - 1)] : [];
  const [mapped, found] = await Promise.all([
    Promise.all(sites.map((d) => reader.map(d, newsroomSearch(subject, row.prior)))),
    reader.search(query, HISTORY_SEARCH_RESULTS),
  ]);
  const site = mapped.flat();
  const cited: HistoryCandidate[] = [...(subject.citedUrls[key] ?? []), ...(subject.citedUrls["*"] ?? [])].map((url) => ({
    url,
    via: "dossier" as const,
  }));
  const leadUrl = row.prior.source_url && /^https?:\/\//i.test(row.prior.source_url) ? row.prior.source_url : null;
  // A funding database a lead named is ranked with the rest, which reads it last.
  if (leadUrl && isFundingAggregatorUrl(leadUrl)) cited.push({ url: leadUrl, via: "lead" });
  const tiers = { ...DEFAULT_TIERS, ...(await loadPublisherTiers()) };
  const offered = await classifyCandidates(reader, subject.name, [...site, ...found]);
  const ranked = rankHistoryCandidates([...offered, ...cited], {
    company: subject,
    prior: row.prior,
    tiers,
    max: HISTORY_PAGES,
  });
  // The page a lead named (Apollo's news link, a search result's own post) is read first, wherever it
  // is hosted (tldraw's seed post was on Substack), unless it is a funding database: never trusted on its own.
  const lead = leadUrl && isArticleUrl(leadUrl) && !isFundingAggregatorUrl(leadUrl) ? leadUrl : null;
  const candidates = lead
    ? [{ url: lead, via: "lead" as const }, ...ranked.filter((c) => canonicalUrl(c.url) !== canonicalUrl(lead))].slice(0, HISTORY_PAGES)
    : ranked;
  const credits = sites.length * RATE.mapCall + searchCredits(Math.max(found.length, HISTORY_SEARCH_RESULTS));
  return { ...base, prior: row.prior, query, candidates, credits, skip: null };
}

function emptyPrior(): HistoryPrior {
  return { stage_as_written: "", amount_as_written: null, announced_date: null, lead_investors: [] };
}

/** One page tried, and what it said about the prior round. */
export interface PageTry {
  url: string;
  /** matched, or why not: unread, no rounds kept, another company, another round (stage, amount, date), too little to tell. */
  result: string;
}

export interface HistoryReading {
  record: FeedRecord | null;
  url: string | null;
  tried: PageTry[];
  credits: number;
}

/**
 * The record as the company's own: its key, name, and domain (the extraction's spelling never renames
 * the company, and a domain the extractor guessed never lands), with the id rebuilt on that key.
 */
export function asCompanyRecord(record: FeedRecord, subject: Pick<HistorySubject, "name" | "nameKey" | "domain" | "website">): FeedRecord {
  return {
    ...record,
    id: `${subject.nameKey.replace(/\s+/g, "-")}:${record.stage}:${record.announced_date ?? "undated"}`,
    company_key: subject.nameKey,
    company_name: subject.name,
    company_domain: subject.domain,
    company_website: subject.website,
    company_description: null,
  };
}

/**
 * Step two: read the pages in order, one extraction each, until one states the prior round. Each
 * page is resolved on its own through the normal rules (grounding, page kind, background rounds,
 * rumors, dating) inside the prior round's window, then matchPriorRound decides: a page whose rounds
 * are all another round, or another company's, is refused and the next page is read.
 */
export async function readCandidates(
  handle: Db,
  reader: HistoryReader,
  subject: HistorySubject,
  prior: HistoryPrior,
  candidates: HistoryCandidate[],
  now: Date = new Date(),
): Promise<HistoryReading> {
  const [aliases, tiers, rates] = await Promise.all([
    loadAliases(handle),
    loadPublisherTiers(),
    reader.rates(rateDay(prior.announced_date, now)),
  ]);
  const tried: PageTry[] = [];
  let credits = 0;
  for (const c of candidates) {
    const extraction = await reader.extract([{ url: c.url, title: c.title, published: c.published, query: `history: ${subject.name}` }]);
    credits += extractionCredits(extraction.pages.filter((p) => p.ok).map((p) => p.url));
    const page = extraction.pages[0];
    if (!page?.ok) {
      tried.push({ url: c.url, result: `unread: ${page?.error ?? "no page"}`.slice(0, 200) });
      continue;
    }
    // A prior round with no stage named is kept by its amount like any lane's (routing.ts); one with
    // neither a stage nor an amount cannot be told from a grant or a mention, and is not promoted.
    const resolved = resolveRounds(extraction.items, {
      stages: HISTORY_STAGES.filter((s) => !isStageless(s)),
      stagelessBands: STAGE_BANDS,
      ...historyWindow(prior, now),
      now,
      rates,
      aliases,
      publisherTiers: tiers,
      // The lead's own page may be the only announcement its round got (a stealth launch's seed beside
      // its Series A); any other page recalling an earlier round dates it by a day that is not its own.
      keepEarlierRounds: Boolean(prior.source_url) && canonicalUrl(c.url) === canonicalUrl(prior.source_url ?? ""),
    });
    if (resolved.kept.length === 0) {
      const d = resolved.dropped;
      const why = Object.entries(d)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k} ${n}`)
        .join(", ");
      tried.push({ url: c.url, result: d.rumor > 0 ? REPORTED_NOT_ANNOUNCED : `no rounds kept${why ? ` (${why})` : ""}` });
      continue;
    }
    const identity = {
      name: subject.name,
      nameKey: subject.nameKey,
      domain: subject.domain,
      aliasKeys: subject.aliasKeys,
      sites: subject.sites,
    };
    // An undated prior round has only the page to date it, and a company's own post carries the date
    // its site last published it (a migrated blog reads 2026 for a 2024 round); that date is not taken
    // unless the round's own sentence states it, or the post is the announcement itself ("announced
    // today"), whose day is the post's. Otherwise the next page is read instead.
    // A sibling site (tldraw.dev) counts as the company's own: the match below still holds it to the company's name.
    const ownSite = companySite(c.url, subject) !== null;
    if (!prior.announced_date && ownSite && !resolved.kept.some((r) => ownAnnouncementDay(r, extraction.items))) {
      tried.push({ url: c.url, result: "refused: undated round on the company's own site" });
      continue;
    }
    const verdicts = resolved.kept.map((r) => ({ r, m: matchPriorRound(prior, r, identity) }));
    const best = verdicts
      .filter((v): v is { r: FeedRecord; m: { ok: true; score: number; evidence: string[] } } => v.m.ok)
      .sort((a, b) => b.m.score - a.m.score)[0];
    const secondhand = best ? notAPrimarySource(c) : null;
    if (secondhand) {
      // A funding database restates rounds, often misdated, and a page that is neither an announcement
      // nor an article (docs, a forum) only mentions one: either names the round, but only a primary source verifies it.
      tried.push({ url: c.url, result: secondhand === "aggregator" ? AGGREGATOR_ONLY : NOT_AN_ANNOUNCEMENT });
      continue;
    }
    if (best) {
      tried.push({ url: c.url, result: `matched (${best.m.evidence.join(", ")})` });
      let record = asCompanyRecord(best.r, subject);
      // A company's own newsletter (tldraw.substack.com) reads as a roundup, whose day is only its week;
      // the company announcing the round there today makes the post's day the round's.
      if (ownSite && record.date_precision === "week" && record.evidence_quotes.some((q) => ANNOUNCES_NOW.test(q)))
        record = { ...record, date_precision: "day" };
      const rest = candidates.slice(candidates.indexOf(c) + 1);
      const rules = { aliases, tiers, rates };
      if (record.date_precision !== "day" && subject.domain) {
        // A round a roundup dates to its week or month: the company's own announcement names the day.
        const own = rest.filter((o) => companySite(o.url, subject) !== null);
        const day = await corroboration(
          reader,
          subject,
          prior,
          own,
          record,
          now,
          rules,
          tried,
          ownAnnouncementDay,
          "dated the round (company announcement)",
        );
        credits += day.credits;
        if (day.record) record = withAnnouncementDay(record, asCompanyRecord(day.record, subject));
      } else if (ownSite && record.date_basis !== "stated") {
        // An own-site page that does not state the day (a handbook, a docs page): a dated article
        // among the candidates that states the same round dates it and becomes a second source.
        const press = rest.filter((o) => companySite(o.url, subject) === null && !notAPrimarySource(o)).slice(0, DATED_SOURCE_READS);
        const dated = await corroboration(
          reader,
          subject,
          prior,
          press,
          record,
          now,
          rules,
          tried,
          datedArticle,
          "dated the round (press)",
        );
        credits += dated.credits;
        if (dated.record) record = withAnnouncementDay(record, asCompanyRecord(dated.record, subject));
      }
      return { record, url: c.url, tried, credits };
    }
    const reasons = [...new Set(verdicts.map((v) => (v.m.ok ? "" : v.m.reason)).filter(Boolean))];
    tried.push({ url: c.url, result: `refused: ${reasons.join(", ")}` });
  }
  return { record: null, url: null, tried, credits };
}

/** What the ledger says of a funding database that states the round: never a verification on its own. */
const AGGREGATOR_ONLY = "refused: a funding database states it, not a primary source";
/** What the ledger says of a page the classifier reads as neither an announcement nor an article. */
const NOT_AN_ANNOUNCEMENT = "refused: neither an announcement nor an article";
const REPORTED_NOT_ANNOUNCED = "reported, not announced";

/** The company's post is the announcement itself, so its day is the round's: stated in the sentence, or the post says it is today's news. */
const ANNOUNCES_NOW =
  /\b(?:announc\w*\s+today|today,?\s+(?:we(?:'|’)re|we are|we|i(?:'|’)m|i am)\s+(?:\w+\s+){0,3}(?:announc\w*|shar\w*|rais\w*)|(?:excited|thrilled|pleased|proud|delighted|happy)\s+to\s+(?:announce|share))\b/i;
function ownAnnouncementDay(r: FeedRecord, items: ExtractResult["items"] = []): boolean {
  if (r.date_precision !== "day" || !r.announced_date) return false;
  if (r.date_basis === "stated" || r.evidence_quotes.some((q) => ANNOUNCES_NOW.test(q))) return true;
  return (
    r.date_basis === "page" &&
    items.some(
      (item) =>
        item.visible_article_date &&
        item.page_date === r.announced_date &&
        item.source.url === r.sources[0]?.url &&
        /\b(?:rais(?:ed|es)|secur(?:ed|es)|clos(?:ed|es)|complet(?:ed|es)|announc(?:ed|es))\b/i.test(item.round.evidence_quote),
    )
  );
}

/**
 * A page that dates a round the matched page could not: read `candidates` in order until one
 * states the same round with a day `dates` accepts. For a roundup's week or month the day never
 * falls after its period, which is the latest the round can have been announced; an own-site page's
 * day is no such bound, so a dated article is taken as it reads.
 */
async function corroboration(
  reader: HistoryReader,
  subject: HistorySubject,
  prior: HistoryPrior,
  candidates: HistoryCandidate[],
  found: FeedRecord,
  now: Date,
  rules: { aliases: Record<string, string>; tiers: Record<string, number>; rates: RateTable | null },
  tried: PageTry[],
  dates: (r: FeedRecord, items: ExtractResult["items"]) => boolean,
  label: string,
): Promise<{ record: FeedRecord | null; credits: number }> {
  const latest = found.announced_date && found.date_precision !== "day" ? periodEnd(found.announced_date, found.date_precision) : null;
  const identity = {
    name: subject.name,
    nameKey: subject.nameKey,
    domain: subject.domain,
    aliasKeys: subject.aliasKeys,
    sites: subject.sites,
  };
  let credits = 0;
  for (const c of candidates) {
    const extraction = await reader.extract([{ url: c.url, title: c.title, published: c.published, query: `history: ${subject.name}` }]);
    credits += extractionCredits(extraction.pages.filter((p) => p.ok).map((p) => p.url));
    if (!extraction.pages[0]?.ok) continue;
    const resolved = resolveRounds(extraction.items, {
      stages: HISTORY_STAGES.filter((s) => !isStageless(s)),
      stagelessBands: STAGE_BANDS,
      ...historyWindow(prior, now),
      now,
      rates: rules.rates,
      aliases: rules.aliases,
      publisherTiers: rules.tiers,
    });
    const day = resolved.kept.find(
      (r) =>
        dates(r, extraction.items) &&
        matchPriorRound(prior, r, identity).ok &&
        matchPriorRound(
          {
            stage_as_written: found.stage_as_written,
            amount_as_written: found.amount.as_written,
            announced_date: found.announced_date,
            lead_investors: found.lead_investors,
          },
          r,
          identity,
        ).ok &&
        (!latest || Date.parse(r.announced_date ?? "") <= latest.getTime()),
    );
    tried.push({ url: c.url, result: day ? label : "no day for the round" });
    if (day) return { record: day, credits };
  }
  return { record: null, credits };
}

/** Third-party pages read at most to date a round an own-site page stated without its day. */
const DATED_SOURCE_READS = 2;

/** A third-party article that dates the round to its day: stated in the sentence, or the article's own day. */
function datedArticle(r: FeedRecord): boolean {
  return r.date_precision === "day" && Boolean(r.announced_date) && (r.date_basis === "stated" || r.date_basis === "page");
}

/** The last day of the period a date stands for at its precision. */
function periodEnd(iso: string, precision: FeedRecord["date_precision"]): Date {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (precision === "week") return new Date(d.getTime() + 6 * DAY);
  if (precision === "month") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return d;
}

/** The roundup's reading with the announcement's day and the announcement as a second source. */
function withAnnouncementDay(found: FeedRecord, day: FeedRecord): FeedRecord {
  return {
    ...found,
    id: `${found.company_key.replace(/\s+/g, "-")}:${found.stage}:${day.announced_date}`,
    announced_date: day.announced_date,
    date_precision: "day",
    date_basis: day.date_basis,
    undated: false,
    sources: [...found.sources, ...day.sources.filter((s) => !found.sources.some((f) => f.url === s.url))],
    evidence_quotes: [...new Set([...found.evidence_quotes, ...day.evidence_quotes])],
  };
}

/** Record what became of one prior round on its ledger row, adding this attempt's credits. */
async function writeLedger(
  handle: Db,
  companyId: string,
  key: string,
  set: Partial<typeof historyPromotions.$inferInsert> & { credits?: number },
): Promise<void> {
  const { credits = 0, ...rest } = set;
  // Every outcome ends this pass's claim.
  await handle
    .update(historyPromotions)
    .set({ claimedBy: null, ...rest, credits: sql`${historyPromotions.credits} + ${credits}`, updatedAt: new Date() })
    .where(and(eq(historyPromotions.companyId, companyId), eq(historyPromotions.priorKey, key)));
}

/** A USD figure at the rate of the round's own day, as every other row is converted: a 2021 euro round is not priced at today's rate. */
async function priceAtDay(reader: HistoryReader, record: FeedRecord): Promise<FeedRecord> {
  const { value, currency } = record.amount;
  if (value === null || !currency || currency === "USD" || !record.announced_date) return record;
  const rates = await reader.rates(record.announced_date);
  const usd = convertToUsd(value, currency, rates, record.amount.as_written);
  return usd.usd_millions === null ? record : { ...record, amount: { ...record.amount, ...usd } };
}

/**
 * Step three: the read-back and persist. The matched record is read back against its sources (a
 * read that could not run throws, so the step retries rather than landing an unchecked row), checked
 * against the prior round once more with the corrected fields, held back when it turns out to be
 * inside the news window unless a request is recovering it, priced at its own day's rate, and persisted as history. The ledger row
 * records the outcome either way.
 */
export async function finishPromotion(
  handle: Db,
  reader: HistoryReader,
  plan: HistoryPlan,
  reading: HistoryReading,
  runId: string,
  now: Date = new Date(),
  includeRecent = false,
): Promise<PromotionOutcome> {
  const { companyId, priorKey: key, prior } = plan;
  const base: PromotionOutcome = {
    companyId,
    priorKey: key,
    status: "no_source",
    searched: true,
    sourced: false,
    ingested: false,
    disposition: null,
    merged: false,
    roundId: null,
    credits: plan.credits + reading.credits,
  };
  const verdicts = Object.fromEntries(
    plan.candidates.filter((c) => c.verdict).map((c) => [c.url, verdictSummary(c.verdict as PageVerdict)]),
  );
  const trail = {
    query: plan.query,
    candidates: plan.candidates.map((c) => c.url),
    tried: reading.tried,
    ...(Object.keys(verdicts).length > 0 ? { verdicts } : {}),
  };
  const subject = await historySubject(handle, companyId, { requireDossier: needsDossier(plan.origin) });
  if (!subject) return { ...base, status: "skipped", reason: "company or dossier gone" };
  if (!reading.record) {
    const reason =
      plan.candidates.length === 0
        ? "no candidate page"
        : reading.tried.some((t) => t.result === REPORTED_NOT_ANNOUNCED)
          ? REPORTED_NOT_ANNOUNCED
          : reading.tried.some((t) => t.result === AGGREGATOR_ONLY)
            ? "only funding databases state it"
            : reading.tried.some((t) => t.result === NOT_AN_ANNOUNCEMENT)
              ? "no announcement or article states it"
              : "no page states it";
    await writeLedger(handle, companyId, key, {
      status: "no_source",
      outcome: { ...trail, reason },
      credits: base.credits,
      lastError: null,
    });
    return { ...base, reason };
  }
  const tiers = { ...DEFAULT_TIERS, ...(await loadPublisherTiers()) };
  const rates = await reader.rates(reading.record.announced_date ?? rateDay(prior.announced_date, now));
  const verified = await reader.verify([reading.record], rates, tiers);
  const credits = base.credits + verified.credits;
  const checked = verified.records[0];
  const status = checked?.verification?.status;
  if (!checked || !status || status === "skipped" || status === "unverified") {
    // Nothing skips the read-back: a read that did not run is a failure to retry, never a row.
    throw new Error(`read-back did not run: ${checked?.verification?.notes?.join("; ") || "no verdict"}`);
  }
  if (status === "not_news") {
    const reason = "the read-back says the page recalls the round rather than announcing it";
    await writeLedger(handle, companyId, key, {
      status: "no_source",
      outcome: { ...trail, reason, verdict: status },
      credits,
      lastError: null,
    });
    return { ...base, sourced: true, credits, reason };
  }
  const identity = { name: subject.name, nameKey: subject.nameKey, domain: subject.domain, aliasKeys: subject.aliasKeys };
  const again = matchPriorRound(prior, asCompanyRecord(checked, subject), identity);
  if (!again.ok) {
    const reason = `the read-back no longer matches the dossier (${again.reason})`;
    await writeLedger(handle, companyId, key, {
      status: "no_source",
      outcome: { ...trail, reason, verdict: status },
      credits,
      lastError: null,
    });
    return { ...base, sourced: true, credits, reason };
  }
  const record = await priceAtDay(reader, asCompanyRecord(checked, subject));
  if (!includeRecent && record.announced_date && Date.parse(record.announced_date) > now.getTime() - HISTORY_RECENT_DAYS * DAY) {
    const next = new Date(Date.parse(record.announced_date) + (HISTORY_RECENT_DAYS + 1) * DAY);
    await writeLedger(handle, companyId, key, {
      status: "pending",
      nextAttemptAt: next,
      outcome: { ...trail, reason: "announced inside the news window; left for the feed until it passes" },
      credits,
    });
    return { ...base, status: "deferred", sourced: true, credits, reason: "recent" };
  }

  const summary = await persistRecords(handle, [record], subject.presetSlug, runId, { history: true, companyId: subject.id });
  const roundId = summary.persistedIds[0] ?? record.id;
  const [row] = await handle
    .select({ disposition: fundingRounds.disposition, history: fundingRounds.history })
    .from(fundingRounds)
    .where(eq(fundingRounds.id, roundId))
    .limit(1);
  const merged = summary.inserted === 0 || !row?.history;
  const disposition = row?.disposition ?? null;
  await writeLedger(handle, companyId, key, {
    status: "promoted",
    roundId,
    sourceUrl: reading.url,
    outcome: { ...trail, verdict: status, disposition, merged, confidence: record.confidence },
    credits,
    lastError: null,
  });
  return { ...base, status: "promoted", sourced: true, ingested: true, disposition, merged, roundId, credits };
}

/**
 * A promotion that failed past its step's retries: the ledger counts the try and sets the next one
 * on the backoff (1 hour, 6 hours, a day), and after HISTORY_MAX_ATTEMPTS it stays failed.
 */
export async function failPromotion(
  handle: Db,
  companyId: string,
  key: string,
  error: string,
  credits = 0,
  now: Date = new Date(),
): Promise<void> {
  const row = await ledgerRow(handle, companyId, key);
  if (!row) return;
  const attempts = row.attempts + 1;
  const hours = HISTORY_BACKOFF_HOURS[Math.min(attempts - 1, HISTORY_BACKOFF_HOURS.length - 1)];
  await writeLedger(handle, companyId, key, {
    status: "failed",
    attempts,
    nextAttemptAt: new Date(now.getTime() + hours * 3_600_000),
    lastError: error.slice(0, 500),
    credits,
  });
}

/** Step two with the company read fresh, as the durable step calls it: a plan carries no company row. */
export async function readPlan(handle: Db, reader: HistoryReader, plan: HistoryPlan, now: Date = new Date()): Promise<HistoryReading> {
  const subject = await historySubject(handle, plan.companyId, { requireDossier: needsDossier(plan.origin) });
  if (!subject) return { record: null, url: null, tried: [], credits: 0 };
  return readCandidates(handle, reader, subject, plan.prior, plan.candidates, now);
}

/** The three moves in one call, for a script or a test; the durable path makes each its own step. */
export async function promotePrior(
  handle: Db,
  reader: HistoryReader,
  companyId: string,
  key: string,
  runId: string,
  now: Date = new Date(),
): Promise<PromotionOutcome> {
  let spent = 0;
  try {
    const plan = await planPromotion(handle, reader, companyId, key, runId, now);
    if (plan.skip) return skippedOutcome(companyId, key, plan.skip);
    spent = plan.credits;
    const reading = await readPlan(handle, reader, plan, now);
    spent += reading.credits;
    return await finishPromotion(handle, reader, plan, reading, runId, now);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await failPromotion(handle, companyId, key, error, spent, now);
    return failedOutcome(companyId, key, error, spent);
  }
}

/** One company's promotions as a row on Runs (lane history), with the credits they cost at the rate card. */
export async function recordCompanyHistoryRun(
  handle: Db,
  companyId: string,
  startedAt: Date,
  tally: HistoryTally,
  error: string | null = null,
): Promise<void> {
  await recordRun(handle, {
    id: `history:${companyId}:${startedAt.getTime()}`,
    presetSlug: "history",
    lane: "history",
    window: null,
    startedAt,
    finishedAt: new Date(),
    creditsEstimated: null,
    creditsMeasured: tally.credits,
    counts: { ...tally },
    error,
  });
}

/** The newest history rows, for the route's progress read. */
export async function latestHistoryRows(handle: Db, limit = 10) {
  return handle
    .select({
      id: fundingRounds.id,
      companyId: fundingRounds.companyId,
      stage: fundingRounds.stage,
      announcedOn: fundingRounds.announcedOn,
      disposition: fundingRounds.disposition,
    })
    .from(fundingRounds)
    .where(eq(fundingRounds.history, true))
    .orderBy(desc(fundingRounds.firstSeenAt))
    .limit(limit);
}

/** The backfill's knobs, as the route reads them. */
export interface HistoryBackfillParams {
  /** Dossiers (companies) to work at most; null for every one with work left. */
  limit: number | null;
  /** Companies worked at once. */
  concurrency: number;
  /** No new company starts once the credits spent reach this. */
  maxTotalCredits: number;
}

/** Three companies at once; a ceiling well above a full pass (about 30 credits a prior round, some 150 prior rounds on the store today). */
export const HISTORY_BACKFILL_DEFAULTS = { concurrency: 20, maxTotalCredits: 25_000 } as const;

/** The route's params from a query string or a JSON body; an error names the bad one. Pure. */
export function parseHistoryBackfillParams(input: Record<string, unknown>): HistoryBackfillParams | { error: string } {
  const int = (key: string, fallback: number | null, min: number, max: number): number | null | { error: string } => {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) return { error: `${key} must be a whole number from ${min} to ${max}` };
    return n;
  };
  const limit = int("limit", null, 1, 10_000);
  const concurrency = int("concurrency", HISTORY_BACKFILL_DEFAULTS.concurrency, 1, 100);
  const maxTotalCredits = int("maxTotalCredits", HISTORY_BACKFILL_DEFAULTS.maxTotalCredits, 0, 10_000_000);
  for (const v of [limit, concurrency, maxTotalCredits]) if (v !== null && typeof v === "object") return v;
  return { limit: limit as number | null, concurrency: concurrency as number, maxTotalCredits: maxTotalCredits as number };
}

/**
 * The ledger keys of a company's prior rounds the history lane ruled out: too vague to search
 * (skipped), or searched with no page found and carrying no amount. The company page leaves them
 * out of what it lists from the dossier. A prior with an amount stays even when no announcement was
 * found: the dossier's check read it on a page (Heidi's $5M 2021 seed), and a missing press release
 * is not a wrong round. One with neither amount nor page says little and may be mislabelled, as
 * OpenAI's dossier called Microsoft's 2023 investment a "Series C".
 */
export async function ruledOutPriors(handle: Db, companyId: string): Promise<Set<string>> {
  const rows = await handle
    .select({ key: historyPromotions.priorKey })
    .from(historyPromotions)
    .where(
      and(
        eq(historyPromotions.companyId, companyId),
        sql`(${historyPromotions.status} = 'skipped' or (${historyPromotions.status} = 'no_source' and coalesce(${historyPromotions.prior} ->> 'amount_as_written', '') = ''))`,
      ),
    );
  return new Set(rows.map((r) => r.key));
}

/**
 * When a company's next failed prior round is due again (ISO), or null when none has tries left. A
 * dossier's own pass sleeps until then; the backfill leaves it for its next run.
 */
export async function nextHistoryRetry(handle: Db, companyId: string): Promise<string | null> {
  const [row] = await handle
    .select({ at: sql<Date | string | null>`min(${historyPromotions.nextAttemptAt})` })
    .from(historyPromotions)
    .where(
      and(
        eq(historyPromotions.companyId, companyId),
        eq(historyPromotions.status, "failed"),
        sql`${historyPromotions.attempts} < ${HISTORY_MAX_ATTEMPTS}`,
      ),
    );
  if (!row?.at) return null;
  return new Date(row.at).toISOString();
}
