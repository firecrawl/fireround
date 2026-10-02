// Records in, rows out, and back. The only place that knows both shapes.

import type { AlexandriaEnrichment, ApolloEnrichment, FeedRecord, RoundCertainty, Stage, StoredRound } from "@fireround/core";
import {
  assertedRoundCertainty,
  canonicalUrl,
  DATE_PRECISION_RANK,
  DEFAULT_TIERS,
  dedupeInvestorNames,
  financingTotalMatches,
  implausibleReading,
  invariantBreach,
  investorKeyForMerge,
  isStageless,
  knownRound,
  normalizeCompanyKey,
  normalizeInvestorName,
  parseAmount,
  pickValuation,
  priorAsKnown,
  priorKey,
  promotable,
  reconcileInvestorLists,
  registrableDomain,
  secondhandOnly,
  unsupportedValuation,
  type ValuationClaim,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, desc, eq, gte, inArray, isNull, lt, lte, or, type SQL, sql } from "drizzle-orm";
import { knownRounds } from "./apollo.ts";
import { holdLateReports } from "./late-report.ts";
import { publicLane, publicVerifier } from "./public-view.ts";
import { parseRoundCursor, type RoundSort, roundCursorAfter } from "./round-sort.ts";
import { visibilityEvidence } from "./round-verification.ts";
import { loadPublisherTiers } from "./rules.ts";

const { companies, fundingRounds, investors, pageVerdicts, roundInvestors, sources, roundSources, enrichments, roundMerges } = schema;

/** The precision column as its rank, for comparisons in SQL. */
function rankSql(column: typeof fundingRounds.datePrecision) {
  return sql`CASE ${column} WHEN 'day' THEN 3 WHEN 'week' THEN 2 WHEN 'month' THEN 1 ELSE 0 END`;
}

function companyIdFor(r: FeedRecord): string {
  return r.company_domain ?? r.company_key;
}

function fingerprint(r: { amountAsWritten: string | null; announcedOn: string | null; leads: string[] }): string {
  return JSON.stringify([r.amountAsWritten, r.announcedOn, [...r.leads].sort()]);
}

/**
 * A company's sector as a write leaves it: the stored one, unless it is unknown or "other" and the
 * incoming reading names one. A first reading that fell back to "other" used to hold the company
 * there for good, whatever later readings said (nine visible companies on 2026-09-25 had a round
 * that named their sector and a company still filed under other).
 */
export function keptSector(incoming: SQL | string | null): SQL {
  return sql`CASE WHEN ${companies.sector} IS NULL OR (${companies.sector} = 'other' AND ${incoming}::text IS NOT NULL) THEN COALESCE(${incoming}::text, ${companies.sector}) ELSE ${companies.sector} END`;
}

/**
 * Where a record starts. Review below 0.5 or with no date; flagged below 0.75 or with no amount
 * (an undisclosed round is real news, but publish means complete); publish otherwise.
 */
const IDENTITY_HOLD = "held for review: same-name company identity is unverified";

export function dispositionFor(
  r: Pick<FeedRecord, "undated" | "confidence" | "valuation_ruled_out"> & {
    amount?: Pick<FeedRecord["amount"], "as_written">;
    verification?: FeedRecord["verification"];
  },
  opts: { secondhand?: boolean } = {},
): "publish" | "flagged" | "review" {
  if (r.undated || r.confidence < 0.5) return "review";
  // A database, a profile farm, or a forum can point at a round but never makes it visible alone (secondhandOnly).
  if (opts.secondhand) return "review";
  // The judge's word: a page that is not this company's, or that recalls the round as history, is review.
  const verdict = r.verification?.status;
  if (verdict === "contradicted" || verdict === "not_news") return "review";
  if (r.confidence < 0.75) return "flagged";
  if (r.amount && r.amount.as_written === null) return "flagged";
  // A valuation taken off as another round's leaves the row for a reader to check.
  if (r.valuation_ruled_out) return "flagged";
  // Publish means the page confirmed the record: unjudged and skipped records stay flagged for a reader to check.
  if (verdict !== "confirmed" && verdict !== "corrected") return "flagged";
  return "publish";
}

export interface PersistSummary {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Ids inserted or updated this call: what delivery should fan out. */
  changedIds: string[];
  /** Ids new this call: what the plan's corroboration, gap-fill, and deep dive read first. */
  insertedIds: string[];
  /** Every id this call touched, changed or not: what corroboration "all" reads. */
  persistedIds: string[];
}

/** Upsert a batch of resolved records. New rows are `new`; changed rows become `updated`; untouched rows keep their status. */
export interface PersistOptions {
  /**
   * Where a new row starts regardless of its score. The Form D lane uses "review": a filing proves a
   * sale happened, not that it was a venture round, so a human or a corroborating article decides.
   * The X lane uses "flagged" for a round known only from the company's own post: visible, marked, and
   * never published as verified until an article confirms it.
   */
  startIn?: "review" | "flagged";
  /**
   * Earlier rounds promoted from a checked dossier (lib/history.ts): a new row is written as history
   * and already seen, and a reading that lands on a row already there never marks it updated. The
   * update path never touches the flag, so a history reading merging into a feed row leaves it a feed row.
   */
  history?: boolean;
  /** The company row every record in the batch belongs to, when the caller knows it (the history lane does). */
  companyId?: string;
}

/**
 * Fold one company row into another: rounds, enrichments, and aliases move over, the survivor
 * fills any blank field from the row that goes, and rounds that were the same round under two
 * ids are merged. This is how a company first seen by name ("Zenergize", from a roundup) and the
 * same company seen by domain ("zenergize.in", from its press release) become one row.
 */
export async function mergeCompanies(handle: Db, fromId: string, intoId: string): Promise<void> {
  if (!(await foldCompany(handle, fromId, intoId))) return;
  await mergeDuplicateRounds(handle, { companyId: intoId });
}

/**
 * The row move under mergeCompanies, without the round pass after it (the round merge calls it
 * mid-merge). The row that goes leaves its name key behind as an alias of the survivor, so a
 * later record under that name still finds the company; its domain moves over when the survivor
 * has none. False when there was nothing to fold.
 */
async function foldCompany(handle: Db, fromId: string, intoId: string): Promise<boolean> {
  if (fromId === intoId) return false;
  const [from] = await handle.select().from(companies).where(eq(companies.id, fromId));
  if (!from) return false;
  await handle.update(fundingRounds).set({ companyId: intoId }).where(eq(fundingRounds.companyId, fromId));
  await handle.execute(
    sql`insert into enrichments (company_id, kind, data, schema_version, source_url, fetched_at) select ${intoId}, kind, data, schema_version, source_url, fetched_at from enrichments where company_id = ${fromId} on conflict do nothing`,
  );
  await handle.delete(enrichments).where(eq(enrichments.companyId, fromId));
  await handle.execute(
    sql`insert into company_aliases (company_id, kind, alias_key, alias, source_url, created_at) select ${intoId}, kind, alias_key, alias, source_url, created_at from company_aliases where company_id = ${fromId} on conflict do nothing`,
  );
  await handle.delete(schema.companyAliases).where(eq(schema.companyAliases.companyId, fromId));
  // The dossier moved above; its prior rounds' promotion ledger follows it, so nothing is searched twice.
  await handle.execute(
    sql`insert into history_promotions (company_id, prior_key, prior, status, attempts, next_attempt_at, claimed_by, round_id, source_url, outcome, credits, last_error, created_at, updated_at) select ${intoId}, prior_key, prior, status, attempts, next_attempt_at, claimed_by, round_id, source_url, outcome, credits, last_error, created_at, updated_at from history_promotions where company_id = ${fromId} on conflict do nothing`,
  );
  await handle.delete(schema.historyPromotions).where(eq(schema.historyPromotions.companyId, fromId));
  // Its newsrooms, their scan marker and any visitor request follow it too, or the delete below is refused.
  await handle.execute(
    sql`insert into company_newsrooms (company_id, url, monitor_id, discovered_at, checked_at) select ${intoId}, url, monitor_id, discovered_at, checked_at from company_newsrooms where company_id = ${fromId} on conflict do nothing`,
  );
  await handle.delete(schema.companyNewsrooms).where(eq(schema.companyNewsrooms.companyId, fromId));
  await handle.execute(
    sql`insert into company_newsroom_scans (company_id, discovered_at) select ${intoId}, discovered_at from company_newsroom_scans where company_id = ${fromId} on conflict do nothing`,
  );
  await handle.delete(schema.companyNewsroomScans).where(eq(schema.companyNewsroomScans.companyId, fromId));
  await handle.update(schema.companyRequests).set({ companyId: intoId }).where(eq(schema.companyRequests.companyId, fromId));
  // The domain is unique, so the row that goes is deleted before the survivor takes its domain.
  await handle.delete(companies).where(eq(companies.id, fromId));
  await handle
    .update(companies)
    .set({
      name: sql`CASE WHEN length(${from.name}) > length(${companies.name}) THEN ${from.name} ELSE ${companies.name} END`,
      domain: sql`coalesce(${companies.domain}, ${from.domain})`,
      website: sql`coalesce(${companies.website}, ${from.website})`,
      linkedinSlug: sql`coalesce(${companies.linkedinSlug}, ${from.linkedinSlug})`,
      description: sql`coalesce(${companies.description}, ${from.description})`,
      hq: sql`coalesce(${companies.hq}, ${from.hq})`,
      sector: keptSector(from.sector),
      logoUrl: sql`coalesce(${companies.logoUrl}, ${from.logoUrl})`,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, intoId));
  await rememberNameKey(handle, intoId, from.nameKey, from.name, null);
  return true;
}

/**
 * Record a name key a company row was seen under when it differs from the row's own, as a name
 * alias. A row keeps the key it was created with, so without this a company first stored as
 * "heidi health" is a stranger to the next record that says "Heidi" and carries no domain.
 */
async function rememberNameKey(handle: Db, companyId: string, key: string, name: string, sourceUrl: string | null): Promise<void> {
  if (!key) return;
  await handle.execute(
    sql`insert into company_aliases (company_id, kind, alias_key, alias, source_url) select ${companyId}, 'name', ${key}, ${name}, ${sourceUrl} where not exists (select 1 from companies where id = ${companyId} and name_key = ${key}) on conflict do nothing`,
  );
}

/**
 * The company row a record with this domain belongs to. When another row already owns the
 * domain, the candidate is folded into it and the owner's id comes back; otherwise the candidate.
 */
export async function claimDomain(handle: Db, candidateId: string, domain: string | null): Promise<string> {
  if (!domain) return candidateId;
  const [owner] = await handle.select({ id: companies.id }).from(companies).where(eq(companies.domain, domain)).limit(1);
  if (!owner || owner.id === candidateId) return candidateId;
  await mergeCompanies(handle, candidateId, owner.id);
  return owner.id;
}

/** Same stage: 45 days apart is one round reported on different days. */
export const SAME_STAGE_WINDOW_DAYS = 45;
/** Different stage: a company does not announce two rounds in one week; the label is what differs between publications. */
export const CROSS_STAGE_WINDOW_DAYS = 7;
/**
 * One named stage and one amount inside a year is one round: a company does not close two equal
 * Series Bs in twelve months, and a late article re-reporting the round (Higharc's Series C from a
 * monthly list two months on, Fearn's June seed in a September launch story) is the usual reason a
 * second row appears.
 */
export const REREPORT_WINDOW_DAYS = 365;
/**
 * With more than the stage and the amount in common (a shared page, a shared lead, or one side dated
 * only by a list's week or month), a re-report is one round across three years: Millie's February 2025
 * Series A came back from dealbreaker.com in a September 2026 roundup, with the same leads and page.
 */
export const REREPORT_CORROBORATED_WINDOW_DAYS = 3 * 365;

/** What isSameRound compares; the optional facts widen or narrow its windows when both sides carry them. */
export interface SameRoundFacts {
  stage: string;
  announcedOn: string | null;
  amountUsdMillions?: number | null;
  amountValue?: number | null;
  amountCurrency?: string | null;
  financingTotalAsWritten?: string | null;
  /** week or month: the day is a list's, so the round fell in the span before it. */
  datePrecision?: string;
  stageAsWritten?: string;
  isExtension?: boolean;
  /** Canonical source URLs. */
  sourceIds?: string[];
  /** Investor keys of the leads. */
  leadKeys?: string[];
}

/** Days a precision leaves open before the stated day: a weekly list's day covers the week before it. */
function precisionSpan(precision: string | undefined): number {
  return precision === "week" ? 7 : precision === "month" ? 31 : 0;
}

/**
 * Days between two dated readings, each taken as the span its precision allows (a monthly list's
 * August 31 is any day of August), so Higharc's July 2 release and its August list are 29 days
 * apart, not 60.
 */
function readingGap(a: SameRoundFacts, b: SameRoundFacts): number {
  const day = 86_400_000;
  const aEnd = new Date(a.announcedOn as string).getTime();
  const bEnd = new Date(b.announcedOn as string).getTime();
  const aStart = aEnd - precisionSpan(a.datePrecision) * day;
  const bStart = bEnd - precisionSpan(b.datePrecision) * day;
  if (aEnd < bStart) return (bStart - aEnd) / day;
  if (bEnd < aStart) return (aStart - bEnd) / day;
  return 0;
}

/** Both amounts known and one more than twice the other: two figures, not two reports of one. */
/** Whether a reading is a tranche of its series or an extension: "Series B1", "B-2", "Series B extension". */
function tranche(r: SameRoundFacts): boolean {
  return Boolean(r.isExtension) || /\bseries\s+[a-k][-\s]?\d\b/i.test(r.stageAsWritten ?? "");
}

/** Two figures more than a quarter apart: two rounds' amounts, not one round's reported twice. */
function amountsDiffer(a: SameRoundFacts, b: SameRoundFacts): boolean {
  const x = a.amountUsdMillions ?? null;
  const y = b.amountUsdMillions ?? null;
  return x !== null && y !== null && x > 0 && y > 0 && Math.abs(x - y) > 0.25 * Math.max(x, y);
}

function amountsFarApart(a: SameRoundFacts, b: SameRoundFacts): boolean {
  const x = a.amountUsdMillions ?? null;
  const y = b.amountUsdMillions ?? null;
  return x !== null && y !== null && x > 0 && y > 0 && Math.max(x, y) > 2 * Math.min(x, y);
}

/** The series letter a written label names ("Series E" is e), or null when it names none. */
function seriesLetter(written: string | undefined): string | null {
  return /\bseries\s+([a-z])(?![a-z])/i.exec(written ?? "")?.[1]?.toLowerCase() ?? null;
}

/**
 * Whether two same-stage readings far apart are one round re-reported. The stage must be a named
 * one (other and undisclosed name nothing), both amounts must be known and agree within a tenth,
 * an extension is its own raise, and two different letters inside Series D+ ("Series D" and
 * "Series E") are two rounds. Inside a year that is enough; up to three years the two must share a
 * page or a lead, or one must be dated only by a list.
 */
function isReReport(a: SameRoundFacts, b: SameRoundFacts, days: number): boolean {
  if (!EQUITY_LADDER.has(a.stage) || isStageless(a.stage as Stage)) return false;
  if (Boolean(a.isExtension) !== Boolean(b.isExtension)) return false;
  const la = seriesLetter(a.stageAsWritten);
  const lb = seriesLetter(b.stageAsWritten);
  if (la && lb && la !== lb) return false;
  const x = a.amountUsdMillions ?? null;
  const y = b.amountUsdMillions ?? null;
  if (x === null || y === null) return false;
  const larger = Math.max(x, y);
  if (!(larger > 0 && Math.abs(x - y) <= larger * 0.1)) return false;
  if (days <= REREPORT_WINDOW_DAYS) return true;
  if (days > REREPORT_CORROBORATED_WINDOW_DAYS) return false;
  const sharedPage = (a.sourceIds ?? []).some((s) => (b.sourceIds ?? []).includes(s));
  const sharedLead = (a.leadKeys ?? []).some((k) => (b.leadKeys ?? []).includes(k));
  const listDated = precisionSpan(a.datePrecision) > 0 || precisionSpan(b.datePrecision) > 0;
  return sharedPage || sharedLead || listDated;
}

/**
 * Whether an unlabelled reading far from a named round is that round re-reported: a late page drops
 * the label (Fearn's June seed came back from a September digest as "raised $5.5 million", Assort
 * Health's Series C from a profile as "$120M funding"). One side stageless, the other a named equity
 * stage, the same extension flag, both amounts known and within a tenth, inside three years, and a
 * shared page or a shared lead: without the label, the figure alone is not enough.
 */
function isStagelessReReport(a: SameRoundFacts, b: SameRoundFacts, days: number): boolean {
  if (isStageless(a.stage as Stage) === isStageless(b.stage as Stage)) return false;
  if (Boolean(a.isExtension) !== Boolean(b.isExtension)) return false;
  const x = a.amountUsdMillions ?? null;
  const y = b.amountUsdMillions ?? null;
  if (x === null || y === null) return false;
  const larger = Math.max(x, y);
  if (!(larger > 0 && Math.abs(x - y) <= larger * 0.1)) return false;
  if (days > REREPORT_CORROBORATED_WINDOW_DAYS) return false;
  const sharedPage = (a.sourceIds ?? []).some((s) => (b.sourceIds ?? []).includes(s));
  const sharedLead = (a.leadKeys ?? []).some((k) => (b.leadKeys ?? []).includes(k));
  return sharedPage || sharedLead;
}

/**
 * Whether two records for the same company describe one round. Undated on either side is a
 * match when the stage agrees (the date is what a second source usually supplies), and never a
 * match across stages (there is nothing to anchor the week on). Dated readings are compared as the
 * spans their precision allows. The same stage inside 45 days is one round, and so is a re-report
 * further out (isReReport). Two dated records whose stage labels disagree still match when both
 * are equity and their amounts agree within 10 percent of the larger inside the stage window: a
 * company does not close two equal rounds a month apart, so the surer reading names the stage.
 */
export function isSameRound(a: SameRoundFacts, b: SameRoundFacts): boolean {
  if (!a.announcedOn || !b.announcedOn) return a.stage === b.stage;
  const days = daysApart(a.announcedOn, b.announcedOn);
  if (days <= (a.stage === b.stage ? SAME_STAGE_WINDOW_DAYS : CROSS_STAGE_WINDOW_DAYS) && financingTotalMatches(a, b)) return true;
  if (a.stage === b.stage) {
    // A tranche or an extension beside its series is its own round when the figures differ: Corgi's
    // $106 million Series B1 three weeks after its $160 million Series B.
    if (tranche(a) !== tranche(b) && amountsDiffer(a, b)) return false;
    if (days <= SAME_STAGE_WINDOW_DAYS) return true;
    // A list's span brings a reading inside the window only when the figures could be one round's:
    // Quaise's $46M final close, from a list's week, is not its $134M first close six weeks before.
    const span = readingGap(a, b);
    if (span <= SAME_STAGE_WINDOW_DAYS && !amountsFarApart(a, b)) return true;
    return isReReport(a, b, span);
  }
  if (!EQUITY_LADDER.has(a.stage) || !EQUITY_LADDER.has(b.stage)) return false;
  if (days <= CROSS_STAGE_WINDOW_DAYS) return true;
  if (isStagelessReReport(a, b, readingGap(a, b))) return true;
  const larger = Math.max(a.amountUsdMillions ?? 0, b.amountUsdMillions ?? 0);
  return larger > 0 && Math.abs((a.amountUsdMillions ?? 0) - (b.amountUsdMillions ?? 0)) <= larger * 0.1 && days <= SAME_STAGE_WINDOW_DAYS;
}

/**
 * Stages the week rule may bridge: labels for one equity round. Debt, grants, secondaries, and
 * convertibles are announced beside an equity round often enough ("$50M Series B and a $20M
 * credit facility") that they always need their own stage to match.
 */
const EQUITY_LADDER = new Set([
  "pre_seed",
  "seed",
  "series_a",
  "series_b",
  "series_c",
  "series_d_plus",
  "growth",
  "bridge",
  "pre_a",
  "undisclosed",
  "other",
]);

/** A company row as round dedupe sees it: its name key, its domain, and the other name keys it has been seen under. */
export interface CompanyIdentity {
  companyId: string;
  nameKey: string;
  domain: string | null;
  aliasKeys: string[];
}

/** What round dedupe compares between two rows, or a row and an arriving record: the company and the round's own facts. */
export interface RoundIdentity extends CompanyIdentity {
  stage: string;
  announcedOn: string | null;
  amountUsdMillions: number | null;
  amountValue: number | null;
  amountCurrency: string | null;
  financingTotalAsWritten?: string | null;
  /** Canonical source URLs. */
  sourceIds: string[];
  datePrecision?: string;
  stageAsWritten?: string;
  isExtension?: boolean;
  /** Investor keys of the leads, so a late re-report with the same lead joins its round. */
  leadKeys?: string[];
}

/** One word of five letters or fewer ("nova", "heidi") names too many companies to join two rows on the name alone. */
function shortSingleName(key: string): boolean {
  const tokens = key.split(" ").filter(Boolean);
  return tokens.length === 1 && tokens[0].length <= 5;
}

/**
 * Whether two company rows are one company. "same": one row, one name key (alias keys included),
 * or one domain. "alias": every word of one name is in the other ("Ultraviolette" and
 * "Ultraviolette Automotive", "Eco5Tech" and "Eco5Tech S.A.") and no two different domains say
 * otherwise; the round must then agree on more than the name (isDuplicateRound). Null otherwise.
 */
export function companyMatch(a: CompanyIdentity, b: CompanyIdentity): "same" | "alias" | null {
  if (a.domain && b.domain && a.domain !== b.domain) return null;
  if (a.companyId === b.companyId) return "same";
  const keysA = new Set([a.nameKey, ...a.aliasKeys]);
  if ([b.nameKey, ...b.aliasKeys].some((k) => keysA.has(k))) return "same";
  if (a.domain && a.domain === b.domain) return "same";
  const ta = a.nameKey.split(" ").filter(Boolean);
  const tb = b.nameKey.split(" ").filter(Boolean);
  if (ta.length === 0 || tb.length === 0) return null;
  return ta.every((t) => tb.includes(t)) || tb.every((t) => ta.includes(t)) ? "alias" : null;
}

/** A repeated name is not an identity assertion unless a second identifying fact agrees. */
export function identityAgrees(stored: MergeRow, incoming: FeedRecord): boolean {
  if (stored.domain && incoming.company_domain) return stored.domain === incoming.company_domain;
  if (stored.domain && incoming.sources.some((source) => registrableDomain(source.url) === stored.domain)) return true;
  if (
    stored.identityHeadquarters &&
    incoming.headquarters &&
    normalizeCompanyKey(stored.identityHeadquarters) === normalizeCompanyKey(incoming.headquarters)
  )
    return true;
  if (stored.description && incoming.company_description) {
    const words = (text: string) =>
      new Set(
        normalizeCompanyKey(text)
          .split(" ")
          .filter((word) => word.length > 4),
      );
    const left = words(stored.description);
    const right = words(incoming.company_description);
    if ([...left].filter((word) => right.has(word)).length >= 2) return true;
  }
  return stored.sourceIds.some((url) => incoming.sources.some((source) => canonicalUrl(source.url) === url));
}

function storedIdentityAgrees(a: MergeRow, b: MergeRow): boolean {
  if (a.companyId === b.companyId) return true;
  if (a.domain && b.domain) return a.domain === b.domain;
  if (a.domain && b.sourceIds.some((url) => registrableDomain(url) === a.domain)) return true;
  if (b.domain && a.sourceIds.some((url) => registrableDomain(url) === b.domain)) return true;
  if (
    a.identityHeadquarters &&
    b.identityHeadquarters &&
    normalizeCompanyKey(a.identityHeadquarters) === normalizeCompanyKey(b.identityHeadquarters)
  )
    return true;
  if (a.description && b.description) {
    const terms = (text: string) =>
      new Set(
        normalizeCompanyKey(text)
          .split(" ")
          .filter((word) => word.length > 4),
      );
    const left = terms(a.description);
    if ([...terms(b.description)].filter((word) => left.has(word)).length >= 2) return true;
  }
  return a.sourceIds.some((url) => b.sourceIds.includes(url));
}

/**
 * Whether the two amounts agree within a tenth: in USD when both have it, else as stated in one
 * currency (an unread currency on both sides counts as one: Eco5Tech's "PLN 1,080,000" was stored
 * twice with no currency and no USD). Null when either amount is unknown.
 */
function amountsAgree(a: RoundIdentity, b: RoundIdentity): boolean | null {
  const pair: [number, number] | null =
    a.amountUsdMillions !== null && b.amountUsdMillions !== null
      ? [a.amountUsdMillions, b.amountUsdMillions]
      : a.amountValue !== null && b.amountValue !== null && a.amountCurrency === b.amountCurrency
        ? [a.amountValue, b.amountValue]
        : null;
  if (!pair) return null;
  const larger = Math.max(pair[0], pair[1]);
  return larger > 0 && Math.abs(pair[0] - pair[1]) <= larger * 0.1;
}

/** Days between two YYYY-MM-DD dates; infinite when either is missing. */
function daysApart(a: string | null, b: string | null): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

/**
 * Whether two rounds are one round. On one company (one row, name, or domain) isSameRound decides.
 * Across two company rows under two names, the case resolve's in-batch alias rule (isAlias) handles
 * inside one run and nothing handled across runs, the amounts must also agree and the two must share
 * a source or carry one stage within a week; a one-word name of five letters or fewer needs the
 * shared source.
 */
export function isDuplicateRound(a: RoundIdentity, b: RoundIdentity): boolean {
  const company = companyMatch(a, b);
  if (!company || !isSameRound(a, b)) return false;
  if (company === "same") return true;
  if (amountsAgree(a, b) !== true) return false;
  const shared = a.sourceIds.some((s) => b.sourceIds.includes(s));
  if (shortSingleName(a.nameKey) || shortSingleName(b.nameKey)) return shared;
  return shared || (a.stage === b.stage && daysApart(a.announcedOn, b.announcedOn) <= CROSS_STAGE_WINDOW_DAYS);
}

/**
 * Whether a reading would move a stored day later than a day a source dated: a day-precision date with
 * a basis (stated by the text, a byline, or a URL; a legacy row that never recorded one counts too)
 * never moves later on a later reading, whatever that reading's basis. Coverage trails a round, and a
 * redistribution's or a republication's day is later than the announcement: W4 Games' Aug 25 release
 * moved to a Business Wire redistribution URL-dated Sep 18 and then to the Sep 21 the read-back found on
 * it; bluecore-energy's day moved to a trade republication's Sep 22. Only a search result's day, or none,
 * yields. A roundup's, digest's, or newsletter's week or month is an upper bound the same way: a day read
 * later than it is a later page's, not the round's. A person moves a day later with fix-records.
 */
export function neverLater(
  stored: { announcedOn: string | null; datePrecision: string; dateBasis: string | null },
  incoming: string | null,
): boolean {
  if (!stored.announcedOn || !incoming) return false;
  // A list's week or month is an upper bound on the round's day: the round fell on or before it (the
  // last day of the month, for a month).
  if (stored.datePrecision === "week") return incoming > stored.announcedOn;
  if (stored.datePrecision === "month") {
    const [y, m] = stored.announcedOn.split("-").map(Number);
    return incoming > new Date(Date.UTC(y as number, m as number, 0)).toISOString().slice(0, 10);
  }
  if (stored.datePrecision !== "day") return false;
  if (stored.dateBasis === "result" || stored.dateBasis === "none") return false;
  return incoming > stored.announcedOn;
}

/**
 * Whether a stored row keeps its own day against a reading of the same round. A later day never moves a
 * dated day (neverLater). A stated day beats a
 * borrowed one either way. Otherwise, two days further apart than the same-stage window mean the
 * later is a re-report (a September roundup of a February round, a launch story months after the
 * seed), and the earlier day is the round's; nearer, the finer precision wins as before, and the
 * persist update's own rule (a coarser reading never replaces a finer day) still applies after this.
 */
export function keepsStoredDay(
  stored: { announcedOn: string | null; datePrecision: string; dateBasis: string | null },
  incoming: Pick<FeedRecord, "announced_date" | "date_precision" | "date_basis">,
): boolean {
  if (!stored.announcedOn) return false;
  if (!incoming.announced_date) return true;
  if (neverLater(stored, incoming.announced_date)) return true;
  const storedStated = stored.dateBasis === "stated";
  const incomingStated = incoming.date_basis === "stated";
  if (incomingStated !== storedStated) return storedStated;
  const gap = readingGap(
    { stage: "", announcedOn: stored.announcedOn, datePrecision: stored.datePrecision },
    { stage: "", announcedOn: incoming.announced_date, datePrecision: incoming.date_precision },
  );
  if (gap > SAME_STAGE_WINDOW_DAYS) return stored.announcedOn < incoming.announced_date;
  return false;
}

/** An arriving record as round dedupe sees it. */
function recordIdentity(r: FeedRecord): RoundIdentity {
  return {
    companyId: companyIdFor(r),
    nameKey: r.company_key,
    domain: r.company_domain,
    aliasKeys: [],
    stage: r.stage,
    announcedOn: r.announced_date,
    amountUsdMillions: r.amount.usd_millions,
    amountValue: r.amount.value,
    amountCurrency: r.amount.currency,
    financingTotalAsWritten: r.financing_total_as_written ?? null,
    sourceIds: r.sources.map((s) => canonicalUrl(s.url)),
    datePrecision: r.date_precision,
    stageAsWritten: r.stage_as_written,
    isExtension: r.is_extension,
    leadKeys: r.lead_investors.map((n) => investorKeyForMerge(n)),
  };
}

function matchingCertainty(stored: MergeRow, incoming: FeedRecord, identity: RoundIdentity): boolean {
  if (!companyMatch(stored, identity)) return false;
  if (stored.certainty === "announced" && (incoming.certainty ?? "announced") === "announced") return isDuplicateRound(stored, identity);
  if (stored.certainty !== "announced" && incoming.certainty !== "announced") return isDuplicateRound(stored, identity);
  if (stored.stage !== incoming.stage || daysApart(stored.announcedOn, incoming.announced_date) > 90) return false;
  const close = (a: number | null, b: number | null) =>
    a !== null && b !== null && a > 0 && b > 0 && Math.abs(a - b) <= 0.25 * Math.max(a, b);
  const amount = close(stored.amountUsdMillions, incoming.amount.usd_millions);
  const previousValuation = parseAmount(stored.valuationAsWritten).value;
  const incomingValuation = parseAmount(incoming.valuation_as_written).value;
  return amount || close(previousValuation, incomingValuation);
}

/**
 * The company rows a set of name keys and domains could be: the same key, domain, or alias key,
 * or a name whose words all sit inside a key's, or contain all of a key's.
 */
function companyScope(keys: string[], domains: string[]): SQL {
  const named = keys.filter(Boolean);
  const conds: SQL[] = [];
  if (named.length > 0) {
    conds.push(inArray(companies.nameKey, named));
    conds.push(
      sql`exists (select 1 from company_aliases a where a.company_id = ${companies.id} and a.kind = 'name' and a.alias_key in ${named})`,
    );
    for (const key of named) {
      conds.push(
        sql`(${companies.nameKey} <> '' and (string_to_array(${companies.nameKey}, ' ') <@ string_to_array(${key}, ' ') or string_to_array(${companies.nameKey}, ' ') @> string_to_array(${key}, ' ')))`,
      );
    }
  }
  if (domains.length > 0) conds.push(inArray(companies.domain, domains));
  return conds.length > 0 ? (or(...conds) ?? sql`false`) : sql`false`;
}

/** A stored round with everything the dedupe rule compares and everything a merge carries over. */
export interface MergeRow extends RoundIdentity {
  id: string;
  certainty: RoundCertainty;
  reportedOn: string | null;
  freshnessCheckedOn: string | null;
  verificationNotes: string[];
  description: string | null;
  identityHeadquarters: string | null;
  companyName: string;
  presetSlug: string;
  stageAsWritten: string;
  amountAsWritten: string | null;
  fxRate: string | null;
  fxDate: string | null;
  valuationAsWritten: string | null;
  valuationClaims: ValuationClaim[] | null;
  financingTotalAsWritten: string | null;
  financingTotalQuote: string | null;
  amountScope: string | null;
  financingStages: string[] | null;
  headquarters: string | null;
  sector: string | null;
  datePrecision: string;
  dateBasis: string | null;
  confidence: number;
  verificationStatus: string | null;
  disposition: "publish" | "flagged" | "review" | "rejected";
  status: "new" | "updated" | "seen";
  evidence: string[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** An earlier round promoted from a dossier; a merge keeps the flag only when both rows carry it. */
  history: boolean;
  /** Why the row is held from delivery (lib/late-report.ts), or null. */
  hold: string | null;
  /** Facts a person set by hand (fix-records), which nothing automatic moves. */
  pinned: Pinned | null;
}

/** The facts fix-records pins on a row: a redate's day, a restage's stage, a valuation (null pins it blank). */
export interface Pinned {
  announced_on?: string;
  stage?: string;
  valuation?: string | null;
}

/**
 * The claims a stored row's valuation stands on: its checked claims, or, for a valuation stored before
 * claims were kept, that valuation as an unquoted claim, which any checked claim outranks.
 */
function storedClaims(row: Pick<MergeRow, "valuationAsWritten" | "valuationClaims">): ValuationClaim[] {
  if (row.valuationClaims?.length) return row.valuationClaims;
  return row.valuationAsWritten ? [{ value: row.valuationAsWritten, quote: null, url: "", tier: 0 }] : [];
}

/** Two claims are one when the same page states the same figure. */
function sameClaim(a: ValuationClaim, b: ValuationClaim): boolean {
  return a.url === b.url && a.value === b.value;
}

/** Stored rounds with their company's identity and their sources, for dedupe and merges. */
export async function roundsForMerge(handle: Db, where?: SQL): Promise<MergeRow[]> {
  const rows = await handle
    .select({
      round: fundingRounds,
      companyName: companies.name,
      nameKey: companies.nameKey,
      domain: companies.domain,
      description: companies.description,
      companyHq: companies.hq,
      aliasKeys: sql<
        string[] | null
      >`(select jsonb_agg(a.alias_key) from company_aliases a where a.company_id = ${companies.id} and a.kind = 'name')`,
      sourceIds: sql<string[] | null>`(select jsonb_agg(rs.source_id) from round_sources rs where rs.round_id = ${fundingRounds.id})`,
      leadKeys: sql<
        string[] | null
      >`(select jsonb_agg(ri.investor_id) from round_investors ri where ri.round_id = ${fundingRounds.id} and ri.role = 'lead')`,
    })
    .from(fundingRounds)
    .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
    .where(where);
  const num = (v: string | null) => (v === null ? null : Number(v));
  return rows.map(({ round, companyName, nameKey, domain, description, companyHq, aliasKeys, sourceIds, leadKeys }) => ({
    id: round.id,
    certainty: round.certainty,
    reportedOn: round.reportedOn,
    companyId: round.companyId,
    companyName,
    nameKey,
    domain,
    description,
    identityHeadquarters: companyHq,
    aliasKeys: aliasKeys ?? [],
    sourceIds: sourceIds ?? [],
    leadKeys: leadKeys ?? [],
    isExtension: round.isExtension,
    presetSlug: round.presetSlug,
    stage: round.stage,
    stageAsWritten: round.stageAsWritten,
    announcedOn: round.announcedOn,
    datePrecision: round.datePrecision,
    dateBasis: round.dateBasis,
    amountUsdMillions: num(round.amountUsdMillions),
    amountValue: num(round.amountValue),
    amountCurrency: round.amountCurrency,
    amountAsWritten: round.amountAsWritten,
    fxRate: round.fxRate,
    fxDate: round.fxDate,
    valuationAsWritten: round.valuationAsWritten,
    valuationClaims: round.valuationClaims ?? null,
    financingTotalAsWritten: round.financingTotalAsWritten,
    financingTotalQuote: round.financingTotalQuote,
    amountScope: round.amountScope,
    financingStages: round.financingStages,
    headquarters: round.headquarters,
    sector: round.sector,
    confidence: Number(round.confidence),
    verificationStatus: (round.verification as { status?: string } | null)?.status ?? null,
    disposition: round.disposition,
    status: round.status,
    evidence: round.evidenceQuotes ?? [],
    firstSeenAt: round.firstSeenAt,
    lastSeenAt: round.lastSeenAt,
    history: round.history,
    hold: round.hold,
    pinned: round.pinned ?? null,
    freshnessCheckedOn: round.freshnessCheckedOn,
    verificationNotes: (round.verification as { notes?: string[] } | null)?.notes ?? [],
  }));
}

export async function persistRecords(
  handle: Db,
  records: FeedRecord[],
  presetSlug: string,
  runId: string,
  options: PersistOptions = {},
): Promise<PersistSummary> {
  const summary: PersistSummary = { inserted: 0, updated: 0, unchanged: 0, changedIds: [], insertedIds: [], persistedIds: [] };
  if (records.length === 0) return summary;

  // The same round arrives from different runs with different dates (the roundup says the
  // 4th, the press release the 2nd), sometimes a different stage label ("seed" here,
  // "pre-Series A" there), and sometimes a different name for the company ("Ultraviolette"
  // here, "Ultraviolette Automotive" there, with no domain on either). Match by exact id first,
  // then by one company inside isSameRound's windows, then by the alias rule, and merge into
  // the row already there.
  // A reading that rebuilds a merged-away id (Fearn's digest copy, read again by a preset whose ledger
  // never saw the page) is the survivor's reading: the id follows its tombstones first.
  const survivors = await tombstoneTargets(
    handle,
    records.map((r) => r.id),
  );
  for (const r of records) {
    r.id = survivors.get(r.id) ?? r.id;
    // A lane that read no valuation sentence (a filing, a post, an older reading) still has its valuation
    // checked against what the record keeps (valuation.ts): one that only another round's sentence
    // states is contradicted, taken off, and the row flagged; one no sentence states is left out of this reading.
    if (r.valuation_as_written && !r.valuation_claims?.length) {
      const why = unsupportedValuation(r);
      if (why && /another round|an earlier round|dates another|total/.test(why)) {
        const note = `valuation ${r.valuation_as_written} dropped: ${why}`;
        r.valuation_as_written = null;
        r.valuation_ruled_out = why;
        if (r.verification && !r.verification.notes.includes(note))
          r.verification = { ...r.verification, notes: [...r.verification.notes, note] };
      } else if (why) {
        r.valuation_as_written = null;
      }
    }
  }
  const keys = [...new Set(records.map((r) => r.company_key))];
  const domains = [...new Set(records.map((r) => r.company_domain).filter((d): d is string => Boolean(d)))];
  const scoped = await roundsForMerge(handle, companyScope(keys, domains));
  const unscoped = [...new Set(survivors.values())].filter((id) => !scoped.some((c) => c.id === id));
  const candidates = unscoped.length > 0 ? [...scoped, ...(await roundsForMerge(handle, inArray(fundingRounds.id, unscoped)))] : scoped;

  for (const r of records) {
    const me = recordIdentity(r);
    const collision =
      candidates.some((c) => c.nameKey === r.company_key) && !candidates.some((c) => c.nameKey === r.company_key && identityAgrees(c, r));
    if (collision && !options.companyId) {
      const fork = `${r.id}:identity:${r.company_domain ?? registrableDomain(r.sources[0]?.url) ?? "unknown"}`;
      r.id = (await tombstoneTargets(handle, [fork])).get(fork) ?? fork;
    }
    const match =
      candidates.find((c) => c.id === r.id && identityAgrees(c, r)) ??
      candidates.find((c) => identityAgrees(c, r) && companyMatch(c, me) === "same" && matchingCertainty(c, r, me)) ??
      candidates.find((c) => identityAgrees(c, r) && matchingCertainty(c, r, me));
    if (!match) continue;
    r.id = match.id;
    // Across a stage disagreement the surer reading names the round, and a stageless one never unnames it.
    const unnames = isStageless(r.stage) && !isStageless(match.stage as Stage);
    if (
      match.stage !== r.stage &&
      ((r.verification?.status !== "confirmed" && r.verification?.status !== "corrected") ||
        match.verificationStatus === "confirmed" ||
        match.verificationStatus === "corrected") &&
      (match.confidence > r.confidence || unnames)
    ) {
      r.stage = match.stage as FeedRecord["stage"];
      r.stage_as_written = match.stageAsWritten;
    }
  }
  const existing = candidates.filter((c) => records.some((r) => r.id === c.id));
  const existingById = new Map(existing.map((e) => [e.id, e]));
  const existingLeads = existing.length
    ? await handle
        .select({ roundId: roundInvestors.roundId, investorId: roundInvestors.investorId })
        .from(roundInvestors)
        .where(
          and(
            inArray(
              roundInvestors.roundId,
              existing.map((e) => e.id),
            ),
            eq(roundInvestors.role, "lead"),
          ),
        )
    : [];
  const leadsByRound = new Map<string, string[]>();
  for (const l of existingLeads) leadsByRound.set(l.roundId, [...(leadsByRound.get(l.roundId) ?? []), l.investorId]);
  // What decides whether a row's sources are all secondhand: the publisher tiers, and the classifier's
  // stored reading of a page from a host no tier names.
  const tiers = { ...DEFAULT_TIERS, ...(await loadPublisherTiers()) };
  const sourceUrls = [
    ...new Set([...records.flatMap((r) => r.sources.map((s) => canonicalUrl(s.url))), ...existing.flatMap((e) => e.sourceIds)]),
  ];
  const kinds = new Map<string, string>();
  const titles = new Map<string, string | null>();
  const excerpts = new Map<string, string | null>();
  if (sourceUrls.length > 0) {
    const [verdicts, storedSources, claims] = await Promise.all([
      handle
        .select({ url: pageVerdicts.url, kind: pageVerdicts.kind })
        .from(pageVerdicts)
        .where(inArray(pageVerdicts.url, sourceUrls))
        .orderBy(pageVerdicts.createdAt),
      handle.select({ id: sources.id, title: sources.title }).from(sources).where(inArray(sources.id, sourceUrls)),
      existing.length
        ? handle
            .select({ roundId: roundSources.roundId, sourceId: roundSources.sourceId, claims: roundSources.fieldClaims })
            .from(roundSources)
            .where(
              inArray(
                roundSources.roundId,
                existing.map((row) => row.id),
              ),
            )
        : [],
    ]);
    for (const v of verdicts) kinds.set(canonicalUrl(v.url), v.kind);
    for (const source of storedSources) titles.set(source.id, source.title);
    for (const claim of claims)
      excerpts.set(`${claim.roundId}:${claim.sourceId}`, (claim.claims as { evidence?: string | null } | null)?.evidence ?? null);
  }

  for (const r of records) {
    const now = new Date();
    const identityCollision =
      candidates.some((c) => c.nameKey === r.company_key) && !candidates.some((c) => c.nameKey === r.company_key && identityAgrees(c, r));
    // Keep the company row the existing round already points at, so a later run that learns
    // the domain does not fork the company; and when the domain it learned already belongs to
    // another row, fold this one into that row instead of colliding on the unique domain.
    const companyId = await claimDomain(
      handle,
      existingById.get(r.id)?.companyId ??
        options.companyId ??
        (identityCollision
          ? `${companyIdFor(r)}:identity:${registrableDomain(r.sources[0]?.url) ?? r.id}`
          : (candidates.find((c) => identityAgrees(c, r) && companyMatch(c, recordIdentity(r)))?.companyId ?? companyIdFor(r))),
      r.company_domain,
    );
    await handle
      .insert(companies)
      .values({
        id: companyId,
        name: r.company_name,
        nameKey: r.company_key,
        domain: r.company_domain,
        website: r.company_website,
        description: r.company_description,
        hq: r.headquarters,
        sector: r.sector,
      })
      .onConflictDoUpdate({
        target: companies.id,
        set: {
          name: sql`CASE WHEN length(excluded.name) > length(${companies.name}) THEN excluded.name ELSE ${companies.name} END`,
          website: sql`COALESCE(${companies.website}, excluded.website)`,
          domain: sql`COALESCE(${companies.domain}, excluded.domain)`,
          description: sql`COALESCE(${companies.description}, excluded.description)`,
          hq: sql`COALESCE(${companies.hq}, excluded.hq)`,
          sector: keptSector(sql`excluded.sector`),
          updatedAt: now,
        },
      });
    await rememberNameKey(handle, companyId, r.company_key, r.company_name, r.sources[0]?.url ?? null);

    const prev = existingById.get(r.id);
    // A closing lifts a reported or expected round only when a page that would make a round visible
    // states it: a newsletter's "raised" does not outrank a scoop's "nearing" (Modal Labs, 2026-09-28).
    const certaintyRank: Record<RoundCertainty, number> = { unconfirmed: 0, expected: 1, reported: 2, announced: 3 };
    const sourceCertainty = r.sources.map((s) => ({
      source: s,
      certainty: assertedRoundCertainty(s.evidence ?? (r.sources.length === 1 ? r.evidence_quotes.join(" ") : null)),
    }));
    const closes = visibilityEvidence(
      sourceCertainty.filter((s) => s.certainty === "announced").map((s) => s.source),
      r.company_domain,
      [],
      tiers,
    );
    if (prev && prev.certainty !== "announced" && (r.certainty ?? "announced") === "announced" && !closes) r.certainty = prev.certainty;
    if (prev) r.evidence_quotes = [...new Set([...prev.evidence, ...r.evidence_quotes])];
    const upgrade = Boolean(
      prev && prev.certainty !== "announced" && r.certainty === "announced" && matchingCertainty(prev, r, recordIdentity(r)),
    );
    const reportedOn = prev?.reportedOn ?? (r.certainty !== "announced" ? (r.announced_date ?? now.toISOString().slice(0, 10)) : null);
    const arriving = r.certainty ?? prev?.certainty ?? "announced";
    r.certainty =
      prev?.certainty === "unconfirmed" && arriving !== "announced"
        ? "unconfirmed"
        : prev && certaintyRank[prev.certainty] > certaintyRank[arriving]
          ? prev.certainty
          : arriving;
    if (upgrade && reportedOn) {
      const note = `Reported before its announcement on ${reportedOn}`;
      const verification = r.verification ?? { status: "unverified" as const, notes: [], url: null };
      if (!verification.notes.includes(note)) r.verification = { ...verification, notes: [...verification.notes, note] };
    }
    if (
      prev &&
      (prev.verificationStatus === "confirmed" || prev.verificationStatus === "corrected") &&
      r.verification?.status !== "confirmed" &&
      r.verification?.status !== "corrected"
    ) {
      r.stage = prev.stage as FeedRecord["stage"];
      r.stage_as_written = prev.stageAsWritten;
      r.is_extension = prev.isExtension ?? r.is_extension;
    }
    // A fact a person pinned stands whatever this reading says (fix-records).
    if (prev?.pinned?.stage) {
      r.stage = prev.stage as FeedRecord["stage"];
      r.stage_as_written = prev.stageAsWritten;
    }
    // The valuation: a pinned one stands; a contradicted one is retracted, clearing the row's; otherwise
    // the claims the row and this reading hold decide it (pickValuation), never the later or longer string.
    if (prev?.pinned && "valuation" in prev.pinned) {
      r.valuation_as_written = prev.pinned.valuation ?? null;
    } else if (r.valuation_ruled_out) {
      r.valuation_claims = [];
    } else {
      const claims = [...(prev ? storedClaims(prev) : [])];
      for (const c of r.valuation_claims ?? []) if (!claims.some((o) => sameClaim(o, c))) claims.push(c);
      r.valuation_as_written = pickValuation(claims)?.value ?? null;
      r.valuation_claims = claims.filter((c) => c.quote);
    }
    // A re-report joins its round but does not re-date it: the row keeps its own day (keepsStoredDay),
    // and a pinned day always.
    if (prev && (prev.pinned?.announced_on || (!upgrade && keepsStoredDay(prev, r)))) {
      r.announced_date = prev.announcedOn;
      r.date_precision = prev.datePrecision as FeedRecord["date_precision"];
      r.date_basis = (prev.dateBasis ?? undefined) as FeedRecord["date_basis"];
      r.undated = prev.announcedOn === null;
    }
    // What the store already verified about this company: a reading with no amount that falls below
    // it, or is known only from a list, starts in review (a trend story's OpenAI "Series A").
    const me = recordIdentity(r);
    const known: StoredRound[] = candidates
      .filter((c) => c.id !== r.id && (c.companyId === companyId || companyMatch(c, me) === "same"))
      .filter((c) => c.disposition === "publish" || c.disposition === "flagged")
      .map((c) => ({
        stage: c.stage,
        announcedOn: c.announcedOn,
        amountUsdMillions: c.amountUsdMillions,
        verified: c.history || c.verificationStatus === "confirmed" || c.verificationStatus === "corrected",
      }));
    // A row that already states a figure keeps it through an unjudged reading that lost it, so it is not thin.
    const implausible = options.startIn === "review" || prev?.amountAsWritten ? null : implausibleReading(r, known);
    // Facts that cannot all be true send the row to Review for a person (invariants.ts), never fixed by a rule.
    const siblings = candidates.filter((c) => c.id !== r.id && (c.companyId === companyId || companyMatch(c, me) === "same"));
    const breach = invariantBreach(r, siblings);
    const secondhand = secondhandOnly([...new Set([...r.sources.map((s) => s.url), ...(prev?.sourceIds ?? [])])], tiers, kinds);
    const investorNames = [...r.lead_investors, ...r.other_investors];
    const investorDomains = investorNames.length
      ? await handle
          .select({ domain: investors.domain })
          .from(investors)
          .where(inArray(investors.id, investorNames.map(investorKeyForMerge)))
      : [];
    const companySites = options.history
      ? await handle
          .select({ domain: schema.companyAliases.aliasKey })
          .from(schema.companyAliases)
          .where(and(eq(schema.companyAliases.companyId, companyId), eq(schema.companyAliases.kind, "domain")))
      : [];
    const trusted = visibilityEvidence(
      [...r.sources, ...(prev?.sourceIds ?? []).map((url) => ({ url, title: titles.get(url), evidence: excerpts.get(`${r.id}:${url}`) }))],
      r.company_domain,
      investorDomains.flatMap((i) => (i.domain ? [i.domain] : [])),
      tiers,
      options.history ? { name: r.company_name, sites: companySites.map((s) => s.domain) } : undefined,
    );
    // A namesake doubt from an earlier pass lifts once the company's own site states the round: that page settles whose round it is.
    const ownSite =
      Boolean(r.company_domain) &&
      [...r.sources.map((s) => s.url), ...(prev?.sourceIds ?? [])].some((url) => registrableDomain(url) === r.company_domain);
    const namesake =
      identityCollision ||
      (!ownSite && Boolean(prev?.verificationNotes?.some((note) => note.includes("same-name company identity is unverified"))));
    if (!namesake && r.verification?.notes.includes(IDENTITY_HOLD)) {
      r.verification = { ...r.verification, notes: r.verification.notes.filter((note) => note !== IDENTITY_HOLD) };
    }
    const doubt =
      (namesake ? "same-name company identity is unverified" : null) ??
      implausible ??
      breach ??
      (secondhand ? "only funding databases, profile pages, or forums state it" : null) ??
      (!trusted
        ? "source fidelity is not independent confirmation; waiting for a primary source, established publication, or independent corroboration"
        : null) ??
      (!options.history && prev?.freshnessCheckedOn !== r.announced_date ? "earliest-report search pending" : null);
    if (doubt) {
      const note = `held for review: ${doubt}`;
      const v = r.verification ?? { status: "unverified" as const, notes: [], url: null };
      r.verification = v.notes.includes(note) ? v : { ...v, notes: [...v.notes, note] };
    }
    // A held row keeps its reason in view whatever a later read-back writes over the notes.
    if (prev?.hold && r.verification && !r.verification.notes.includes(prev.hold)) {
      r.verification = { ...r.verification, notes: [...r.verification.notes, prev.hold] };
    }
    for (const note of prev?.verificationNotes.filter((entry) => entry.startsWith("Reported before its announcement on ")) ?? []) {
      const verification = r.verification ?? { status: "unverified" as const, notes: [], url: null };
      if (!verification.notes.includes(note)) r.verification = { ...verification, notes: [...verification.notes, note] };
    }
    const judged = r.verification?.status === "confirmed" || r.verification?.status === "corrected";
    const leadKeys = r.lead_investors.map((n) => investorKeyForMerge(n));
    const newlyConfirmed = judged && prev && prev.verificationStatus !== "confirmed" && prev.verificationStatus !== "corrected";
    const changed = prev
      ? fingerprint({ amountAsWritten: prev.amountAsWritten, announcedOn: prev.announcedOn, leads: leadsByRound.get(r.id) ?? [] }) !==
          fingerprint({ amountAsWritten: r.amount.as_written, announcedOn: r.announced_date, leads: leadKeys }) ||
        Boolean(newlyConfirmed) ||
        prev.certainty !== r.certainty
      : false;

    const base = {
      companyId,
      presetSlug,
      stage: r.stage,
      stageAsWritten: r.stage_as_written,
      isExtension: r.is_extension,
      amountValue: r.amount.value?.toString() ?? null,
      amountCurrency: r.amount.currency,
      amountAsWritten: r.amount.as_written,
      amountUsdMillions: r.amount.usd_millions?.toString() ?? null,
      fxRate: r.amount.fx_rate?.toString() ?? null,
      fxDate: r.amount.fx_date,
      valuationAsWritten: r.valuation_as_written,
      valuationClaims: r.valuation_claims?.length ? r.valuation_claims : null,
      financingTotalAsWritten: r.financing_total_as_written ?? null,
      financingTotalQuote: r.financing_total_quote ?? null,
      amountScope: r.amount_scope ?? null,
      financingStages: r.financing_stages?.length ? r.financing_stages : null,
      announcedOn: r.announced_date,
      certainty: r.certainty ?? "announced",
      reportedOn,
      datePrecision: r.date_precision,
      dateBasis: r.date_basis ?? null,
      headquarters: r.headquarters,
      sector: r.sector,
      evidenceQuotes: r.evidence_quotes,
      confidence: r.confidence.toFixed(2),
      verification: r.verification ?? null,
      disposition: doubt ? "review" : (options.startIn ?? dispositionFor(r, { secondhand })),
      lastSeenAt: now,
      updatedAt: now,
    };

    // A lane running beside this one may have written the same id since the candidates were read:
    // the insert then yields, and this reading updates that row like any existing one.
    const inserted = prev
      ? []
      : await handle
          .insert(fundingRounds)
          .values({ id: r.id, status: options.history ? "seen" : "new", history: options.history ?? false, ...base })
          .onConflictDoNothing()
          .returning({ id: fundingRounds.id });
    if (inserted.length > 0) {
      summary.inserted++;
      summary.changedIds.push(r.id);
      summary.insertedIds.push(r.id);
    } else {
      // Derived fields refresh (a parser fix should reach old rows), but a fact never degrades to
      // nothing: a later reading that lost the date or the amount keeps what the row already knows.
      // Status flips to `updated` only when the facts changed, and a reviewer's decision is never
      // overwritten: review and flagged are the machine's own states and follow the evidence (a row
      // flagged before it was read back publishes once the read confirms it); publish and rejected may
      // be a reviewer's word and stand. A lane's `startIn` is where its own new rows begin, never a
      // demotion of a row another lane already placed.
      // The preset that found the round owns the row: a Form D filing that matches a news round attaches
      // to it and never turns a Series A into a form-d row.
      const { disposition, presetSlug: _incomingPreset, ...derived } = base;
      const keep = <T>(incoming: T | null, column: (typeof fundingRounds)[keyof typeof fundingRounds]) =>
        incoming === null ? sql`${column}` : incoming;
      await handle
        .update(fundingRounds)
        .set({
          ...derived,
          // The surer date wins: a day from a press release replaces a week from a roundup, never the reverse.
          announcedOn:
            r.announced_date === null
              ? sql`${fundingRounds.announcedOn}`
              : upgrade && !prev?.pinned?.announced_on
                ? r.announced_date
                : sql`CASE WHEN ${rankSql(fundingRounds.datePrecision)} > ${DATE_PRECISION_RANK[r.date_precision]} THEN ${fundingRounds.announcedOn} ELSE ${r.announced_date} END`,
          certainty: r.certainty ?? "announced",
          reportedOn: sql`coalesce(${fundingRounds.reportedOn}, ${reportedOn})`,
          dateBasis:
            r.announced_date === null
              ? sql`${fundingRounds.dateBasis}`
              : upgrade && !prev?.pinned?.announced_on
                ? (r.date_basis ?? null)
                : sql`CASE WHEN ${rankSql(fundingRounds.datePrecision)} > ${DATE_PRECISION_RANK[r.date_precision]} THEN ${fundingRounds.dateBasis} ELSE ${r.date_basis ?? null} END`,
          datePrecision:
            r.announced_date === null
              ? sql`${fundingRounds.datePrecision}`
              : upgrade && !prev?.pinned?.announced_on
                ? r.date_precision
                : sql`CASE WHEN ${rankSql(fundingRounds.datePrecision)} > ${DATE_PRECISION_RANK[r.date_precision]} THEN ${fundingRounds.datePrecision} ELSE ${r.date_precision} END`,
          // A judged record's amount is the page's word, null included (the judge found the figure unstated);
          // an unjudged reading that lost the amount keeps what the row knows.
          amountAsWritten: judged ? r.amount.as_written : keep(r.amount.as_written, fundingRounds.amountAsWritten),
          amountValue: judged ? (r.amount.value?.toString() ?? null) : keep(r.amount.value?.toString() ?? null, fundingRounds.amountValue),
          amountCurrency: judged ? r.amount.currency : keep(r.amount.currency, fundingRounds.amountCurrency),
          amountUsdMillions: judged
            ? (r.amount.usd_millions?.toString() ?? null)
            : keep(r.amount.usd_millions?.toString() ?? null, fundingRounds.amountUsdMillions),
          fxRate: judged ? (r.amount.fx_rate?.toString() ?? null) : keep(r.amount.fx_rate?.toString() ?? null, fundingRounds.fxRate),
          fxDate: judged ? r.amount.fx_date : keep(r.amount.fx_date, fundingRounds.fxDate),
          // Decided above from the row's claims and this reading's: a retraction clears it, a pin holds it.
          valuationAsWritten: r.valuation_as_written,
          valuationClaims: r.valuation_claims?.length ? r.valuation_claims : null,
          financingTotalAsWritten: keep(r.financing_total_as_written ?? null, fundingRounds.financingTotalAsWritten),
          financingTotalQuote: keep(r.financing_total_quote ?? null, fundingRounds.financingTotalQuote),
          amountScope: keep(r.amount_scope ?? null, fundingRounds.amountScope),
          financingStages: r.financing_stages?.length ? r.financing_stages : sql`${fundingRounds.financingStages}`,
          headquarters: keep(r.headquarters, fundingRounds.headquarters),
          // A verdict never degrades to nothing: an unjudged reading (a filing, a monitor alert off the plan) keeps the row's.
          verification: r.verification ? r.verification : sql`${fundingRounds.verification}`,
          sector: keep(r.sector, fundingRounds.sector),
          // A change is news only to someone who already read the row: an unseen row stays new.
          // A history reading is never news to anyone, and a history row is never unread, so
          // neither marks a row updated.
          ...(changed && !options.history
            ? {
                status: sql`CASE WHEN ${fundingRounds.status} = 'seen' AND NOT ${fundingRounds.history} THEN 'updated' ELSE ${fundingRounds.status} END`,
              }
            : {}),
          // A post-only reading never moves a row the pipeline or a person already placed, and no reading
          // moves a held row: it waits for a person (lib/late-report.ts).
          disposition:
            options.startIn === "flagged"
              ? fundingRounds.disposition
              : options.startIn
                ? sql`CASE WHEN ${fundingRounds.hold} IS NULL AND ${fundingRounds.disposition} = 'review' THEN ${disposition}::disposition ELSE ${fundingRounds.disposition} END`
                : r.valuation_ruled_out || doubt
                  ? // A valuation taken off, a broken invariant, or secondhand sources move even a published row.
                    sql`CASE WHEN ${fundingRounds.hold} IS NULL AND ${fundingRounds.disposition} IN ('review', 'flagged', 'publish') THEN ${disposition}::disposition ELSE ${fundingRounds.disposition} END`
                  : sql`CASE WHEN ${fundingRounds.hold} IS NULL AND ${fundingRounds.disposition} IN ('review', 'flagged') THEN ${disposition}::disposition ELSE ${fundingRounds.disposition} END`,
        })
        .where(eq(fundingRounds.id, r.id));
      if (changed) {
        summary.updated++;
        summary.changedIds.push(r.id);
      } else summary.unchanged++;
    }
    summary.persistedIds.push(r.id);

    // A judged record's lists are the page's word on this round and replace what the row had; an
    // unjudged reading (a filing, an off-plan alert) accumulates, except onto a row a reader already
    // verified: its lists are what the sources support, and an unread name would sit on a published
    // row unchecked. The reading's sources still attach, so the next read-back sees them.
    const rowVerified = prev?.verificationStatus === "confirmed" || prev?.verificationStatus === "corrected";
    if (judged || !rowVerified) await syncRoundInvestors(handle, r.id, r.lead_investors, r.other_investors, { replace: judged });

    for (const s of r.sources) {
      const sourceId = canonicalUrl(s.url);
      await handle
        .insert(sources)
        .values({ id: sourceId, url: sourceId, host: s.host, title: s.title, publishedAt: s.published, query: s.query, runId })
        // A page first stored without a date takes the one a later reading gives it (the day the read-back read off it).
        .onConflictDoUpdate({ target: sources.id, set: { publishedAt: sql`coalesce(${sources.publishedAt}, excluded.published_at)` } });
      await handle
        .insert(roundSources)
        .values({ roundId: r.id, sourceId, fieldClaims: sourceClaims(s) })
        .onConflictDoNothing();
    }
  }

  // Two lanes can each read no row for a round and each insert one (a monitor's pages ingest in
  // parallel, a sweep overlaps a backfill), and one batch can hold two names the resolver kept
  // apart. Each new row is checked against the store once it is written: whichever writer lands
  // second sees both, and the planner's order makes every writer pick the same survivor.
  // An updated row is checked too: a read-back that re-dates or restages a row can land it on a round
  // the store already holds (Greyparrot's September row, re-dated to its July 28 announcement, sat
  // beside the July row it now matched, and only new rows were ever checked).
  if (summary.persistedIds.length > 0) {
    const { mergedInto } = await mergeDuplicateRounds(handle, { roundIds: summary.persistedIds });
    if (Object.keys(mergedInto).length > 0) {
      const follow = (id: string) => mergedInto[id] ?? id;
      summary.changedIds = [...new Set(summary.changedIds.map(follow))];
      summary.insertedIds = [...new Set(summary.insertedIds.map(follow))];
      summary.persistedIds = [...new Set(summary.persistedIds.map(follow))];
    }
    // Before any lane delivers what it just wrote: a row that a lead source already shows is a late
    // re-report is held (a history row written here is a lead for its company's other rows too).
    const touched = await handle
      .selectDistinct({ companyId: fundingRounds.companyId })
      .from(fundingRounds)
      .where(inArray(fundingRounds.id, summary.persistedIds));
    await holdLateReports(
      handle,
      touched.map((t) => t.companyId),
    );
    await handle
      .update(fundingRounds)
      .set({ announcedOn: sql`${fundingRounds.announcedOn}` })
      .where(inArray(fundingRounds.id, summary.persistedIds));
  }
  await queueEarlierRounds(handle, records);
  return summary;
}

/**
 * The earlier rounds a record's page stated beside it (a stealth launch's seed with its Series A,
 * resolve.ts placeEarlierRounds) join the history ledger as leads (origin page) under the company
 * the record landed on, each with the page that states it, which the history lane reads first. A
 * round the store, the ledger, or the dossier already knows is not queued.
 */
async function queueEarlierRounds(handle: Db, records: FeedRecord[], now: Date = new Date()): Promise<void> {
  const carrying = records.filter((r) => r.earlier_rounds?.length);
  if (carrying.length === 0) return;
  const landed = await tombstoneTargets(
    handle,
    carrying.map((r) => r.id),
  );
  const ids = carrying.map((r) => landed.get(r.id) ?? r.id);
  const rows = await handle
    .select({ id: fundingRounds.id, companyId: fundingRounds.companyId })
    .from(fundingRounds)
    .where(inArray(fundingRounds.id, ids));
  const companyOf = new Map(rows.map((r) => [r.id, r.companyId]));
  for (const [i, r] of carrying.entries()) {
    const companyId = companyOf.get(ids[i] ?? r.id);
    if (!companyId) continue;
    const known = await knownRounds(handle, companyId);
    for (const prior of r.earlier_rounds ?? []) {
      if (!promotable(prior) || knownRound(priorAsKnown(prior), known)) continue;
      await handle
        .insert(schema.historyPromotions)
        .values({ companyId, priorKey: priorKey(prior), prior, origin: "page", status: "pending", nextAttemptAt: now })
        .onConflictDoNothing();
    }
  }
}

/**
 * What a link remembers about the reading that attached it: the sentence that placed the company on
 * the page and the title the page carried then. The source row is shared by every round it reports
 * and keeps its first title; the link keeps this round's own evidence, so a later audit reads why the
 * page was attached rather than guessing from a headline that may have changed since.
 */
export function sourceClaims(s: { title?: string | null; evidence?: string | null }): Record<string, unknown> | null {
  if (!s.evidence && !s.title) return null;
  return { evidence: s.evidence ?? null, title: s.title ?? null };
}

/**
 * A round's investors as one set across every write path (the sweep, corroboration, gap-fill): the
 * names already linked and the names arriving are reconciled through the alias-aware dedupe, so a
 * second spelling of one firm folds into the fuller, a placeholder never lands, and a lead stays a
 * lead whichever spelling survives. Links that fold away are removed; survivors are linked with their role.
 */
export async function syncRoundInvestors(
  handle: Db,
  roundId: string,
  leads: string[],
  others: string[],
  opts: { replace?: boolean } = {},
): Promise<void> {
  const linked = await handle
    .select({ investorId: roundInvestors.investorId, name: investors.name, role: roundInvestors.role })
    .from(roundInvestors)
    .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
    .where(eq(roundInvestors.roundId, roundId));
  const set = planRoundInvestors(linked, leads, others, opts);
  const leadIds = new Set(set.lead_investors.map((n) => investorKeyForMerge(n)));
  const survivors = [...set.lead_investors, ...set.other_investors];
  const survivorIds = new Set(survivors.map((n) => investorKeyForMerge(n)));
  for (const l of linked) {
    if (!survivorIds.has(l.investorId)) {
      await handle.delete(roundInvestors).where(and(eq(roundInvestors.roundId, roundId), eq(roundInvestors.investorId, l.investorId)));
    }
  }
  for (const name of survivors) {
    const investorId = investorKeyForMerge(name);
    if (!investorId) continue;
    const role = leadIds.has(investorId) ? "lead" : "participant";
    await handle.insert(investors).values({ id: investorId, name }).onConflictDoNothing();
    await handle
      .insert(roundInvestors)
      .values({ roundId, investorId, role })
      .onConflictDoUpdate({ target: [roundInvestors.roundId, roundInvestors.investorId], set: { role } });
  }
}

/**
 * The investor set syncRoundInvestors writes, without writing it: pure, so a hand-checked repair can
 * print the exact lists a write would leave before it makes one.
 */
export function planRoundInvestors(
  linked: Array<{ name: string; role: string }>,
  leads: string[],
  others: string[],
  opts: { replace?: boolean } = {},
): { lead_investors: string[]; other_investors: string[] } {
  // The union of what the row has and what arrives, folded to one entry per firm (the fuller spelling
  // shows). Replace: the incoming lists are the page's whole word on this round, so a firm neither list
  // names leaves the row; the row's spellings still lend themselves to the firms that stay. Incoming
  // names pass the same hygiene as an extraction's, whatever path supplied them.
  const newLeads = leads.flatMap((n) => normalizeInvestorName(n) ?? []);
  const newOthers = others.flatMap((n) => normalizeInvestorName(n) ?? []);
  const union = reconcileInvestorLists(
    [...linked.filter((l) => l.role === "lead").map((l) => l.name), ...newLeads],
    [...linked.filter((l) => l.role !== "lead").map((l) => l.name), ...newOthers],
  );
  const incoming = [...newLeads, ...newOthers];
  const sameFirm = (a: string, b: string) => dedupeInvestorNames([a, b]).length === 1;
  const named = (n: string) => incoming.some((i) => sameFirm(i, n));
  // Replace takes its roles from the incoming lists too: a lead the verifier demoted stays demoted,
  // though the union (where a firm in both lists is a lead) would put the row's old lead link back.
  const incomingLeads = reconcileInvestorLists(newLeads, newOthers).lead_investors;
  const survivorsNamed = [...union.lead_investors, ...union.other_investors].filter(named);
  return opts.replace
    ? {
        lead_investors: survivorsNamed.filter((n) => incomingLeads.some((l) => sameFirm(l, n))),
        other_investors: survivorsNamed.filter((n) => !incomingLeads.some((l) => sameFirm(l, n))),
      }
    : union;
}

export interface EnrichmentData {
  website_source?: string;
  company_website?: string | null;
  error?: string;
  pricing_page_url?: string | null;
  brand?: { name?: string | null; logo?: string | null; primary_color?: string | null } | null;
  profile?: { what_they_sell?: string; customer_type?: string; sells_software_subscription?: boolean; same_company?: boolean } | null;
  pricing?: { pricing_model?: string; has_free_tier?: boolean; plans?: Array<{ name: string; price_as_written: string | null }> } | null;
}

/** The stored profile enrichment, flattened to the shape rows and pages render. */
export function toEnrichment(e: EnrichmentData | undefined): RoundRow["enrichment"] {
  if (!e) return null;
  return {
    what_they_sell: e.profile?.what_they_sell ?? null,
    pricing_model: e.pricing?.pricing_model ?? null,
    has_free_tier: e.pricing?.has_free_tier ?? null,
    plans: e.pricing?.plans ?? [],
    pricing_page_url: e.pricing_page_url ?? null,
    website_source: e.website_source ?? null,
    verified:
      !!e.company_website && e.website_source !== "parked" && e.website_source !== "unverified" && e.profile?.same_company !== false,
    error: e.error ?? null,
    brand: e.brand ? { name: e.brand.name ?? null, primary_color: e.brand.primary_color ?? null } : null,
  };
}

/**
 * The stored alexandria enrichment, flattened to what rows and the API expose: the YC batch,
 * team, and founding facts and the FullEnrich firmographics, each only when that provider matched.
 */
export function toAlexandria(e: AlexandriaEnrichment | undefined, apolloRow?: ApolloEnrichment): RoundRow["alexandria"] {
  const apollo =
    apolloRow?.apollo.status === "matched" ? { headcount: apolloRow.apollo.headcount, linkedin_url: apolloRow.apollo.linkedin_url } : null;
  if (!e) return apollo ? { yc: null, firmographics: null, apollo } : null;
  return {
    apollo,
    yc:
      e.yc.status === "matched"
        ? { batch: e.yc.batch, team_size: e.yc.team_size, year_founded: e.yc.year_founded, founders_count: e.yc.founders.length }
        : null,
    firmographics:
      e.firmographics.status === "matched"
        ? {
            headcount_range: e.firmographics.headcount_range,
            headcount: e.firmographics.headcount || null,
            // Rows stored before the zero-means-unknown rule read the same way as rows stored after it.
            year_founded: e.firmographics.year_founded || null,
            company_type: e.firmographics.company_type,
            industry: e.firmographics.industry,
            linkedin_url: e.firmographics.linkedin_url ?? null,
          }
        : null,
  };
}

export interface RoundQuery {
  /** Exact ids, for a single-record lookup. */
  ids?: string[];
  since?: string;
  /** Announced on or before this day (YYYY-MM-DD); with `since`, the reader's own date range. */
  until?: string;
  stages?: Stage[];
  /** "current" includes reported and expected but excludes unconfirmed; "all" includes unconfirmed. */
  certainty?: RoundCertainty | "current" | "all";
  status?: Array<"new" | "updated" | "seen">;
  preset?: string;
  /** Everything but one preset: the review queue reads news without the Form D filings this way. */
  excludePreset?: string;
  sector?: string;
  /** Rounds with a source page on this host (techcrunch.com): the Overview's publisher links. */
  source?: string;
  /** Free text over company name, description, and investors. */
  q?: string;
  /** One company by registrable domain (acme.com) or name; exact, case-insensitive. */
  company?: string;
  /** One company by its primary key, for the company page. */
  companyId?: string;
  minUsdMillions?: number;
  includeReview?: boolean;
  /** Only records in review (the queue). */
  reviewOnly?: boolean;
  /**
   * History rows (earlier rounds promoted from dossiers): included when absent, which is what the
   * company and investor pages and every lookup read; "exclude" for the feed-shaped reads (the Latest
   * view, the RSS feeds, deliveries); "only" for a list of them alone.
   */
  history?: "exclude" | "only";
  /** "" (newest announced first) or "amount" (largest USD first, unknown amounts last). */
  sort?: RoundSort;
  /** Where the last page ended, as `roundCursorAfter` wrote it; a cursor from the other sort is ignored. */
  cursor?: string;
  /** Rows to skip, for the dashboard's numbered pages; the API pages by cursor instead. */
  offset?: number;
  limit?: number;
}

export interface RoundRow {
  id: string;
  company: {
    id: string;
    name: string;
    domain: string | null;
    website: string | null;
    logo_url: string | null;
    description: string | null;
    sector: string | null;
    hq: string | null;
  };
  stage: Stage;
  stage_as_written: string;
  is_extension: boolean;
  amount: { value: number | null; currency: string | null; as_written: string | null; usd_millions: number | null };
  financing_total_as_written: string | null;
  financing_total_quote: string | null;
  amount_scope: string | null;
  valuation_as_written: string | null;
  announced_on: string | null;
  certainty: RoundCertainty;
  reported_on: string | null;
  date_precision: "day" | "week" | "month" | "unknown";
  /** Where the day came from; a stated day stands, a borrowed one may yield to a surer sibling. */
  date_basis: "stated" | "page" | "url" | "result" | "none" | null;
  freshness_checked_on?: string | null;
  /** The verifier's verdict (the judge against one page, or the reconciling model against every source), null until verified. */
  verification: {
    status: string;
    notes: string[];
    url: string | null;
    verifier?: string;
    sources_seen?: number;
    sources_listed?: number;
  } | null;
  lead_investors: string[];
  other_investors: string[];
  sources: Array<{ url: string; title: string | null; host: string; published: string | null; query: string | null }>;
  evidence_quotes: string[];
  confidence: number;
  status: "new" | "updated" | "seen";
  disposition: "publish" | "flagged" | "review" | "rejected";
  /** The preset whose run wrote this row; a mixed feed shows it as a chip. */
  preset_slug: string;
  /** An earlier round promoted from the company's checked dossier and verified against its announcement: never sent as news. */
  history: boolean;
  /** Why the row is held from delivery as a likely late re-report (lib/late-report.ts), or null. */
  hold: string | null;
  /** Facts a person set by hand (fix-records), which nothing automatic moves. */
  pinned: Pinned | null;
  first_seen_at: string;
  verification_checks?: { attempts: number; last_checked_at: string | null } | null;
  last_seen_at: string;
  /** Company profile from the enrichment step, when it has run for this company. */
  enrichment: {
    what_they_sell: string | null;
    pricing_model: string | null;
    has_free_tier: boolean | null;
    plans: Array<{ name: string; price_as_written: string | null }>;
    pricing_page_url: string | null;
    website_source: string | null;
    /** True when a homepage passed the identity check; false when every candidate was refused or none was found. */
    verified: boolean;
    /** Why there is no profile: the hosts tried and what each turned out to sell. */
    error: string | null;
    /** What the branding format read off the verified homepage. */
    brand: { name: string | null; primary_color: string | null } | null;
  } | null;
  /** Sourced company facts from Alexandria (YC, FullEnrich, Apollo), keyed on the verified domain. */
  alexandria: {
    yc: { batch: string | null; team_size: number | null; year_founded: number | null; founders_count: number } | null;
    firmographics: {
      headcount_range: string | null;
      headcount: number | null;
      year_founded: number | null;
      company_type: string | null;
      industry: string | null;
      linkedin_url: string | null;
    } | null;
    /** Apollo's headcount and checked LinkedIn page; a reader shows each only where the others have none. */
    apollo: { headcount: number | null; linkedin_url: string | null } | null;
  } | null;
}

/** What the feed table renders per row: RoundRow without the fields no cell or detail reads, so a page of rows is a fraction of the payload. */
export type FeedRow = Omit<RoundRow, "sources" | "evidence_quotes" | "enrichment" | "date_basis" | "last_seen_at" | "hold" | "pinned"> & {
  reported_later?: boolean;
  sources: Array<Pick<RoundRow["sources"][number], "url" | "title" | "host" | "query">>;
  /** The detail reads the first quote and the count, so only the first leaves the store. */
  evidence_quotes: string[];
  enrichment: Pick<
    NonNullable<RoundRow["enrichment"]>,
    "pricing_model" | "has_free_tier" | "plans" | "pricing_page_url" | "verified"
  > | null;
};

export function toFeedRow(r: RoundRow): FeedRow {
  return {
    id: r.id,
    company: r.company,
    stage: r.stage,
    stage_as_written: r.stage_as_written,
    is_extension: r.is_extension,
    amount: r.amount,
    financing_total_as_written: r.financing_total_as_written,
    financing_total_quote: r.financing_total_quote,
    amount_scope: r.amount_scope,
    valuation_as_written: r.valuation_as_written,
    announced_on: r.announced_on,
    certainty: r.certainty,
    reported_on: r.reported_on,
    date_precision: r.date_precision,
    // A feed row reaches the browser, so the verifier's model and each source's search text go
    // (lib/public-view.ts): the row keeps whether it was reconciled and the lane each page came by.
    verification: r.verification ? { ...r.verification, verifier: publicVerifier(r.verification.verifier) } : null,
    lead_investors: r.lead_investors,
    other_investors: r.other_investors,
    sources: r.sources.map((s) => ({ url: s.url, title: s.title, host: s.host, query: publicLane(s.query) })),
    evidence_quotes: r.evidence_quotes.slice(0, 1),
    confidence: r.confidence,
    status: r.status,
    disposition: r.disposition,
    preset_slug: r.preset_slug,
    history: r.history,
    reported_later: r.hold?.startsWith("reported later:") ?? false,
    first_seen_at: r.first_seen_at,
    enrichment: r.enrichment
      ? {
          pricing_model: r.enrichment.pricing_model,
          has_free_tier: r.enrichment.has_free_tier,
          plans: r.enrichment.plans,
          pricing_page_url: r.enrichment.pricing_page_url,
          verified: r.enrichment.verified,
        }
      : null,
    alexandria: r.alexandria,
  };
}

/** Items bucketed by key, each bucket in the input's order. */
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/**
 * Whether a feed-shaped read (the Latest view, the API's list, MCP's list) shows history rows. A
 * history row is a real round at its real date, but the feed is news: by default it lists what the
 * lanes caught. An earlier round shows once the reader asks for a date range (`since` or `until`),
 * where it is one more round inside the dates asked for, or for one company, where it is that
 * company's record.
 */
export function feedHistory(q: Pick<RoundQuery, "since" | "until" | "company">): RoundQuery["history"] {
  return q.since || q.until || q.company ? undefined : "exclude";
}

/** The WHERE half of a round query, shared by listRounds and countRounds. Cursor stays with the caller. */
function roundConds(q: RoundQuery) {
  const conds = [];
  if (q.ids?.length) conds.push(inArray(fundingRounds.id, q.ids));
  if (q.since) conds.push(gte(fundingRounds.announcedOn, q.since));
  if (q.until) conds.push(lte(fundingRounds.announcedOn, q.until));
  if (q.stages?.length) conds.push(inArray(fundingRounds.stage, q.stages));
  if (!q.certainty || q.certainty === "current") conds.push(sql`${fundingRounds.certainty} <> 'unconfirmed'`);
  else if (q.certainty && q.certainty !== "all") conds.push(eq(fundingRounds.certainty, q.certainty));
  if (q.status?.length) conds.push(inArray(fundingRounds.status, q.status));
  if (q.preset) conds.push(eq(fundingRounds.presetSlug, q.preset));
  if (q.excludePreset) conds.push(sql`${fundingRounds.presetSlug} <> ${q.excludePreset}`);
  if (q.minUsdMillions !== undefined) conds.push(gte(fundingRounds.amountUsdMillions, q.minUsdMillions.toString()));
  if (q.sector) conds.push(sql`lower(${companies.sector}) = lower(${q.sector})`);
  if (q.source) {
    conds.push(
      sql`exists (select 1 from ${roundSources} rs join ${sources} s on s.id = rs.source_id where rs.round_id = ${fundingRounds.id} and s.host = ${q.source})`,
    );
  }
  if (q.q) {
    const term = `%${q.q.replace(/[%_]/g, "")}%`;
    conds.push(
      sql`(${companies.name} ilike ${term} or coalesce(${companies.description}, '') ilike ${term} or exists (
        select 1 from ${roundInvestors} ri join ${investors} i on i.id = ri.investor_id
        where ri.round_id = ${fundingRounds.id} and i.name ilike ${term}))`,
    );
  }
  if (q.company) {
    const needle = q.company
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "");
    const byCompany = or(
      eq(companies.domain, needle),
      eq(companies.nameKey, normalizeCompanyKey(q.company)),
      sql`lower(${companies.name}) = ${needle}`,
    );
    if (byCompany) conds.push(byCompany);
  }
  if (q.companyId) conds.push(eq(fundingRounds.companyId, q.companyId));
  if (q.history === "exclude") conds.push(eq(fundingRounds.history, false));
  if (q.history === "only") conds.push(eq(fundingRounds.history, true));
  if (q.reviewOnly) conds.push(eq(fundingRounds.disposition, "review"));
  else if (!q.includeReview) conds.push(inArray(fundingRounds.disposition, ["publish", "flagged"]));
  return conds;
}

/** How many rows the filters match, ignoring paging: the feed header's "N OF M ROWS". */
export async function countRounds(handle: Db, q: RoundQuery = {}): Promise<number> {
  const conds = roundConds(q);
  const [row] = await handle
    .select({ n: sql<number>`count(*)::int` })
    .from(fundingRounds)
    .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
    .where(conds.length ? and(...conds) : undefined);
  return row?.n ?? 0;
}

export async function listRounds(handle: Db, q: RoundQuery = {}): Promise<{ rows: RoundRow[]; nextCursor: string | null }> {
  const limit = Math.min(q.limit ?? 50, 200);
  const sort: RoundSort = q.sort ?? "";
  const conds = roundConds(q);
  const cursor = q.cursor ? parseRoundCursor(q.cursor) : null;
  // Both orders are a key desc nulls last, then id desc, so a keyed cursor also admits the whole
  // null tail, and a cursor with no key starts inside that tail. A cursor from the other order
  // would skip rows, so it is dropped and the page starts from the top.
  if (cursor && cursor.sort === sort) {
    const [column, key] =
      cursor.sort === "amount" ? [fundingRounds.amountUsdMillions, cursor.usdMillions] : [fundingRounds.announcedOn, cursor.announced];
    const after =
      key === null
        ? and(isNull(column), lt(fundingRounds.id, cursor.id))
        : or(lt(column, key), and(eq(column, key), lt(fundingRounds.id, cursor.id)), isNull(column));
    if (after) conds.push(after);
  }
  const order =
    sort === "amount"
      ? [sql`${fundingRounds.amountUsdMillions} desc nulls last`, desc(fundingRounds.id)]
      : [sql`${fundingRounds.announcedOn} desc nulls last`, desc(fundingRounds.id)];

  const rows = await handle
    .select({ round: fundingRounds, company: companies })
    .from(fundingRounds)
    .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(...order)
    .limit(limit + 1)
    .offset(Math.max(0, Math.floor(q.offset ?? 0)));

  const page = rows.slice(0, limit);
  const ids = page.map((r) => r.round.id);
  const companyIds = [...new Set(page.map((r) => r.company.id))];
  // The page's investors, sources, and enrichments are three independent reads: together they cost
  // one round trip to the database, not three.
  const [inv, src, enrichRows, checks] = await Promise.all([
    ids.length
      ? handle
          .select({ roundId: roundInvestors.roundId, role: roundInvestors.role, name: investors.name })
          .from(roundInvestors)
          .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
          .where(inArray(roundInvestors.roundId, ids))
      : [],
    ids.length
      ? handle
          .select({
            roundId: roundSources.roundId,
            url: sources.url,
            title: sources.title,
            host: sources.host,
            published: sources.publishedAt,
            query: sources.query,
          })
          .from(roundSources)
          .innerJoin(sources, eq(sources.id, roundSources.sourceId))
          .where(inArray(roundSources.roundId, ids))
      : [],
    companyIds.length
      ? handle
          .select({ companyId: enrichments.companyId, kind: enrichments.kind, data: enrichments.data })
          .from(enrichments)
          .where(and(inArray(enrichments.companyId, companyIds), inArray(enrichments.kind, ["profile", "alexandria", "apollo"])))
      : [],
    ids.length
      ? handle
          .select({
            roundId: schema.roundVerification.roundId,
            attempts: schema.roundVerification.attempts,
            lastCheckedAt: schema.roundVerification.lastCheckedAt,
          })
          .from(schema.roundVerification)
          .where(inArray(schema.roundVerification.roundId, ids))
      : [],
  ]);
  const checksByRound = new Map(
    checks.map((c) => [c.roundId, { attempts: c.attempts, last_checked_at: c.lastCheckedAt?.toISOString() ?? null }]),
  );
  const profileByCompany = new Map(enrichRows.filter((e) => e.kind === "profile").map((e) => [e.companyId, e.data as EnrichmentData]));
  const alexandriaByCompany = new Map(
    enrichRows.filter((e) => e.kind === "alexandria").map((e) => [e.companyId, e.data as AlexandriaEnrichment]),
  );
  const apolloByCompany = new Map(enrichRows.filter((e) => e.kind === "apollo").map((e) => [e.companyId, e.data as ApolloEnrichment]));
  // Grouped once by round, in row order, so each row reads its own lists instead of scanning every row's.
  const invByRound = groupBy(inv, (i) => i.roundId);
  const srcByRound = groupBy(src, (s) => s.roundId);

  const out: RoundRow[] = page.map(({ round, company }) => ({
    id: round.id,
    company: {
      id: company.id,
      name: company.name,
      domain: company.domain,
      website: company.website,
      logo_url: company.logoUrl,
      description: company.description,
      sector: company.sector,
      hq: company.hq,
    },
    stage: round.stage,
    stage_as_written: round.stageAsWritten,
    is_extension: round.isExtension,
    amount: {
      value: round.amountValue === null ? null : Number(round.amountValue),
      currency: round.amountCurrency,
      as_written: round.amountAsWritten,
      usd_millions: round.amountUsdMillions === null ? null : Number(round.amountUsdMillions),
    },
    financing_total_as_written: round.financingTotalAsWritten,
    financing_total_quote: round.financingTotalQuote,
    amount_scope: round.amountScope,
    valuation_as_written: round.valuationAsWritten,
    announced_on: round.announcedOn,
    certainty: round.certainty,
    reported_on: round.reportedOn,
    date_precision: round.datePrecision as RoundRow["date_precision"],
    date_basis: (round.dateBasis as RoundRow["date_basis"]) ?? null,
    freshness_checked_on: round.freshnessCheckedOn,
    verification: (round.verification as RoundRow["verification"]) ?? null,
    lead_investors: (invByRound.get(round.id) ?? []).filter((i) => i.role === "lead").map((i) => i.name),
    other_investors: (invByRound.get(round.id) ?? []).filter((i) => i.role === "participant").map((i) => i.name),
    sources: (srcByRound.get(round.id) ?? []).map((s) => ({
      url: s.url,
      title: s.title,
      host: s.host,
      published: s.published ?? null,
      query: s.query ?? null,
    })),
    evidence_quotes: round.evidenceQuotes,
    confidence: Number(round.confidence),
    // A history row is never unread, whichever write path last touched its status.
    status: round.history ? "seen" : round.status,
    disposition: round.disposition,
    preset_slug: round.presetSlug,
    history: round.history,
    hold: round.hold,
    pinned: round.pinned ?? null,
    first_seen_at: round.firstSeenAt.toISOString(),
    verification_checks: checksByRound.get(round.id) ?? null,
    last_seen_at: round.lastSeenAt.toISOString(),
    enrichment: toEnrichment(profileByCompany.get(company.id)),
    alexandria: toAlexandria(alexandriaByCompany.get(company.id), apolloByCompany.get(company.id)),
  }));

  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? roundCursorAfter(sort, last.round) : null;
  return { rows: out, nextCursor };
}

/** Where a row sorts as a merge survivor: a visible row before one in review, review before rejected. */
const VISIBILITY: Record<MergeRow["disposition"], number> = { publish: 0, flagged: 0, review: 1, rejected: 2 };

/**
 * The order survivors are chosen in: a visible row over one in review, then the surer reading
 * (confidence, as the persist path names a stage), a verified row, more sources, a company with its
 * own domain, the earlier day, and last the id, so every writer that plans the same rows picks the
 * same survivor.
 */
export function survivorOrder(a: MergeRow, b: MergeRow): number {
  const verified = (r: MergeRow) => (r.verificationStatus === "confirmed" || r.verificationStatus === "corrected" ? 1 : 0);
  return (
    VISIBILITY[a.disposition] - VISIBILITY[b.disposition] ||
    b.confidence - a.confidence ||
    verified(b) - verified(a) ||
    b.sourceIds.length - a.sourceIds.length ||
    Number(Boolean(b.domain)) - Number(Boolean(a.domain)) ||
    (a.announcedOn ?? "9999-12-31").localeCompare(b.announcedOn ?? "9999-12-31") ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function storedCertaintyMatch(a: MergeRow, b: MergeRow): boolean {
  if (a.certainty === "announced" && b.certainty === "announced") return isDuplicateRound(a, b);
  if (a.certainty !== "announced" && b.certainty !== "announced") return isDuplicateRound(a, b);
  if (!companyMatch(a, b) || a.stage !== b.stage || daysApart(a.announcedOn, b.announcedOn) > 90) return false;
  const close = (x: number | null, y: number | null) =>
    x !== null && y !== null && x > 0 && y > 0 && Math.abs(x - y) <= 0.25 * Math.max(x, y);
  return (
    close(a.amountUsdMillions, b.amountUsdMillions) ||
    close(parseAmount(a.valuationAsWritten).value, parseAmount(b.valuationAsWritten).value)
  );
}

/**
 * The merges isDuplicateRound calls for among these rows, survivor first. A reviewer's reject
 * stands: a rejected row is never merged either way. With `involving`, only pairs that touch one of
 * those ids (the persist path checks its own new rows, not the whole neighbourhood).
 */
export function planRoundMerges(rows: MergeRow[], involving?: Set<string>): Array<{ keep: MergeRow; dup: MergeRow }> {
  const sorted = rows.filter((r) => r.disposition !== "rejected").sort(survivorOrder);
  const gone = new Set<string>();
  const out: Array<{ keep: MergeRow; dup: MergeRow }> = [];
  for (let i = 0; i < sorted.length; i++) {
    const keep = sorted[i];
    if (gone.has(keep.id)) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const dup = sorted[j];
      if (gone.has(dup.id)) continue;
      if (involving && !involving.has(keep.id) && !involving.has(dup.id)) continue;
      if (!storedIdentityAgrees(keep, dup) || !storedCertaintyMatch(keep, dup)) continue;
      out.push({ keep, dup });
      gone.add(dup.id);
    }
  }
  return out;
}

/**
 * The duplicate pairs in the store, or within a scope: one company's rows, or the rows that could
 * be the same round as the given ids (their company's names, alias keys, and domain).
 */
export async function findDuplicateRounds(
  handle: Db,
  scope: { companyId?: string; roundIds?: string[] } = {},
): Promise<Array<{ keep: MergeRow; dup: MergeRow }>> {
  if (scope.companyId) return planRoundMerges(await roundsForMerge(handle, eq(fundingRounds.companyId, scope.companyId)));
  if (scope.roundIds) {
    if (scope.roundIds.length === 0) return [];
    const seeds = await roundsForMerge(handle, inArray(fundingRounds.id, scope.roundIds));
    if (seeds.length === 0) return [];
    const keys = [...new Set(seeds.flatMap((s) => [s.nameKey, ...s.aliasKeys]))];
    const domains = [...new Set(seeds.flatMap((s) => (s.domain ? [s.domain] : [])))];
    return planRoundMerges(await roundsForMerge(handle, companyScope(keys, domains)), new Set(scope.roundIds));
  }
  return planRoundMerges(await roundsForMerge(handle));
}

/** One merge, planned from the store as it stands: what the survivor gains, and what moves or goes. */
export interface RoundMerge {
  keep: MergeRow;
  dup: MergeRow;
  /** How the rule joins them; null for a pair an operator forced. */
  match: "same" | "alias" | null;
  /** The company row that goes and the row it folds into, when the two rounds sit on two rows for one company. */
  company: { from: string; into: string } | null;
  /** The survivor's fields that change. */
  set: Partial<typeof fundingRounds.$inferInsert>;
  /** Source ids the survivor gains. */
  sources: string[];
  /** Investor links the survivor gains, or whose role rises to lead. */
  investors: Array<{ investorId: string; name: string; role: "lead" | "participant" | "unknown" }>;
  /** Delivery rows repointed to the survivor. */
  deliveries: number;
  /** The folded company's enrichments: kinds that move, and kinds the survivor already has (those go). */
  enrichments: { moved: string[]; dropped: string[] };
}

/**
 * What the survivor keeps from the row that goes: the surer day (a finer precision, then a stated
 * day over a borrowed one, then the earlier), the most-read status (a reader who saw the duplicate
 * has seen the round), the first sighting, every evidence sentence, a named stage when it has
 * none, and any fact it lacks.
 */
function survivorFacts(keep: MergeRow, dup: MergeRow): Partial<typeof fundingRounds.$inferInsert> {
  const set: Partial<typeof fundingRounds.$inferInsert> = {};
  const certaintyRank: Record<RoundCertainty, number> = { unconfirmed: 0, expected: 1, reported: 2, announced: 3 };
  if (certaintyRank[dup.certainty] > certaintyRank[keep.certainty]) set.certainty = dup.certainty;
  if (!keep.reportedOn && dup.reportedOn) set.reportedOn = dup.reportedOn;
  if (keep.reportedOn && dup.reportedOn && dup.reportedOn < keep.reportedOn) set.reportedOn = dup.reportedOn;
  const rank = (r: MergeRow) => (r.announcedOn ? (DATE_PRECISION_RANK[r.datePrecision as keyof typeof DATE_PRECISION_RANK] ?? 0) : -1);
  const stated = (r: MergeRow) => (r.dateBasis === "stated" ? 1 : 0);
  const pinnedDay = (r: MergeRow) => (r.pinned?.announced_on ? 1 : 0);
  // A pinned day wins; then a day no later than the other's dated day or list bound (neverLater: a
  // redistribution's stated day does not outrank the release's byline, nor a day after a roundup's week
  // the roundup); then the finer precision; then a stated day; then the earlier.
  const [dated] = [keep, dup].sort(
    (a, b) =>
      pinnedDay(b) - pinnedDay(a) ||
      (neverLater(a, b.announcedOn) ? -1 : neverLater(b, a.announcedOn) ? 1 : 0) ||
      rank(b) - rank(a) ||
      stated(b) - stated(a) ||
      (a.announcedOn ?? "").localeCompare(b.announcedOn ?? ""),
  );
  const confirmed = [keep, dup].find((r) => r.certainty === "announced");
  const dateSource =
    confirmed && !keep.pinned?.announced_on && !dup.pinned?.announced_on && keep.certainty !== dup.certainty ? confirmed : dated;
  if (
    dateSource !== keep &&
    (dateSource.announcedOn !== keep.announcedOn ||
      dateSource.datePrecision !== keep.datePrecision ||
      dateSource.dateBasis !== keep.dateBasis)
  ) {
    set.announcedOn = dateSource.announcedOn;
    set.datePrecision = dateSource.datePrecision;
    set.dateBasis = dateSource.dateBasis;
  }
  // A feed row folded into a history row makes the survivor a feed row, with the feed row's read state:
  // the round was caught as news, and a merge never hides news. A history row's "seen" was never a
  // reader's, so it lends no read state. Otherwise the most-read status wins.
  // A re-report (the feed row's day far after the history row's) was never news, so the survivor
  // stays history: Sammmm's January 2025 seed came back in a September 2026 snippet.
  const reReport = keep.announcedOn !== null && dup.announcedOn !== null && readingGap(keep, dup) > SAME_STAGE_WINDOW_DAYS;
  if (keep.history && !dup.history && !reReport) {
    set.history = false;
    if (dup.status !== keep.status) set.status = dup.status;
  } else if (keep.status === "new" && dup.status !== "new" && !dup.history) set.status = dup.status;
  if (dup.firstSeenAt < keep.firstSeenAt) set.firstSeenAt = dup.firstSeenAt;
  if (dup.lastSeenAt > keep.lastSeenAt) set.lastSeenAt = dup.lastSeenAt;
  const evidence = [...new Set([...keep.evidence, ...dup.evidence])];
  if (evidence.length > keep.evidence.length) set.evidenceQuotes = evidence;
  if (keep.amountAsWritten === null && dup.amountAsWritten !== null) {
    set.amountAsWritten = dup.amountAsWritten;
    set.amountValue = dup.amountValue?.toString() ?? null;
    set.amountCurrency = dup.amountCurrency;
    set.amountUsdMillions = dup.amountUsdMillions?.toString() ?? null;
    set.fxRate = dup.fxRate;
    set.fxDate = dup.fxDate;
  }
  // The more specific stage wins: a named stage beats none (IPID's own release said Series A, and a
  // forced merge that kept the marketscreener copy's "funding" row left the round with no stage at
  // all), a lettered label beats a generic one ("Series E" over "growth round"), and a label that
  // names its stage beats one that does not ("Seed" over "funding round").
  // A pinned stage wins over any label; otherwise the more specific one does.
  if (
    (dup.pinned?.stage && !keep.pinned?.stage) ||
    (!keep.pinned?.stage && stageSpecificity(dup.stage, dup.stageAsWritten) > stageSpecificity(keep.stage, keep.stageAsWritten))
  ) {
    set.stage = dup.stage as Stage;
    set.stageAsWritten = dup.stageAsWritten;
  }
  // The survivor carries every pin either row had, for the facts it took from that row.
  if (dup.pinned) {
    const pinned: Pinned = { ...(keep.pinned ?? {}) };
    if (dup.pinned.announced_on && !keep.pinned?.announced_on) pinned.announced_on = dup.pinned.announced_on;
    if (dup.pinned.stage && !keep.pinned?.stage) pinned.stage = dup.pinned.stage;
    if ("valuation" in dup.pinned && !(keep.pinned && "valuation" in keep.pinned)) pinned.valuation = dup.pinned.valuation;
    if (JSON.stringify(pinned) !== JSON.stringify(keep.pinned ?? {})) set.pinned = pinned;
  }
  // Both rows' valuation claims, and the valuation they support; a pin on either stands.
  const pin = [keep.pinned, dup.pinned].find((p) => p && "valuation" in p);
  const claims = [...storedClaims(keep)];
  for (const c of storedClaims(dup)) if (!claims.some((o) => sameClaim(o, c))) claims.push(c);
  const valuation = pin ? (pin.valuation ?? null) : (pickValuation(claims)?.value ?? null);
  if (valuation !== keep.valuationAsWritten) set.valuationAsWritten = valuation;
  if (claims.some((c) => c.quote)) set.valuationClaims = claims.filter((c) => c.quote);
  if (keep.financingTotalAsWritten === null && dup.financingTotalAsWritten !== null) {
    set.financingTotalAsWritten = dup.financingTotalAsWritten;
    set.financingTotalQuote = dup.financingTotalQuote;
  }
  if (keep.headquarters === null && dup.headquarters !== null) set.headquarters = dup.headquarters;
  if (keep.sector === null && dup.sector !== null) set.sector = dup.sector;
  return set;
}

/**
 * How much a stage says, for a merge choosing between two readings of one round: none (other,
 * undisclosed), a size bucket (growth, bridge), a named stage under a generic label ("funding
 * round"), and a named stage whose label names it ("Series E", "Seed", "Pre-seed").
 */
export function stageSpecificity(stage: string, written: string): number {
  if (isStageless(stage as Stage)) return 0;
  if (stage === "growth" || stage === "bridge") return 1;
  return /\b(series\s+[a-z](?![a-z])|pre-?\s?seed|seed|angel)/i.test(written) ? 3 : 2;
}

/**
 * Plan folding `dupId` into `keepId`, reading only. Two company rows for one company fold into the
 * one with its own domain (else the survivor's), as claimDomain folds them; two rows with two
 * different domains are two companies that share a name, so only the round moves. Null when either
 * round is gone.
 */
export async function planRoundMerge(handle: Db, keepId: string, dupId: string): Promise<RoundMerge | null> {
  const rows = await roundsForMerge(handle, inArray(fundingRounds.id, [keepId, dupId]));
  const keep = rows.find((r) => r.id === keepId);
  const dup = rows.find((r) => r.id === dupId);
  if (!keep || !dup || keepId === dupId) return null;
  const match = storedIdentityAgrees(keep, dup) && storedCertaintyMatch(keep, dup) ? companyMatch(keep, dup) : null;
  const twoSites = Boolean(keep.domain && dup.domain && keep.domain !== dup.domain);
  const company =
    keep.companyId === dup.companyId || twoSites
      ? null
      : !keep.domain && dup.domain
        ? { from: keep.companyId, into: dup.companyId }
        : { from: dup.companyId, into: keep.companyId };

  const links = await handle
    .select({ roundId: roundInvestors.roundId, investorId: roundInvestors.investorId, role: roundInvestors.role, name: investors.name })
    .from(roundInvestors)
    .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
    .where(inArray(roundInvestors.roundId, [keepId, dupId]));
  const kept = new Map(links.filter((l) => l.roundId === keepId).map((l) => [l.investorId, l.role]));
  // A verified survivor's investors are what its reader found the sources support: it takes the
  // duplicate's names and leads only when a reader verified those too. The duplicate's sources move
  // over either way, so the next read-back weighs an unverified name against every page.
  const verified = (r: MergeRow) => r.verificationStatus === "confirmed" || r.verificationStatus === "corrected";
  const gained =
    verified(keep) && !verified(dup)
      ? []
      : links.filter((l) => l.roundId === dupId && (!kept.has(l.investorId) || (l.role === "lead" && kept.get(l.investorId) !== "lead")));

  const deliveryRows = await handle
    .select({ roundId: schema.deliveries.roundId, channel: schema.deliveries.channel, target: schema.deliveries.target })
    .from(schema.deliveries)
    .where(inArray(schema.deliveries.roundId, [keepId, dupId]));
  const keptDeliveries = new Set(deliveryRows.filter((d) => d.roundId === keepId).map((d) => `${d.channel} ${d.target}`));
  const deliveries = deliveryRows.filter((d) => d.roundId === dupId && !keptDeliveries.has(`${d.channel} ${d.target}`)).length;

  const enrichmentRows = company
    ? await handle
        .select({ companyId: enrichments.companyId, kind: enrichments.kind })
        .from(enrichments)
        .where(inArray(enrichments.companyId, [company.from, company.into]))
    : [];
  const intoKinds = new Set(enrichmentRows.filter((e) => e.companyId === company?.into).map((e) => e.kind));
  const fromKinds = enrichmentRows.filter((e) => e.companyId === company?.from).map((e) => e.kind);

  return {
    keep,
    dup,
    match,
    company,
    set: survivorFacts(keep, dup),
    sources: dup.sourceIds.filter((s) => !keep.sourceIds.includes(s)),
    investors: gained.map((l) => ({ investorId: l.investorId, name: l.name, role: l.role })),
    deliveries,
    enrichments: { moved: fromKinds.filter((k) => !intoKinds.has(k)), dropped: fromKinds.filter((k) => intoKinds.has(k)) },
  };
}

/**
 * Carry out a planned merge: the company rows fold, the survivor gains the duplicate's sources (with
 * their field claims), the investors the plan carries (a lead stays a lead, spellings fold), and
 * deliveries, takes the facts survivorFacts chose, and the duplicate row is deleted. Each step is
 * safe to repeat, so a merge cut short finishes on the next run.
 */
export async function applyRoundMerge(handle: Db, m: RoundMerge): Promise<void> {
  const keepId = m.keep.id;
  const dupId = m.dup.id;
  if (m.company) await foldCompany(handle, m.company.from, m.company.into);
  await handle.execute(
    sql`insert into round_sources (round_id, source_id, field_claims) select ${keepId}, source_id, field_claims from round_sources where round_id = ${dupId} on conflict (round_id, source_id) do update set field_claims = coalesce(round_sources.field_claims, excluded.field_claims)`,
  );
  // Exactly the links the plan gained: the duplicate's row goes below, and its other links with it.
  for (const l of m.investors)
    await handle
      .insert(roundInvestors)
      .values({ roundId: keepId, investorId: l.investorId, role: l.role })
      .onConflictDoUpdate({
        target: [roundInvestors.roundId, roundInvestors.investorId],
        set: { role: sql`case when excluded.role = 'lead' then excluded.role else ${roundInvestors.role} end` },
      });
  await handle.execute(
    sql`insert into deliveries (round_id, channel, target, status, attempts, next_attempt_at, last_error, created_at) select ${keepId}, channel, target, status, attempts, next_attempt_at, last_error, created_at from deliveries where round_id = ${dupId} on conflict do nothing`,
  );
  await handle
    .update(fundingRounds)
    .set({ ...m.set, updatedAt: new Date() })
    .where(eq(fundingRounds.id, keepId));
  await handle.delete(fundingRounds).where(eq(fundingRounds.id, dupId));
  await syncRoundInvestors(handle, keepId, [], []);
  await recordTombstone(handle, dupId, keepId);
}

/**
 * Remember that `droppedId` now lives in `keptId`, and move every tombstone that pointed at the dropped
 * row onto the survivor, so a chain stays one hop long. Safe to repeat: a merge cut short and run again
 * writes the same row.
 */
export async function recordTombstone(handle: Db, droppedId: string, keptId: string): Promise<void> {
  if (droppedId === keptId) return;
  await handle
    .insert(roundMerges)
    .values({ droppedId, keptId })
    .onConflictDoUpdate({ target: roundMerges.droppedId, set: { keptId, mergedAt: new Date() } });
  await handle.update(roundMerges).set({ keptId }).where(eq(roundMerges.keptId, droppedId));
}

/**
 * The row each merged-away id lives in now, following chains (a survivor merged again later); ids with
 * no tombstone are absent from the map. A cycle, which no merge writes, stops at the last id before it
 * repeats.
 */
export async function tombstoneTargets(handle: Db, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let frontier = [...new Set(ids)];
  const hops = new Map<string, string>();
  while (frontier.length > 0) {
    const rows = await handle
      .select({ droppedId: roundMerges.droppedId, keptId: roundMerges.keptId })
      .from(roundMerges)
      .where(inArray(roundMerges.droppedId, frontier));
    for (const row of rows) hops.set(row.droppedId, row.keptId);
    frontier = rows.map((row) => row.keptId).filter((id) => !hops.has(id));
  }
  for (const id of new Set(ids)) {
    let to = hops.get(id);
    if (!to) continue;
    const seen = new Set([id]);
    while (hops.has(to) && !seen.has(to)) {
      seen.add(to);
      to = hops.get(to) as string;
    }
    out.set(id, to);
  }
  return out;
}

/**
 * Merge rounds isDuplicateRound calls one round into the surest row (survivorOrder), through
 * planRoundMerge and applyRoundMerge. The whole store, one company's rows, or the rows that could
 * duplicate `roundIds` (the persist path's check on its own new rows). `mergedInto` maps each
 * deleted id to the row that absorbed it.
 */
export async function mergeDuplicateRounds(
  handle: Db,
  scope: { companyId?: string; roundIds?: string[] } = {},
): Promise<{ merged: number; mergedInto: Record<string, string> }> {
  const mergedInto: Record<string, string> = {};
  const folded = new Set<string>();
  let merged = 0;
  for (const { keep, dup } of await findDuplicateRounds(handle, scope)) {
    const m = await planRoundMerge(handle, keep.id, dup.id);
    if (!m) continue;
    await applyRoundMerge(handle, m);
    mergedInto[dup.id] = keep.id;
    if (m.company) folded.add(m.company.into);
    merged++;
  }
  // A fold moves every round of the company row that went; those now share a row with the survivor's.
  for (const companyId of folded) {
    const more = await mergeDuplicateRounds(handle, { companyId });
    merged += more.merged;
    Object.assign(mergedInto, more.mergedInto);
  }
  for (const id of Object.keys(mergedInto)) {
    let to = mergedInto[id];
    while (mergedInto[to]) to = mergedInto[to];
    mergedInto[id] = to;
  }
  return { merged, mergedInto };
}

export async function recordRun(handle: Db, run: typeof schema.runs.$inferInsert): Promise<void> {
  await handle
    .insert(schema.runs)
    .values(run)
    .onConflictDoUpdate({ target: schema.runs.id, set: { ...run, id: undefined } });
}

/** Merge counters into a run's counts without touching the rest: a sweep reports mid-flight, the final recordRun overwrites wholesale. */
export async function mergeRunCounts(handle: Db, runId: string, counts: Record<string, number>): Promise<void> {
  await handle
    .update(schema.runs)
    .set({ counts: sql`coalesce(${schema.runs.counts}, '{}'::jsonb) || ${JSON.stringify(counts)}::jsonb` })
    .where(eq(schema.runs.id, runId));
}

/** Add to one counter in a run's counts, atomically: several ingest workflows report to one check at once. */
export async function bumpRunCount(handle: Db, runId: string, key: string, by: number): Promise<void> {
  if (by === 0) return;
  await handle
    .update(schema.runs)
    .set({
      counts: sql`jsonb_set(coalesce(${schema.runs.counts}, '{}'::jsonb), ${`{${key}}`}::text[], (coalesce(${schema.runs.counts}->>${key}, '0')::int + ${by})::text::jsonb)`,
    })
    .where(eq(schema.runs.id, runId));
}

/**
 * Make sure a monitor check has a run row. "Check now" writes one up front; a check that
 * arrived by webhook does not, so the first ingest to land creates it (and only then pays
 * one API read for the check's credits). Returns true when this call created the row.
 */
export async function ensureCheckRun(
  handle: Db,
  checkId: string,
  presetSlug: string,
  detail: () => Promise<{
    startedAt?: string | null;
    estimatedCredits?: number | null;
    actualCredits?: number | null;
    totalPages?: number | null;
  }>,
): Promise<boolean> {
  const inserted = await handle
    .insert(schema.runs)
    .values({
      id: `check:${checkId}`,
      presetSlug,
      lane: "monitor",
      window: "24h",
      startedAt: new Date(),
      finishedAt: new Date(),
      counts: { pages_extracted: 0, records: 0 },
    })
    .onConflictDoNothing()
    .returning({ id: schema.runs.id });
  if (inserted.length === 0) return false;
  try {
    const d = await detail();
    await handle
      .update(schema.runs)
      .set({
        startedAt: d.startedAt ? new Date(d.startedAt) : new Date(),
        creditsEstimated: d.estimatedCredits ?? null,
        creditsMeasured: d.actualCredits ?? null,
        counts: sql`coalesce(${schema.runs.counts}, '{}'::jsonb) || ${JSON.stringify({ search_results: d.totalPages ?? 0 })}::jsonb`,
      })
      .where(eq(schema.runs.id, `check:${checkId}`));
  } catch {
    // The row stands without credits; the next check detail read is not worth failing an ingest over.
  }
  return true;
}

export async function setStatus(handle: Db, ids: string[], status: "new" | "updated" | "seen"): Promise<number> {
  if (ids.length === 0) return 0;
  // A history row is never unread: marking one new or updated leaves it seen.
  const updated = await handle
    .update(fundingRounds)
    .set({ status, updatedAt: new Date() })
    .where(and(inArray(fundingRounds.id, ids), status === "seen" ? undefined : eq(fundingRounds.history, false)))
    .returning({ id: fundingRounds.id });
  return updated.length;
}

/** A person's placement of a row. Publishing or flagging a held row is their word that it is news: the hold lifts. */
export async function setDisposition(handle: Db, id: string, disposition: "publish" | "flagged" | "review" | "rejected"): Promise<void> {
  const lifts = disposition === "publish" || disposition === "flagged";
  await handle
    .update(fundingRounds)
    .set({ disposition, ...(lifts ? { hold: null } : {}), updatedAt: new Date() })
    .where(eq(fundingRounds.id, id));
}

/**
 * A reader's report on a row: it goes back to review and the reason lands in the verification notes
 * as `reported: <reason>`, beside the verifier's own word, so the queue shows what the reader saw
 * wrong. One update, so a row is never in review without its reason. A row never verified gets a
 * verification holding only the report.
 */
export async function reportRound(handle: Db, id: string, reason: string): Promise<void> {
  const [row] = await handle.select({ verification: fundingRounds.verification }).from(fundingRounds).where(eq(fundingRounds.id, id));
  if (!row) return;
  const current = (row.verification as RoundRow["verification"]) ?? { status: "unverified", notes: [], url: null };
  const verification = { ...current, notes: [...current.notes, `reported: ${reason.trim()}`] };
  await handle.update(fundingRounds).set({ disposition: "review", verification, updatedAt: new Date() }).where(eq(fundingRounds.id, id));
}

/** Distinct sectors seen on visible records, for the filter menu. */
export async function listSectors(handle: Db): Promise<string[]> {
  const rows = await handle
    .selectDistinct({ sector: companies.sector })
    .from(fundingRounds)
    .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
    .where(and(sql`${companies.sector} is not null`, inArray(fundingRounds.disposition, ["publish", "flagged"])))
    .orderBy(companies.sector);
  return rows.map((r) => r.sector).filter((s): s is string => Boolean(s));
}
