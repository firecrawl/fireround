// Turn extracted rounds into feed records: classify, drop background and unsupported rumors,
// date, window, dedupe by company and stage, merge aliases, score confidence.
// Every rung is a pure function over records; all of it is testable offline.

import { cleanHeadlineName } from "./brand-name.ts";
import { assertedRoundCertainty, classifyRoundCertainty, ROUND_CERTAINTY_RANK } from "./certainty.ts";
import type { RateTable } from "./fx.ts";
import { convertToUsd } from "./fx.ts";
import { cleanInvestors, dedupeInvestorNames, hasLeadLanguage, investorMentions } from "./investors.ts";
import { issuerTypeFromEvidence, mixedFinancingScope, nonStartupIssuerReason, safeMoneyKind } from "./money-kind.ts";
import {
  classifyStage,
  cleanText,
  dateFromUrl,
  dollarFromEvidence,
  hostOf,
  humanizeSlug,
  isArticleUrl,
  isCompanyDescription,
  isDataPointQuote,
  isDirectoryTitle,
  isTableRowQuote,
  NON_ARTICLE_HOSTS,
  namesCompany,
  normalizeAmountText,
  normalizeCompanyKey,
  parseAmount,
  parseDate,
  parseStatedDate,
  registrableDomain,
  SOCIAL_AND_DIRECTORY_HOSTS,
  slugWords,
  stageForAmount,
  stripFurniture,
  urlSlug,
  withinWindow,
} from "./normalize.ts";
import { backgroundByPageShape } from "./page-shape.ts";
import { bandForAmount, bandsOf, isFormDLabel, isStageless, notARound, notAStartupRound, type StageBand } from "./routing.ts";
import type { AmountScope, DatePrecision, ExtractedRound, FeedRecord, PageKind, RoundSource, Stage } from "./schema.ts";
import { DATE_PRECISION_RANK, NEWS_PAGE_KINDS } from "./schema.ts";
import { normalizeSector } from "./sectors.ts";
import { sourceFit } from "./source-fit.ts";
import { pickValuation, type ValuationClaim, valuationSupport, withBasis } from "./valuation.ts";

export interface ExtractedItem {
  round: ExtractedRound;
  source: RoundSource;
  /**
   * False when the page's own text does not contain the round's evidence (a sidebar or a
   * related-posts item, see `groundingCheck`). Absent when there was no page text to check.
   */
  grounded?: boolean;
  /** The extractor's reading of the page's kind, once per page. Absent or null when it gave none (an article, then). */
  page_kind?: PageKind | null;
  /** The date the page states it was published, as the extractor read it (or the page's own metadata). */
  page_date?: string | null;
  /** A publication day printed by the article near its headline, rather than a CMS or search date. */
  visible_article_date?: boolean;
  /** The city the page's dateline opens with, when it has one; never a headquarters on its own. */
  dateline?: string | null;
  /** The page names the company right around the valuation's sentence (namedNearby), so its "it" is the company. */
  valuation_named?: boolean;
  /**
   * The page gives the company a stock ticker ("Celularity Inc. (Nasdaq: CELU)"): a listed company's
   * financing with no stage named is an offering, not a venture round.
   */
  listed?: boolean;
}

export interface ResolveOptions {
  /** Stages the feed keeps. Everything else is counted and dropped, except a stageless round inside `stagelessBands`. */
  stages: Stage[];
  /**
   * The amount bands whose stageless rounds are kept ("$75 million in financing" names no stage): by
   * default the bands `stages` cover (see routing.ts), so the seed preset keeps an unlabelled $4M round
   * and the Series C preset an unlabelled $117M one. A lane that routes each record to its preset
   * afterwards (watch, the X lane, a pasted URL) passes every band.
   */
  stagelessBands?: readonly StageBand[];
  windowStart: Date;
  /** Exclusive end of the window; a month sweep sets it so the next month's announcements are dropped. Open when absent. */
  windowEnd?: Date;
  now?: Date;
  rates?: RateTable | null;
  /** Reviewer-maintained aliases: alias key -> canonical key. */
  aliases?: Record<string, string>;
  /** Publisher tiers by host: 1.0 press release or wire, 0.7 trade press, 0.4 aggregators. Unknown hosts score 0.3. */
  publisherTiers?: Record<string, number>;
  /**
   * Registrable domains whose pages are timelines of dated items. An item there without its own
   * date is a retrospective (a "biggest rounds of the year" post), not news, and is dropped
   * instead of queued for review. Default: x.com and twitter.com.
   */
  timelineHosts?: string[];
  /**
   * Keep an earlier round a stealth launch discloses beside the same company's later round (its seed
   * next to its Series A) as a record of its own: the history lane, which is looking for exactly that
   * round. Elsewhere it drops as background and rides on the later record as `earlier_rounds`.
   */
  keepEarlierRounds?: boolean;
}

export interface ResolveResult {
  kept: FeedRecord[];
  /** Rejected candidates never become funding rounds; retain the reason for ingest audits. */
  rejected: Array<{ company_name: string; source_url: string; disposition: "rejected"; reason: string }>;
  dropped: {
    otherStage: number;
    /** Stageless readings that are not a venture round: a fund close, an offering by a listed company, a buyout, a facility. */
    notARound: number;
    background: number;
    rumor: number;
    outOfWindow: number;
    undatedTimeline: number;
    /** Rounds whose evidence was not in the page's own text. */
    ungrounded: number;
    /** Rounds read off a listing, a profile, or an analysis: a page that mentions rounds without reporting one. */
    nonArticle: number;
    /** Rounds whose company name named no one ("Valley startup"): a paywalled preview or a pronoun. */
    unnamed: number;
    /** Rounds whose page is no source for the company: a job posting, a front page, an aggregator's other story, or a page that never names it (see sourceFit). */
    unrelatedSource: number;
  };
}

export const DEFAULT_TIMELINE_HOSTS = ["x.com", "twitter.com"];
/** A post announcing a round names one company, sometimes two (a merger, a co-announcement). Three or more is a list. */
const TIMELINE_LIST_THRESHOLD = 2;

/** A search result's day this close to the run is the clock's (an index or a repost called fresh), not the page's. */
const CLOCK_SLACK_MS = 36 * 3_600_000;

/** Hosts whose pages are social posts: no byline, URL, or search day dates a round read from one. */
const SOCIAL_POST_HOSTS = new Set(["instagram.com", "facebook.com", "threads.net", "tiktok.com", "linkedin.com"]);

/** A page published this long before the window is an old story, whatever date another rung finds for its round. */
const STALE_PAGE_GRACE_MS = 14 * 86_400_000;

/** A page that states this many rounds is a roundup, whatever the extractor labelled it: its date is a week at best. */
const ROUNDUP_ROUNDS_ON_PAGE = 3;

/** A roundup that covers a week, by its title or URL ("deals week of Aug 24", "this week's rounds"): its date is only good to the week. */
export const WEEKLY_LIST =
  /\b(?:week of|this week|the week['\u2019]?s|weekly|week in review|deals of the week|funding roundup|deal roundup|round-?up|biggest funding rounds|top funding rounds)\b/i;

/** A roundup that covers a month, by its title: its date is only good to the month. */
export const MONTHLY_LIST =
  /\b(monthly|month in review|this month|in (january|february|march|april|may|june|july|august|september|october|november|december)\b|(january|february|march|april|may|june|july|august|september|october|november|december)['’]?s? (biggest|largest|top|funding|deals|rounds)|(january|february|march|april|may|june|july|august|september|october|november|december) \d{4}\b[^.]{0,40}\b(roundup|round-up|recap|review|list|deals|rounds))/i;

/**
 * A digest, a newsletter, a column, a board, or a listicle by its title: "Funding Digest", "CTVC #212",
 * "The Crunchbase Unicorn Board", "169 VCs leading rounds this year", "Top 10 raises".
 */
const LIST_TITLE =
  /\b(?:digest|newsletter|round-?up|recap|wrap-?up|briefing|funding report|investment report|deal ?sheet|deals of the (?:day|week|month)|unicorn board|leaderboard|issue\s*(?:no\.?\s*)?#?\d+|edition\s*#?\d+|top \d+)\b|#\d{2,}\b|\b\d{2,}\s+(?:vcs?|venture capitalists|investors|startups|companies|rounds|deals|firms|unicorns)\b/i;

/** A newsletter's or a digest's address: its path, or a newsletter host (a Substack, a beehiiv, a newsletter. subdomain). */
const LIST_URL =
  /\/(?:digest|digests|newsletters?|roundups?|round-ups?|weekly|recaps?|briefings?|funding-reports?)(?:\/|-|$)|\/industry-insights\/robotics-raises-/i;
const LIST_HOST = /(?:^|\.)(?:newsletter\.[^/]+|[^/.]+\.substack\.com|[^/.]+\.beehiiv\.com)$/i;

/**
 * A page that reports rounds as a list: the extractor's roundup or newsletter, a page stating three or
 * more rounds, or one a title or address marks as a digest, a newsletter, a weekly or monthly list, a
 * board, or a listicle. A date read off such a page is its issue's day or bucket, never a round's
 * announcement: it is at most an upper bound (a week, or a month), and the row waits for a second source.
 */
export function isListPage(source: { url: string; title?: string | null }, pageKind?: PageKind | null, roundsOnPage = 0): boolean {
  if (pageKind === "roundup" || pageKind === "newsletter") return true;
  if (roundsOnPage >= ROUNDUP_ROUNDS_ON_PAGE) return true;
  const title = source.title ?? "";
  if (WEEKLY_LIST.test(title) || WEEKLY_LIST.test(source.url) || MONTHLY_LIST.test(title) || LIST_TITLE.test(title)) return true;
  if (LIST_URL.test(source.url)) return true;
  try {
    return LIST_HOST.test(new URL(source.url).hostname);
  } catch {
    return false;
  }
}

/** A profile, an interview, a Q&A, or a podcast page by its address or title: it recounts rounds, it does not announce them. */
const RECOUNT_URL =
  /(?:^|[/-])(?:executive-profiles?|profiles?|interviews?|q-?and-?a|podcasts?|spotlights?|meet-the|founder-stor(?:y|ies)|fireside)(?:[/-]|$)/i;
const RECOUNT_TITLE =
  /\b(?:executive profile|profile:|interview|q&a|podcast|spotlight|meet the (?:founder|ceo)|in conversation with|fireside chat)\b/i;

/**
 * A page that recounts a company's rounds rather than announcing one: an executive profile (the SF
 * Business Times' Sep 25 profile of Assort Health's CEO carried its June 24 Series C as "$120M funding",
 * page-dated, and it went to Slack as new), an interview, a Q&A, a podcast write-up. Its day is the
 * page's, not the round's: at most an upper bound, like a list's, and the row waits for a second source.
 */
export function isRecountPage(source: { url: string; title?: string | null }): boolean {
  let path = "";
  try {
    path = new URL(source.url).pathname;
  } catch {
    path = source.url;
  }
  return RECOUNT_URL.test(path) || RECOUNT_TITLE.test(source.title ?? "");
}

/** Link shorteners and PR trackers: never a company's website. */
const SHORTENER_HOSTS = new Set([
  "pr.report",
  "bit.ly",
  "t.co",
  "lnkd.in",
  "hubs.la",
  "hubs.ly",
  "ow.ly",
  "buff.ly",
  "tinyurl.com",
  "goo.gl",
  "rb.gy",
  "cutt.ly",
  "shorturl.at",
  "prn.to",
  "bwnews.pr",
  "glnws.co",
]);

/** The last day of the month a title names ("July 2026" is 2026-07-31); null when the title names none. */
export function monthNamedIn(title: string): Date | null {
  const m = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i.exec(title);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[2]), MONTH_INDEX[m[1].toLowerCase()] + 1, 0, 12));
}

/** Hosts whose URL carries the release day: the wires, and a company's own newsroom (matched by domain elsewhere). */
const RELEASE_HOSTS = new Set([
  "businesswire.com",
  "globenewswire.com",
  "prnewswire.com",
  "prweb.com",
  "accesswire.com",
  "newswire.ca",
  "einpresswire.com",
  "newsfilecorp.com",
  "reuters.com",
]);

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * "announced Tuesday", "said on Wednesday", "closed Monday": the most recent such weekday on or before
 * the page's own date. Null without a page date or a weekday.
 */
export function dateFromWeekday(evidence: string | null | undefined, pageDate: Date | null): Date | null {
  if (!evidence || !pageDate) return null;
  const m =
    /\b(?:announced|said|closed|raised|revealed|disclosed|confirmed|unveiled)\s+(?:on\s+|this\s+|last\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(
      evidence,
    );
  if (!m) return null;
  const target = WEEKDAYS.indexOf(m[1].toLowerCase());
  const d = new Date(Date.UTC(pageDate.getUTCFullYear(), pageDate.getUTCMonth(), pageDate.getUTCDate()));
  const back = (d.getUTCDay() - target + 7) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d;
}

const MONTH_INDEX: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

/**
 * Whether the sentence places the round in the past: a month and year before the window, "last year",
 * a season with "this" or "last", or "earlier this year". A profile or a follow-on story says "raised a
 * $3M seed this spring" or "announced closed in June 2025" and that round is history, not news.
 */
export function mentionsPastPeriod(evidence: string | null | undefined, windowStart: Date): boolean {
  if (!evidence) return false;
  if (
    /\b(last (?:year|month|spring|summer|fall|autumn|winter)|earlier this year|this (?:spring|summer|fall|autumn|winter)|(?:in|since|back in) (?:early|mid|late)?[- ]?\d{4}\b)/i.test(
      evidence,
    )
  ) {
    return true;
  }
  const m = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i.exec(evidence);
  if (!m) return false;
  const month = MONTH_INDEX[m[1].toLowerCase()];
  const monthEnd = new Date(Date.UTC(Number(m[2]), month + 1, 0));
  return monthEnd.getTime() < windowStart.getTime();
}

/** Whether the sentence describes an extension, a second close, or a top-up rather than a fresh round. */
export function evidenceSaysExtension(evidence: string | null | undefined): boolean {
  const e = evidence ?? "";
  // "expands into new markets" is use of funds; "expands its Series B" and "extends the round" are extensions.
  return (
    /\b(?:seed|pre-seed|series [a-z]|round|funding|financing)\s+(?:round\s+)?extension\b|\bextension\s+(?:round|financing|funding)\b|\b(?:second close|top[\s-]?up|additional (?:seed|pre-seed) (?:funding|financing|round|capital))\b/i.test(
      e,
    ) ||
    /\b(?:investment|financing|funding)\s+is\s+an?\s+extension\s+of\s+(?:the\s+)?(?:recent\s+|prior\s+|previous\s+)?round\b/i.test(e) ||
    /\b(?:extends?|extended|extending|expands?|expanded|expanding)\s+(?:its\s+|the\s+|their\s+|an?\s+)?(?:\$[\d.,]+\s*(?:m|mn|million|b|bn|billion)?\s+)?(?:oversubscribed\s+)?(?:series [a-z]\b|seed\b|pre-seed\b|round\b|financing\b|raise\b)/i.test(
      e,
    ) ||
    /\b(?:additional|follow[ -]?on)\s+investment\s+(?:in|into|of)\s+(?:the\s+)?(?:seed|series\s+[a-z])\b/i.test(e) ||
    /\badditional\s+(?:[$€£₹]|(?:USD|EUR|GBP|INR)\s*)?\d[\d,.]*\s*(?:m|million|b|billion|crore)?\s+(?:in\s+)?(?:pre-?seed|seed)\s+(?:funding|financing|investment)\b/i.test(
      e,
    )
  );
}

/**
 * Whether the amount in the sentence is the round's new total rather than the new money: "expands
 * $160m round", "bringing the round to $200M", "taking its Series C to". Such an amount is not the
 * extension's own and is left off the record.
 */
export function amountIsRoundTotal(evidence: string | null | undefined): boolean {
  const e = evidence ?? "";
  return (
    /\b(?:expand(?:s|ed|ing)?|extend(?:s|ed|ing)?|bring(?:s|ing)?|brought|tak(?:es|ing|en)|took|grow(?:s|ing)?|grew)\b[^.]{0,60}?\b(?:round|series [a-z]|seed|financing|raise)\b[^.]{0,30}?\bto\s+(?:\$|€|£|us\$|[a-z]{3}\s?)?\d/i.test(
      e,
    ) ||
    /\b(?:expand(?:s|ed)?|extend(?:s|ed)?)\s+(?:its\s+|the\s+)?(?:\$|€|£|us\$)\s?[\d.,]+\s*(?:m|mn|million|b|bn|billion)?\s+(?:series [a-z]\s+)?(?:round|raise|financing)\b/i.test(
      e,
    ) ||
    /\btotal (?:round|raise|funding) (?:to|of)\b/i.test(e)
  );
}

/**
 * Whether the amount's figure appears in the evidence: "$10 billion" needs a 10 followed by billion, bn,
 * or B in the sentence. One record's "$10 billion" came from a headline
 * about a compute partnership while the quoted sentence said only who co-led the Series A; an amount
 * the evidence does not state is not the round's.
 */
export function amountInEvidence(asWritten: string | null | undefined, evidence: string | null | undefined): boolean {
  if (!asWritten) return true;
  const target = parseAmount(asWritten);
  if (target.value === null) return false;
  const figures = normalizeAmountText(evidence ?? "").matchAll(
    /(?<![\w.])\d+(?:\.\d+)?\s*(?:billion|bn|b|million|mn|mm|m|thousand|k|crore|cr|lakh)?\b/gi,
  );
  return [...figures].some(([figure]) => parseAmount(figure).value === target.value);
}

/** Where a stage sits on the equity ladder; stages off the ladder (debt, grant, secondary) do not compete. */
const EQUITY_ORDER: Partial<Record<Stage, number>> = {
  pre_seed: 0,
  seed: 1,
  bridge: 1.5,
  pre_a: 1.75,
  series_a: 2,
  series_b: 3,
  series_c: 4,
  series_d_plus: 5,
  growth: 6,
};

/**
 * The keys of records that are an earlier round of a company whose later round came off the same
 * single-story page. Both readings share a primary source that is not a roundup (fewer than
 * ROUNDUP_ROUNDS_ON_PAGE rounds on it) and not a timeline; the one lower on the equity ladder is the
 * history the page recalled, and its key is returned so the caller can drop it.
 */
function earlierRoundsOnOnePage(records: FeedRecord[], roundsPerPost: Map<string, number>, timelineHosts: Set<string>): string[] {
  const byPageAndCompany = new Map<string, FeedRecord[]>();
  for (const r of records) {
    const primary = r.sources[0]?.url;
    if (!primary) continue;
    if ((roundsPerPost.get(primary) ?? 0) >= ROUNDUP_ROUNDS_ON_PAGE) continue;
    if (timelineHosts.has(registrableDomain(primary) ?? "")) continue;
    if (EQUITY_ORDER[r.stage] === undefined) continue;
    const key = `${primary}::${r.company_key}`;
    byPageAndCompany.set(key, [...(byPageAndCompany.get(key) ?? []), r]);
  }
  const drop: string[] = [];
  for (const group of byPageAndCompany.values()) {
    if (group.length < 2) continue;
    const top = Math.max(...group.map((r) => EQUITY_ORDER[r.stage] ?? -1));
    for (const r of group) if ((EQUITY_ORDER[r.stage] ?? -1) < top) drop.push(keyOf(r));
  }
  return drop;
}

/** The byKey map key for a record: its company key and stage, as the loop above builds it. */
function keyOf(r: FeedRecord): string {
  return `${r.company_key}|${r.stage}`;
}

/**
 * On a page that states two or more rounds, an investor the extractor attached to one item must
 * appear in that item's own sentence: the extractor bleeds one syndicate into the next item on a
 * roundup (a record carried fourteen names from two other companies' rounds). Single-story
 * pages are left alone, since the participants often sit in the sentence after the amount.
 */
export function groundInvestorsOnListPage(round: ExtractedRound, onListPage: boolean): ExtractedRound {
  if (!onListPage) return round;
  const named = investorMentions(round.evidence_quote);
  return {
    ...round,
    lead_investors: (round.lead_investors ?? []).filter(named),
    other_investors: (round.other_investors ?? []).filter(named),
  };
}

/**
 * Whether the sentence itself carries an absolute day: a month and day, a day and month, "on the 14th", an
 * ISO date. "Today", "this morning", and a weekday are resolved against the page's date and inherit its
 * doubt (a republisher's "this morning" was a day late), so they do not count.
 */
export function evidenceStatesDay(evidence: string | null | undefined): boolean {
  const text = evidence ?? "";
  return /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\bon the \d{1,2}(?:st|nd|rd|th)\b|\b\d{4}-\d{2}-\d{2}\b/i.test(
    text,
  );
}

/** Whether the evidence sentence names the company: at least half the name's longer tokens appear in it. */
export function evidenceNamesCompany(evidence: string | null | undefined, companyName: string): boolean {
  return namesCompany(evidence, companyName, { minTokenLength: 3, prefix: true });
}

/** On a page with several companies: the sentence names one of the others and not this one. */
export function evidenceNamesAnotherCompany(evidence: string | null | undefined, companyName: string, namesOnPage: string[]): boolean {
  if (evidenceNamesCompany(evidence, companyName)) return false;
  const mine = normalizeCompanyKey(companyName);
  return namesOnPage.some((other) => normalizeCompanyKey(other) !== mine && evidenceNamesCompany(evidence, other));
}

/** A name that is not a name: "Valley startup", "the company", "a Phoenix startup". */
export function isGenericCompanyName(name: string): boolean {
  const n = name.trim().toLowerCase();
  // "A, B, C, D and E" is a list of companies, not one; "Acme Robotics, Inc." is one company with its legal form.
  const bare = n.replace(
    /,\s*(?:inc|llc|ltd|limited|corp|corporation|co|gmbh|s\.?a\.?s?|ag|plc|l\.?l\.?p|l\.?p|pbc|pllc|bv|nv|oy|ab|as|pte|pty|kk)\.?$/i,
    "",
  );
  if (bare.includes(", ") || (bare.match(/\b(?:and|&)\b/g) ?? []).length >= 2) return true;
  return (
    /^(?:the |a |an )?(?:[a-z-]+ ){0,2}(?:startup|start-up|upstart|company|firm|business|venture|team)$/.test(n) || n === "the startup"
  );
}

/**
 * A sentence subject naming two entities of one brand ("Acme Therapeutics and Acme Biopharma")
 * is the first; two different companies ("Procter & Gamble") stay one name.
 */
export function firstOfTwoEntities(name: string): string {
  const m = /^(.+?)\s+(?:and|&)\s+(.+)$/.exec(name.trim());
  if (!m) return name;
  const [a, b] = [m[1], m[2]];
  const stem = (x: string) =>
    x
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 5);
  return a.length >= 3 && b.length >= 3 && stem(a) === stem(b) && /^[A-Z]/.test(b) ? a : name;
}

/**
 * The release date among a record's own sources beats a republisher's or a newsletter's. When the
 * record's date was not stated by the text and a wire or the company's own site carries a day in its
 * URL up to 21 days earlier, that day is the announcement. Returns the settled record; the input is
 * left as it was.
 */
export function settleDate(record: FeedRecord, opts: { onlyRough?: boolean } = {}): FeedRecord {
  // A record read back from the store carries no basis; then only a rough date (a week, a month, none) may move.
  if (opts.onlyRough && record.date_precision === "day" && !record.undated) return record;
  const stated = record.date_basis === "stated";
  const own = record.company_domain;
  // A page cannot report a round before it is announced: a stated day later than every source's own
  // day is impossible (a wire date nine days after every page that carried it) and the earliest page's day is
  // the best the row knows.
  if (stated && record.announced_date && record.date_precision === "day") {
    const days = record.sources
      .map((s) => dateFromUrl(s.url) ?? (s.published ? parseStatedDate(s.published) : null))
      .filter((d): d is Date => d !== null);
    if (days.length === record.sources.length && days.length > 0) {
      const latest = Math.max(...days.map((d) => d.getTime()));
      const current = new Date(`${record.announced_date}T00:00:00Z`).getTime();
      if (current - latest > 86_400_000) {
        const earliest = new Date(Math.min(...days.map((d) => d.getTime()))).toISOString().slice(0, 10);
        return { ...record, announced_date: earliest, date_basis: "page", id: recordId(record.company_key, record.stage, earliest) };
      }
    }
  }
  const days: Date[] = [];
  for (const src of record.sources) {
    const domain = registrableDomain(src.url);
    if (!domain) continue;
    const release = RELEASE_HOSTS.has(domain) || domain === own;
    // A day in the URL is the publisher's own dateline and is trusted on a wire, the company's site,
    // or any publisher the tiers rank at 0.7 or better; a search result's published day is trusted on
    // the wires only (elsewhere it can be the indexing day).
    // ... and never on a roundup, whose URL day is the issue's, not the round's.
    const roundup = isListPage(src);
    const trustedUrl = release || ((DEFAULT_TIERS[domain] ?? 0) >= 0.7 && !roundup);
    const d = (trustedUrl ? dateFromUrl(src.url) : null) ?? (release && src.published ? parseStatedDate(src.published) : null);
    if (!d) continue;
    // The list page that stamped a week or a month is not a sibling that sharpens it (Term Sheet's own URL day).
    if (record.date_precision !== "day" && d.toISOString().slice(0, 10) === record.announced_date) continue;
    days.push(d);
  }
  // The earliest day that fits the record's own date, not the earliest day overall: a feature from three
  // weeks before the release that only mentions the company once hid TechCrunch's dated story from a
  // republisher's byline (Bluecore kept Sep 22 over Sep 8 because Fortune's Aug 29 sat in its sources).
  const fits = (d: Date): boolean => {
    if (!record.announced_date) return true;
    const current = new Date(`${record.announced_date}T00:00:00Z`);
    const daysEarlier = (current.getTime() - d.getTime()) / 86_400_000;
    // A month-dated round takes the wire's day when it falls in that month, either side of the stamp.
    if (record.date_precision === "month")
      return d.getUTCFullYear() === current.getUTCFullYear() && d.getUTCMonth() === current.getUTCMonth();
    // A week-dated round takes a wire day inside the two weeks before the list, never after it: the
    // list's day is an upper bound on the round's.
    if (record.date_precision === "week") return daysEarlier >= 0 && daysEarlier <= 14;
    // A stated day stands: a wire URL carries the upload day, which can precede the release (a Business
    // Wire ID read the day before its release). A borrowed day yields to a wire up to 21 days earlier.
    return !stated && daysEarlier >= 0.5 && daysEarlier <= 21;
  };
  const best = days.filter(fits).sort((a, b) => a.getTime() - b.getTime())[0];
  if (!best) return record;
  const announced = best.toISOString().slice(0, 10);
  return {
    ...record,
    announced_date: announced,
    date_precision: "day",
    date_basis: "url",
    undated: false,
    id: recordId(record.company_key, record.stage, announced),
  };
}

export const DEFAULT_TIERS: Record<string, number> = {
  // A Form D is the issuer's own regulatory filing: the amount sold is sworn, not reported.
  "sec.gov": 1,
  "prnewswire.com": 1,
  "businesswire.com": 1,
  "globenewswire.com": 1,
  "techcrunch.com": 0.7,
  "axios.com": 0.7,
  "bloomberg.com": 0.7,
  "reuters.com": 0.7,
  "news.crunchbase.com": 0.7,
  "bizjournals.com": 0.7,
  "eu-startups.com": 0.7,
  "tech.eu": 0.7,
  "siliconangle.com": 0.7,
  "venturebeat.com": 0.7,
  "theinformation.com": 0.7,
  "fortune.com": 0.7,
  "forbes.com": 0.7,
  "wsj.com": 0.7,
  "ft.com": 0.7,
  "cnbc.com": 0.7,
  "businessinsider.com": 0.7,
  "geekwire.com": 0.7,
  "bioworld.com": 0.7,
  "livemint.com": 0.7,
  "cnbctv18.com": 0.7,
  "sifted.eu": 0.7,
  "fiercebiotech.com": 0.7,
  "endpts.com": 0.7,
  "biospace.com": 0.7,
  "skift.com": 0.7,
  "pymnts.com": 0.7,
  "finsmes.com": 0.5,
  "techstartups.com": 0.5,
  "vcnewsdaily.com": 0.4,
  "linkedin.com": 0.4,
  // Only the preset's configured accounts reach x.com as a source, so the tier is theirs, not the platform's.
  "x.com": 0.6,
};

/**
 * The money fields two readings of one round agree on: every valuation claim kept, and the valuation the
 * checked claims support (a quoted claim, then the page's tier, then the majority), never the longer
 * string ("$2.7 billion" beat Cyera's "$12B" that way). A total and a scope fill what the record lacks.
 */
function mergeMoney(
  into: Pick<
    FeedRecord,
    "valuation_as_written" | "valuation_claims" | "financing_total_as_written" | "financing_total_quote" | "amount_scope"
  >,
  from: Pick<FeedRecord, "valuation_claims" | "financing_total_as_written" | "financing_total_quote" | "amount_scope">,
): Pick<FeedRecord, "valuation_as_written" | "valuation_claims" | "financing_total_as_written" | "financing_total_quote" | "amount_scope"> {
  const claims = appendUnique(into.valuation_claims ?? [], from.valuation_claims ?? [], (a, b) => a.url === b.url && a.value === b.value);
  const hasTotal = Boolean(into.financing_total_as_written);
  return {
    valuation_as_written: pickValuation(claims)?.value ?? into.valuation_as_written,
    ...(claims.length > 0 ? { valuation_claims: claims } : {}),
    financing_total_as_written: hasTotal ? (into.financing_total_as_written ?? null) : (from.financing_total_as_written ?? null),
    financing_total_quote: hasTotal ? (into.financing_total_quote ?? null) : (from.financing_total_quote ?? null),
    amount_scope: into.amount_scope ?? from.amount_scope ?? null,
  };
}

function firstNonNull<T>(a: T | null | undefined, b: T | null | undefined): T | null {
  return a ?? b ?? null;
}

function longer(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

/**
 * A per-item link on the same site (one post on a timeline, one entry in a newsletter) is the
 * source we read. A link off-site is a reference to a page we did not read, so the page stays.
 */
export function itemSource(source: RoundSource, itemUrl: string | null | undefined, companyName?: string | null): RoundSource {
  if (!itemUrl) return source;
  try {
    const u = new URL(itemUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return source;
    if (registrableDomain(u.toString()) !== registrableDomain(source.url)) return source;
    // A per-item link whose slug names another company was bound to the wrong item; the page itself is
    // the source then. A slug with no words (an id) says nothing and is trusted.
    if (companyName && !slugMayName(u.pathname, companyName)) return source;
    return { ...source, url: u.toString(), host: hostOf(u.toString()), title: itemTitle(source, u) };
  } catch {
    return source;
  }
}

/**
 * The title a per-item link carries. An anchor on the page read keeps the page's title, and so does a
 * timeline post (its "@handle on X" label names the account, not a story). A link to another page on
 * the site was never read, so the read page's headline is not its title: traded.co's Snorkel AI deal
 * page listed Basecamp Research's deal, and the Basecamp link was stored under the Snorkel headline.
 * Its slug read as a headline is the title then, or none when the slug has no words.
 */
function itemTitle(source: RoundSource, item: URL): string | undefined {
  let read: URL;
  try {
    read = new URL(source.url);
  } catch {
    return undefined;
  }
  if (read.pathname.replace(/\/+$/, "") === item.pathname.replace(/\/+$/, "")) return source.title;
  if (DEFAULT_TIMELINE_HOSTS.includes(registrableDomain(item.toString()) ?? "")) return source.title;
  const slug = urlSlug(item.toString());
  return slugWords(slug).some((w) => /[a-z]{3,}/i.test(w)) ? humanizeSlug(slug) : undefined;
}

/** Whether a URL path could be about the company: it has no words, or at least half the name's longer tokens appear in it. */
export function slugMayName(pathname: string, companyName: string): boolean {
  if (!/[a-z]{3,}/i.test(pathname)) return true;
  return namesCompany(pathname, companyName, { minTokenLength: 3, prefix: true });
}

/** A source's publish date as YYYY-MM-DD. Search results say "9 hours ago" or give a full timestamp; unparseable text becomes no date. */
function normalizeSource(source: RoundSource, now: Date): RoundSource {
  const published = parseDate(source.published, now);
  return { ...source, published: published ? published.toISOString().slice(0, 10) : undefined };
}

/**
 * Every free-text field through cleanText, so "Not stated." never reaches a record as a value;
 * page furniture off the name, the quote, and the investors; a description that is a use-of-funds
 * clause ("expands into additional international markets") is no description and goes.
 */
const names = (list: string[] | undefined) =>
  (list ?? []).map((n) => stripFurniture(cleanText(n)) ?? "").filter((n) => cleanText(n) !== null);

export function cleanRound(r: ExtractedRound): ExtractedRound {
  const description = cleanText(r.company_description);
  const rawName = cleanHeadlineName(stripFurniture(cleanText(r.company_name)) ?? "");
  const companyName = isGenericCompanyName(rawName) ? "" : firstOfTwoEntities(rawName);
  return {
    ...r,
    company_name: companyName,
    company_website: cleanText(r.company_website),
    company_description: description && isCompanyDescription(description) ? description : null,
    amount_as_written: cleanText(r.amount_as_written),
    valuation_as_written: cleanText(r.valuation_as_written),
    announced_date: cleanText(r.announced_date),
    source_url: cleanText(r.source_url),
    headquarters: cleanText(r.headquarters),
    sector: normalizeSector(cleanText(r.sector)),
    evidence_quote: stripFurniture(r.evidence_quote) ?? "",
    ...investorsFor(r),
  };
}

/**
 * Leads and participants after investor hygiene: leads need lead language in the evidence, placeholders
 * and lenders drop, one firm is one entry. The round's label counts as evidence: Ando's read "pre-seed
 * round led by Accel and seed round led by Index and Emergence" while its quote named no lead, and all
 * three leads were demoted.
 */
function investorsFor(r: ExtractedRound): { lead_investors: string[]; other_investors: string[] } {
  const label = cleanText(r.round_type_as_written);
  const quote = stripFurniture(r.evidence_quote) ?? "";
  const cleaned = cleanInvestors({
    lead_investors: names(r.lead_investors),
    other_investors: names(r.other_investors),
    evidence: [quote, label && hasLeadLanguage(label) ? label : null, ...(r.lead_evidence ?? [])].filter(Boolean).join(". "),
    amount_as_written: cleanText(r.amount_as_written),
  });
  return { lead_investors: cleaned.lead_investors, other_investors: cleaned.other_investors };
}

/** Legacy audit predicate: any round that is not announced used to count as a rumor. */
export function isRumorText(evidenceQuote: string | null | undefined, roundLabel: string | null | undefined): boolean {
  return classifyRoundCertainty(evidenceQuote, roundLabel) !== "announced";
}

/** Where a wire or newspaper dateline ends: the wire's mark, a double dash, a spaced dash, or the date that follows the city. */
const DATELINE_END =
  /\s*(?:,?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|,?\s*\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|\/[A-Za-z-]+\/|\((?:globe newswire|business wire|businesswire|prnewswire|pr newswire|newsfile|accesswire|marketwired|cnw)[^)]*\)|--|\s[\u2013\u2014]\s|\s-\s|:)/i;

/** The dateline's first location, when the quote opens with one. "SAN FRANCISCO, Sept. 2, 2026 /PRNewswire/ --" gives "SAN FRANCISCO". */
export function datelineLocation(evidenceQuote: string | null | undefined): string | null {
  if (!evidenceQuote) return null;
  const quote = evidenceQuote.trim();
  const end = DATELINE_END.exec(quote);
  if (!end || end.index === 0 || end.index > 60) return null;
  const prefix = quote.slice(0, end.index).trim();
  // A location: capitalised words, a comma-separated region at most, nothing that reads as a sentence.
  if (!/^[A-Z][A-Za-z.'’-]*(?:\s+[A-Z][A-Za-z.'’-]*){0,3}(?:,\s*[A-Z][A-Za-z.'’ -]{1,30})?$/.test(prefix)) return null;
  const first = prefix.split(",")[0]?.trim();
  return first ? first : null;
}

const HQ_STATED =
  /\b(?:based in|headquartered in|headquarters in|located in|hq in|hq'd in)\s+([A-Z][A-Za-z.'’ -]+)|\b([A-Z][A-Za-z.'’ -]+?)-based\b/g;

function locationKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Nashville, TN-based Relevance Ventures": a place, an optional region, "-based", and who is based there. */
const BASED_BEFORE = /\b([A-Z][A-Za-z.'’ -]*?)(?:,\s*[A-Z][A-Za-z.]*(?:\s[A-Z][A-Za-z.]*)?)?-based\s+([^,.;()]{1,80})/g;

/**
 * Whether the quote places the headquarters' city on an investor and never on the company: Aqua
 * Medical's release said "a Series B financing led by Nashville, TN-based Relevance Ventures", and
 * the extractor gave the company its lead's city.
 */
function investorsCity(hqCity: string, quote: string, parties: { company: string; investors: string[] }): boolean {
  const names = (list: string[]) => list.map(locationKey).filter(Boolean);
  const [company, investors] = [names([parties.company]), names(parties.investors)];
  const about = (text: string, list: string[]) => {
    const t = locationKey(text);
    return list.some((n) => t.startsWith(n) || n.startsWith(t.split(" ").slice(0, 2).join(" ")));
  };
  let onInvestor = false;
  for (const m of quote.matchAll(BASED_BEFORE)) {
    const place = locationKey(m[1] ?? "");
    if (place !== hqCity && !place.endsWith(` ${hqCity}`)) continue;
    if (about(m[2] ?? "", company)) return false;
    if (about(m[2] ?? "", investors)) onInvestor = true;
  }
  return onInvestor;
}

/**
 * The headquarters to keep: null when it is the dateline's city (the release was issued there,
 * which says nothing about where the company sits) unless the quote also says the company is
 * based there, and null when the quote gives that city to an investor rather than the company.
 * Pure; the extractor's description asks for the same and misses.
 */
export function scrubHeadquarters(
  headquarters: string | null,
  evidenceQuote: string | null | undefined,
  pageDateline?: string | null,
  parties?: { company: string; investors: string[] },
): string | null {
  if (!headquarters) return null;
  const city = locationKey(headquarters.split(",")[0] ?? headquarters);
  if (parties && city && evidenceQuote && investorsCity(city, evidenceQuote, parties)) return null;
  const dateline = datelineLocation(evidenceQuote) ?? pageDateline ?? null;
  if (!dateline) return headquarters;
  const hqCity = locationKey(headquarters.split(",")[0] ?? headquarters);
  if (!hqCity || hqCity !== locationKey(dateline)) return headquarters;
  for (const m of (evidenceQuote ?? "").matchAll(HQ_STATED)) {
    const stated = locationKey(m[1] ?? m[2] ?? "");
    if (stated && (stated.startsWith(hqCity) || hqCity.startsWith(stated))) return headquarters;
  }
  return null;
}

/**
 * A company website is a homepage on the company's own domain: never a page on any of the
 * record's sources (the article, the wire, the newsletter that carried it), never a social or
 * directory host, and never a URL deeper than one path segment (an announcement post, a profile
 * page). Pure; `sourceDomains` are the registrable domains of every source on the record.
 */
export function trustedWebsite(website: string | null | undefined, sourceDomains: Iterable<string | null | undefined>): string | null {
  if (!website) return null;
  const domain = registrableDomain(website);
  if (!domain) return null;
  if (SOCIAL_AND_DIRECTORY_HOSTS.has(domain) || NON_ARTICLE_HOSTS.has(domain)) return null;
  for (const d of sourceDomains) if (d && d === domain) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(website) ? website : `https://${website}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    // A homepage is a host with at most a locale or index segment; a shortlink code ("/pq6y") or a post is not one.
    const segments = u.pathname.split("/").filter(Boolean);
    if (segments.length > 1) return null;
    if (segments.length === 1 && !/^(?:[a-z]{2}(?:-[a-z]{2})?|home|index(?:\.html?)?|en-?us|en-?gb)$/i.test(segments[0])) return null;
    if (u.search) return null;
    if (SHORTENER_HOSTS.has(domain)) return null;
  } catch {
    return null;
  }
  return website;
}

/** Investor names deduped on their identity key; the longer spelling of a firm is the one shown. */
function mergeLists(a: string[], b: string[]): string[] {
  return dedupeInvestorNames([...a, ...b]);
}

function recordId(companyKey: string, stage: Stage, announced: string | null): string {
  return `${companyKey.replace(/\s+/g, "-")}:${stage}:${announced ?? "undated"}`;
}

/**
 * The two windows inside which two readings of one company are one round: 45 days when the
 * stage agrees (the same round reported on different days), 7 days whatever the stage (a
 * roundup's "seed" and a press release's "pre-Series A" are one announcement). `lib/persist.ts`
 * applies the same windows when a record lands on a row already there.
 */
export const SAME_ROUND_WINDOWS = { sameStageDays: 45, crossStageDays: 7 } as const;

/**
 * Whether two readings for one company describe one round. Undated on either side is a match
 * when the stage agrees (the date is what a second source usually supplies) and never a match
 * across stages (there is nothing to anchor the week on).
 */
export function sameRoundWindow(
  a: { stage: string; announced_date: string | null },
  b: { stage: string; announced_date: string | null },
): boolean {
  if (!a.announced_date || !b.announced_date) return a.stage === b.stage;
  const days = Math.abs(new Date(a.announced_date).getTime() - new Date(b.announced_date).getTime()) / 86_400_000;
  return days <= (a.stage === b.stage ? SAME_ROUND_WINDOWS.sameStageDays : SAME_ROUND_WINDOWS.crossStageDays);
}

/** The tally a dropped round lands in; the run summary and the tests read the counts by these names. */
type DropReason = keyof ResolveResult["dropped"];

export function resolveRounds(items: ExtractedItem[], opts: ResolveOptions): ResolveResult {
  const ctx = pageContext(items, opts);
  const dropped: ResolveResult["dropped"] = {
    otherStage: 0,
    notARound: 0,
    background: 0,
    rumor: 0,
    outOfWindow: 0,
    undatedTimeline: 0,
    ungrounded: 0,
    nonArticle: 0,
    unnamed: 0,
    unrelatedSource: 0,
  };
  const rejected: ResolveResult["rejected"] = [];
  // One record per company and stage across the batch; a second reading of the same round merges in.
  const byKey = new Map<string, FeedRecord>();
  const recalled: FeedRecord[] = [];
  for (const item of items) {
    const reading = readItem(item, ctx);
    if (reading === null) continue;
    if (typeof reading === "string") {
      dropped[reading]++;
      if (reading === "notARound") {
        const round = item.round;
        const reason =
          nonStartupIssuerReason(
            issuerTypeFromEvidence(round.company_name, round.issuer_quote ?? null, round.evidence_quote, round.round_type_as_written),
          ) ??
          nonStartupIssuerReason(round.issuer_checked ?? round.issuer_type ?? "unknown") ??
          notAStartupRound(round.round_type_as_written, round.evidence_quote, round.company_name) ??
          notARound(round.round_type_as_written, round.evidence_quote, round.amount_as_written, round.company_name, item.source.title) ??
          "not a startup financing";
        rejected.push({ company_name: round.company_name, source_url: item.source.url, disposition: "rejected", reason });
      }
      continue;
    }
    const fresh = recordFor(reading);
    if (reading.recalled) {
      recalled.push(fresh);
      continue;
    }
    const existing = byKey.get(keyOf(fresh));
    byKey.set(keyOf(fresh), existing ? mergeReading(existing, reading) : fresh);
  }
  const { kept, earlier } = dropEarlierRounds([...byKey.values()], ctx);
  const tiers = { ...DEFAULT_TIERS, ...opts.publisherTiers };
  const settled = mergeAliases(kept).map((r) => settleRecord(r, tiers));
  const placed = placeEarlierRounds(settled, [...earlier, ...recalled], opts.keepEarlierRounds === true, tiers);
  dropped.background += placed.background;
  return { kept: sortForFeed(placed.records), rejected, dropped };
}

/**
 * What every phase reads: the options with their defaults filled, and two tallies over the whole
 * batch that no item can know about itself. On a timeline, one post that names several rounds is a
 * list (a week's or a year's biggest), not an announcement: the extractor tends to stamp such items
 * with the post's date, so the count of rounds per post is the tell, and a listed round counts as
 * undated. The names per post let a neighbour's sentence be recognised as the neighbour's.
 */
interface PageContext {
  opts: ResolveOptions;
  now: Date;
  aliases: Record<string, string>;
  timelineHosts: Set<string>;
  roundsPerPost: Map<string, number>;
  namesPerPost: Map<string, string[]>;
  /** Reading a round the page recalls as history through to a record, past the checks that call it background. */
  recalling?: boolean;
}

function pageContext(items: ExtractedItem[], opts: ResolveOptions): PageContext {
  const roundsPerPost = new Map<string, number>();
  const namesPerPost = new Map<string, string[]>();
  for (const item of items) {
    const src = itemSource(item.source, cleanText(item.round?.source_url)).url;
    roundsPerPost.set(src, (roundsPerPost.get(src) ?? 0) + 1);
    if (item.round?.company_name) namesPerPost.set(src, [...(namesPerPost.get(src) ?? []), item.round.company_name]);
  }
  return {
    opts,
    now: opts.now ?? new Date(),
    aliases: opts.aliases ?? {},
    timelineHosts: new Set(opts.timelineHosts ?? DEFAULT_TIMELINE_HOSTS),
    roundsPerPost,
    namesPerPost,
  };
}

/** One round as one page reports it, with every phase's finding attached: what a record is built from, and what a second reading merges in. */
interface Reading {
  round: ExtractedRound;
  certainty: FeedRecord["certainty"];
  source: RoundSource;
  companyKey: string;
  stage: Stage;
  isExtension: boolean;
  /** The label named no stage; the stage is `other`, `undisclosed`, or growth by its size. */
  stageless: boolean;
  website: string | null;
  headquarters: string | null;
  amount: FeedRecord["amount"];
  valuation: string | null;
  valuationClaim: ValuationClaim | null;
  amountScope: AmountScope | null;
  total: { asWritten: string; quote: string } | null;
  date: Dated;
  /** The page recalls the round as history (the extractor's `is_background`, a past season, the headline's other figure), not as its news. */
  recalled?: boolean;
}

/**
 * The phases in the order they run. The first to find that the round is not this window's news
 * names the tally it lands in, so the order here is the order the counts depend on. Null when there
 * was nothing to read.
 */
function readItem(item: ExtractedItem, ctx: PageContext): Reading | DropReason | null {
  const round = groundRound(item, ctx);
  if (round === null || typeof round === "string") return round;
  const reading = readRound(item, round, ctx);
  if (reading !== "background") return reading;
  // A recalled round is read through like the news, so the later round on its page can carry it
  // (placeEarlierRounds); it still counts as background whatever else would have dropped it.
  const recalled = readRound(item, { ...round, is_background: false }, { ...ctx, recalling: true });
  return typeof recalled === "string" ? "background" : { ...recalled, recalled: true };
}

function readRound(item: ExtractedItem, round: ExtractedRound, ctx: PageContext): Reading | DropReason {
  const sourced = sourceRound(item, round, ctx);
  if (typeof sourced === "string") return sourced;
  const classified = classifyRound(round, ctx.opts, item.listed === true, sourced.source.title ?? null);
  if (typeof classified === "string") return classified;
  const certainty =
    [round.evidence_quote, round.certainty_quote]
      .map(assertedRoundCertainty)
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .reduce<NonNullable<ReturnType<typeof assertedRoundCertainty>> | null>(
        (strongest, value) => (!strongest || ROUND_CERTAINTY_RANK[value] > ROUND_CERTAINTY_RANK[strongest] ? value : strongest),
        null,
      ) ?? classifyRoundCertainty(null, round.round_type_as_written, round.certainty, round.certainty_checked, round.is_rumor);
  if (certainty !== "announced" || round.is_rumor) {
    const tiers = { ...DEFAULT_TIERS, ...ctx.opts.publisherTiers };
    const host = sourced.source.host.replace(/^www\./, "");
    if ((tiers[sourced.source.host] ?? tiers[host] ?? 0.3) < 0.7) return "rumor";
  }
  if (readsAsListing(sourced.source, round)) return "nonArticle";
  const date = dateRound(item, round, sourced, ctx);
  if (typeof date === "string") return date;
  const priced = priceRound(round, sourced, { ...classified, announced: date.announcedIso, named: item.valuation_named === true }, ctx);
  if (typeof priced === "string") return priced;
  const stage = stageForAmount(classified.stage, round.round_type_as_written, priced.amount.usd_millions);
  // A round that names no stage is this preset's when its amount falls in one of the bands it keeps. With
  // no amount there is nothing to place it by, and it goes (see data-quality.md).
  if (classified.stageless && !ctx.opts.stages.includes(stage)) {
    const usd = priced.amount.usd_millions;
    if (usd === null || !stagelessBandsFor(ctx.opts).includes(bandForAmount(usd))) return "otherStage";
  }
  // A website is a homepage off the source's domain; the record-level pass re-checks it against every source.
  const website = trustedWebsite(round.company_website, [registrableDomain(sourced.source.url)]);
  // The page is a source only when it is about this company; the sentence read off it rides along, so
  // the link remembers what placed the company there.
  const source: RoundSource = { ...sourced.source, ...(round.evidence_quote ? { evidence: round.evidence_quote } : {}) };
  const fit = sourceFit(
    source,
    { name: round.company_name, domain: registrableDomain(website) },
    { amountValue: priced.amount.value, amountCurrency: priced.amount.currency },
  );
  if (!fit.attach) return "unrelatedSource";
  const rawKey = normalizeCompanyKey(round.company_name);
  return {
    round,
    certainty,
    source,
    companyKey: ctx.aliases[rawKey] ?? rawKey,
    ...classified,
    stage,
    website,
    // A dateline names where the release was issued, not where the company sits.
    headquarters: scrubHeadquarters(round.headquarters ?? null, round.evidence_quote, item.dateline, {
      company: round.company_name,
      investors: [...round.lead_investors, ...round.other_investors],
    }),
    ...priced,
    date,
  };
}

/**
 * The round as the page states it, or why it is no round of this page's: no evidence in the page's
 * own text, a sentence that is a neighbour's, a name that names no one. Null when the extractor gave
 * no company or no round label: nothing to read, and nothing to count.
 */
function groundRound(item: ExtractedItem, ctx: PageContext): ExtractedRound | DropReason | null {
  if (!item.round?.company_name || !item.round.round_type_as_written) return null;
  // A round the page's own text never states is another article's, read off a sidebar.
  if (item.grounded === false) return "ungrounded";
  const itemUrl = itemSource(item.source, cleanText(item.round.source_url)).url;
  const onListPage = (ctx.roundsPerPost.get(itemUrl) ?? 0) >= 2;
  const round = groundInvestorsOnListPage(cleanRound(item.round), onListPage);
  // On a page that states several rounds, an evidence sentence that names another company on that page
  // and not this one is that company's (a neighbour's sentence filed under this record): it grounds nothing here, and its
  // investors are not this round's. A sentence that names no one ("the company raised") still counts.
  if (
    onListPage &&
    round.company_name &&
    evidenceNamesAnotherCompany(round.evidence_quote, round.company_name, ctx.namesPerPost.get(itemUrl) ?? [])
  ) {
    return "ungrounded";
  }
  // "Valley startup" and "the company" name no one: a paywalled preview, not a record.
  if (!round.company_name) return "unnamed";
  return round;
}

interface Sourced {
  source: RoundSource;
  pageKind: PageKind | null;
  onTimeline: boolean;
  /** A timeline post that names more rounds than an announcement does: a list, whose items count as undated. */
  listedOnTimeline: boolean;
}

/**
 * The source the round is read from, and what kind of page it is. On a timeline every post is its own
 * item and the post URL says nothing about the company; elsewhere a per-item link must be able to
 * name the company or the page itself is the source. A listing, a profile, or an analysis mentions
 * rounds as data or history, never as news, and drops here; a timeline is read post by post and has
 * its own rule in the dating phase.
 */
function sourceRound(item: ExtractedItem, round: ExtractedRound, ctx: PageContext): Sourced | DropReason {
  const pageOnTimeline = ctx.timelineHosts.has(registrableDomain(item.source.url) ?? "");
  const source = normalizeSource(itemSource(item.source, round.source_url, pageOnTimeline ? null : round.company_name), ctx.now);
  const onTimeline = ctx.timelineHosts.has(registrableDomain(source.url) ?? "");
  const listedOnTimeline = onTimeline && (ctx.roundsPerPost.get(source.url) ?? 0) > TIMELINE_LIST_THRESHOLD;
  const pageKind = item.page_kind ?? null;
  if (pageKind && !NEWS_PAGE_KINDS.has(pageKind) && !onTimeline) return "nonArticle";
  return { source, pageKind, onTimeline, listedOnTimeline };
}

/** The bands whose stageless rounds a resolve keeps: the option, or the bands its stages cover. */
function stagelessBandsFor(opts: ResolveOptions): readonly StageBand[] {
  return opts.stagelessBands ?? bandsOf(opts.stages);
}

/**
 * The round's stage, or why it is not news: a stage the feed does not keep, background the extractor
 * flagged, money not yet in the bank, or a stageless reading that is not a round at all (a fund close,
 * a listed company's offering, a buyout, a facility). A stageless round whose band the preset may keep
 * passes here with `stageless` set; its amount decides once it is priced.
 */
function classifyRound(
  round: ExtractedRound,
  opts: ResolveOptions,
  listed = false,
  title: string | null = null,
): { stage: Stage; isExtension: boolean; stageless: boolean } | DropReason {
  const label = round.round_type_as_written;
  const read = classifyStage(label);
  // A bare "extension" ("an insiders' extension") is of the stage its sentence names ("of tldraw's $2.7m seed").
  const extended = read.isExtension && isStageless(read.stage) ? classifyStage(round.evidence_quote ?? "") : null;
  const classified = extended && !isStageless(extended.stage) ? { ...extended, isExtension: true } : read;
  const creditProvider = /\b(?:from|by)\s+[\p{L}\p{N}&.-]+(?:\s+[\p{L}\p{N}&.-]+){0,4}\s+Credit Partners\b/iu.test(round.evidence_quote);
  const stage =
    creditProvider && round.debt_quote && /\b(?:private credit|provides? debt financing)\b/i.test(round.debt_quote)
      ? "debt"
      : classified.stage;
  const labelExtension = classified.isExtension;
  const stageless = isStageless(stage) && !isFormDLabel(label);
  if (
    nonStartupIssuerReason(issuerTypeFromEvidence(round.company_name, round.issuer_quote ?? null, round.evidence_quote, label)) ||
    nonStartupIssuerReason(round.issuer_checked ?? "unknown") ||
    (round.issuer_quote && nonStartupIssuerReason(round.issuer_type ?? "unknown"))
  )
    return "notARound";
  if (
    !opts.stages.includes(stage) &&
    !(stage === "pre_a" && opts.stages.includes("series_a")) &&
    !(stageless && stagelessBandsFor(opts).length > 0)
  )
    return "otherStage";
  if (round.is_background) return "background";
  const kind = safeMoneyKind(
    round.money_kind_quote ?? round.field_quotes?.amount ?? round.evidence_quote,
    round.amount_as_written,
    round.money_kind_checked ?? round.money_kind ?? null,
  );
  // A round labelled as that very kind (a debt round, a grant) is its stage's; under an equity label it is no round.
  if (["secondary", "ipo_allocation", "internal_spending", "debt", "grant"].includes(kind) && kind !== stage) return "notARound";
  if (stageless && (listed || notARound(label, round.evidence_quote, round.amount_as_written, round.company_name, title)))
    return "notARound";
  // A label does not make a listed company's share offering, or a fund, a startup's round.
  if (notAStartupRound(label, round.evidence_quote, round.company_name)) return "notARound";
  return {
    stage,
    isExtension: labelExtension || evidenceSaysExtension(round.evidence_quote) || evidenceSaysExtension(round.extension_quote),
    stageless,
  };
}

/**
 * A directory, a ranking, or a tracker states rounds as data, never as news; so does a page whose
 * evidence for a round is a table row or a verbless data point rather than a sentence, whatever its
 * title says (a trend story's "Xpeng Robotics -- $900M Series A" was a round from a month before it).
 * ... unless the page is a weekly or monthly roundup, whose rows are this period's rounds.
 */
function readsAsListing(source: RoundSource, round: ExtractedRound): boolean {
  const roundupByTitle = WEEKLY_LIST.test(source.title ?? "") || WEEKLY_LIST.test(source.url) || MONTHLY_LIST.test(source.title ?? "");
  const notASentence = isTableRowQuote(round.evidence_quote) || isDataPointQuote(round.evidence_quote);
  return isDirectoryTitle(source.title) || !isArticleUrl(source.url) || (notASentence && !roundupByTitle);
}

interface Dated {
  announcedIso: string | null;
  precision: DatePrecision;
  basis: FeedRecord["date_basis"];
  undated: boolean;
}

/** What the text and the page say about the round's day, before any borrowed date is considered. */
interface StatedDate {
  statedRaw: Date | null;
  /** The stated day once copied bylines are taken off: the round's own date, or null. */
  own: Date | null;
  firstOfMonth: boolean;
  statedByPage: boolean;
  pageDate: Date | null;
  roundupPage: boolean;
}

/**
 * The extractor writes the first of a month for a round the page dates only to that month; that is a
 * month, not a day, unless the sentence itself says the first. An extracted day that is the page's own
 * day, with no day in the sentence, is the byline copied into the record (a republisher's date, a
 * roundup's header, a tracker's "Funding Date"), not a statement about the round. On a roundup it is
 * not a day at all; on an article it is the page's day and may yield to a surer sibling.
 */
function statedDate(item: ExtractedItem, round: ExtractedRound, sourced: Sourced, ctx: PageContext): StatedDate {
  const { source, pageKind, listedOnTimeline } = sourced;
  const statedRaw = listedOnTimeline ? null : parseStatedDate(round.announced_date);
  const firstOfMonth =
    statedRaw !== null && statedRaw.getUTCDate() === 1 && !/\b(?:1st|first|\b1,|\b01\b)/i.test(round.evidence_quote ?? "");
  const pageDate = parseStatedDate(item.page_date);
  const roundupPage = isListPage(source, pageKind, ctx.roundsPerPost.get(source.url) ?? 0) || isRecountPage(source);
  const pageOwnDay = pageDate ?? dateFromUrl(source.url) ?? parseDate(source.published, ctx.now);
  // A company's dated single-story post supplies its actual publication day. A "week of" day in
  // the extracted text is a period marker, not a competing precise announcement day.
  const weekMarker =
    !roundupPage &&
    item.visible_article_date &&
    statedRaw &&
    pageDate &&
    /\bweek of\b/i.test(`${round.evidence_quote} ${round.announced_date ?? ""}`) &&
    (pageDate.getTime() - statedRaw.getTime()) / 86_400_000 >= 0 &&
    (pageDate.getTime() - statedRaw.getTime()) / 86_400_000 <= 6;
  const statedByPage =
    statedRaw !== null &&
    pageOwnDay !== null &&
    Math.abs(statedRaw.getTime() - pageOwnDay.getTime()) <= 86_400_000 &&
    !evidenceStatesDay(round.evidence_quote);
  // A list never states an announcement day: its items' days are the issue's, a column's, or invented
  // (a "169 VCs leading rounds" listicle gave each round a day). The list's day is an upper bound.
  const own = firstOfMonth || roundupPage || weekMarker ? null : statedRaw;
  return { statedRaw, own, firstOfMonth, statedByPage, pageDate, roundupPage };
}

/** The rungs of the date ladder, each null when a surer rung above it answered. */
interface DateRungs {
  own: Date | null;
  byWeekday: Date | null;
  monthOnly: Date | null;
  pageDate: Date | null;
  fromUrl: Date | null;
  fromResult: Date | null;
}

/** A weekday or "today" resolved against the page's date is the page's day, as is a copied byline. */
function basisFor(rungs: DateRungs, statedByPage: boolean): FeedRecord["date_basis"] {
  if (rungs.own || rungs.byWeekday) return statedByPage || !rungs.own ? "page" : "stated";
  if (rungs.monthOnly || rungs.pageDate) return "page";
  if (rungs.fromUrl) return "url";
  if (rungs.fromResult) return "result";
  return "none";
}

/**
 * A round's own stated date is a day. A date borrowed from the page is a day on an article and a
 * week on a roundup or newsletter (the announcement fell inside the period the page covers),
 * or a month when the page is a monthly list.
 */
function precisionFor(rungs: DateRungs, announced: Date | null, roundupPage: boolean, monthlyTitle: boolean): DatePrecision {
  if (rungs.own || rungs.byWeekday) return "day";
  if (announced === null) return "unknown";
  if (rungs.monthOnly) return "month";
  if (roundupPage) return monthlyTitle ? "month" : "week";
  return "day";
}

/**
 * Date, in order of truth: the round's own date as the text states it, the date the page says it was
 * published, a date in the URL, and last the search result's publish date. Never the run's clock: a
 * stated date with no year or a relative phrase parses to nothing. Then the window, in the order the
 * tallies depend on: an undated post on a timeline, a stale page, a past period in the sentence, and
 * a date outside the window each stop the round here.
 */
function dateRound(item: ExtractedItem, round: ExtractedRound, sourced: Sourced, ctx: PageContext): Dated | DropReason {
  const { source, onTimeline } = sourced;
  const { statedRaw, own, firstOfMonth, statedByPage, pageDate, roundupPage } = statedDate(item, round, sourced, ctx);
  // A social post (an Instagram repost, a LinkedIn or Facebook post) carries no date of its own that a
  // reader can trust: only a day its text states dates the round.
  const socialPost = SOCIAL_POST_HOSTS.has(registrableDomain(source.url) ?? "");
  const pageDay = socialPost ? null : pageDate;
  const byWeekday = own || roundupPage || socialPost ? null : dateFromWeekday(round.evidence_quote, pageDay);
  const fromUrl = own || byWeekday || socialPost ? null : dateFromUrl(source.url);
  // A search result's day is the last rung, and never the run's own day: an evergreen page, an index, or
  // a repost with no date of its own that a search engine calls fresh is undated, not dated to its crawl.
  const resultDay = own || byWeekday || pageDay || fromUrl || socialPost ? null : parseDate(source.published, ctx.now);
  const fromResult = resultDay && ctx.now.getTime() - resultDay.getTime() > CLOCK_SLACK_MS ? resultDay : null;
  // A monthly list is dated to the month it names ("The Complete July 2026 Startup Funding Roundup" is
  // July), so a June list read in July does not enter July; otherwise the first-of-month stamp stands
  // as the month it points at.
  const monthlyTitle = MONTHLY_LIST.test(source.title ?? "");
  const listMonth = roundupPage || monthlyTitle ? monthNamedIn(source.title ?? "") : null;
  const monthOnly = listMonth ?? (firstOfMonth ? statedRaw : null);
  const rungs: DateRungs = { own, byWeekday, monthOnly, pageDate: pageDay, fromUrl, fromResult };
  const announced = own ?? byWeekday ?? monthOnly ?? pageDay ?? fromUrl ?? fromResult;
  const precision = precisionFor(rungs, announced, roundupPage, monthlyTitle);
  const undated = announced === null;

  if (!own && onTimeline && !firstOfMonth) return "undatedTimeline";
  // A page published well before the window describes a round from then, whatever day another rung
  // finds: a March article once put a March round into August.
  const publishedAt = parseDate(source.published, ctx.now);
  if (publishedAt && publishedAt.getTime() < ctx.opts.windowStart.getTime() - STALE_PAGE_GRACE_MS) return "outOfWindow";
  // A profile or a follow-on story places the round in a past season or month: history, not news.
  if (!own && !ctx.recalling && mentionsPastPeriod(round.evidence_quote, ctx.opts.windowStart)) return "background";
  // A month-dated round gets no grace at the window's edge: a June list read in July is June.
  const monthBeforeWindow = precision === "month" && announced !== null && announced.getTime() < ctx.opts.windowStart.getTime();
  if (!undated && (monthBeforeWindow || !withinWindow(announced, ctx.opts.windowStart, ctx.now, ctx.opts.windowEnd))) return "outOfWindow";
  return {
    announcedIso: announced ? announced.toISOString().slice(0, 10) : null,
    precision,
    basis: basisFor(rungs, statedByPage),
    undated,
  };
}

interface Priced {
  amount: FeedRecord["amount"];
  valuation: string | null;
  valuationClaim: ValuationClaim | null;
  amountScope: AmountScope | null;
  total: { asWritten: string; quote: string } | null;
}

/** A total whose sentence composes one financing announced now ("comprising a $375 million Series C and a $500 million Series C-1"). */
const ANNOUNCED_TOGETHER =
  /\b(?:compris(?:ing|es|ed)|consist(?:ing|s) of|split (?:into|between|across)|made up of|in (?:two|three|four) tranches|across (?:two|three|four) tranches|including (?:a|an) [$€£])/i;
/** A total whose sentence counts money raised before: a running total, never the round's new money. */
const RUNNING_TOTAL =
  /\b(?:bring(?:s|ing)?|brought|total(?:s|ling|ing)? (?:raised|funding|capital)|to date|so far|cumulative|in total|to a total)\b/i;

/**
 * Money: only a round amount becomes the record's amount. Totals and valuations are kept as text.
 * Text the parser cannot read as money ("$9,094", "seven figures") is not shown as an amount either.
 * The page's own headline states what it reports; a round far from that amount on a single-story
 * page is history the extractor did not flag.
 */
function priceRound(
  round: ExtractedRound,
  sourced: Sourced,
  classified: { stage: Stage; isExtension: boolean; announced: string | null; named?: boolean },
  ctx: PageContext,
): Priced | DropReason {
  const { source, pageKind } = sourced;
  const kind = safeMoneyKind(
    round.money_kind_quote ?? round.field_quotes?.amount ?? round.evidence_quote,
    round.amount_as_written,
    round.money_kind_checked ?? round.money_kind ?? null,
  );
  const isExtension = classified.isExtension;
  // A total the page states beside the new money, with its own sentence (settleOnPage checked it is on the page).
  const total =
    round.financing_total_as_written &&
    round.financing_total_quote &&
    amountInEvidence(round.financing_total_as_written, round.financing_total_quote)
      ? { asWritten: round.financing_total_as_written, quote: round.financing_total_quote }
      : null;
  // New money is published when both are stated. One financing announced now in tranches is all new
  // money (Positron's $875 million Series C and C-1, not its $375 million first tranche); a running total
  // counts money raised before and is never the amount (FORE's $110 million Series D-2 beside its $67.4 million).
  const together =
    kind !== "combined" &&
    total !== null &&
    (round.amount_scope === "tranche" || round.amount_scope === "financing_total") &&
    ANNOUNCED_TOGETHER.test(total.quote) &&
    !RUNNING_TOTAL.test(total.quote);
  const newMoney =
    total !== null && !together && round.amount_as_written !== null && !amountInEvidence(round.amount_as_written, total.asWritten);
  const amountAsWritten = together ? total.asWritten : round.amount_as_written;
  const amountQuote = together ? total.quote : round.evidence_quote;
  const isRoundAmount =
    round.amount_kind === "round" &&
    !["combined", "mixed", "cumulative", "future_commitment", "secondary", "ipo_allocation", "internal_spending", "debt", "grant"].includes(
      kind,
    ) &&
    !(isExtension && !newMoney && !together && amountIsRoundTotal(round.evidence_quote)) &&
    amountInEvidence(amountAsWritten, amountQuote);
  const parsed = isRoundAmount
    ? dollarFromEvidence(amountAsWritten, parseAmount(amountAsWritten), amountQuote)
    : { value: null, currency: null };
  const amountText = isRoundAmount && parsed.value !== null ? (amountAsWritten ?? null) : null;
  const sideFinancing =
    round.debt_quote && /\b(?:debt|credit|growth financing|revenue-based|non-dilutive)\b/i.test(round.debt_quote)
      ? parseAmount(round.debt_quote)
      : null;
  if (
    !ctx.recalling &&
    backgroundByPageShape({
      title: source.title,
      roundsOnPage: ctx.roundsPerPost.get(source.url) ?? 1,
      amountValue: parsed.value,
      amountCurrency: parsed.currency,
      pageKind,
      additionalFinancing:
        sideFinancing?.value === null || !sideFinancing ? null : { value: sideFinancing.value, currency: sideFinancing.currency },
    })
  ) {
    return "background";
  }
  const usd = convertToUsd(parsed.value, parsed.currency, ctx.opts.rates ?? null, amountText);
  // A valuation is this round's only with its own sentence, checked against the round (valuation.ts).
  // An amount the extractor filed as a valuation is not one: only valuation_as_written is.
  const supported =
    round.valuation_as_written &&
    valuationSupport(round.valuation_as_written, round.valuation_quote ?? null, {
      company: round.company_name,
      stage: classified.stage,
      amount: parsed.value,
      announced: classified.announced,
      total: parseAmount(total?.asWritten ?? null).value,
      named: classified.named,
    }) === null
      ? withBasis(round.valuation_as_written, round.valuation_quote)
      : null;
  const tiers = { ...DEFAULT_TIERS, ...ctx.opts.publisherTiers };
  return {
    amount: { value: parsed.value, currency: parsed.currency, as_written: amountText, ...usd },
    valuation: supported,
    valuationClaim: supported
      ? {
          value: supported,
          quote: round.valuation_quote ?? null,
          url: source.url,
          tier: tiers[source.host] ?? tiers[source.host.replace(/^www\./, "")] ?? 0.3,
        }
      : null,
    amountScope: together
      ? "financing_total"
      : kind === "mixed"
        ? (mixedFinancingScope(total?.quote ?? round.evidence_quote) ?? "includes_secondary")
        : kind === "combined"
          ? "combined_rounds"
          : kind === "cumulative"
            ? "cumulative"
            : (round.amount_scope ?? null),
    total: together
      ? null
      : (total ??
        (["combined", "mixed", "cumulative"].includes(kind) &&
        round.amount_as_written &&
        amountInEvidence(round.amount_as_written, round.evidence_quote)
          ? { asWritten: round.amount_as_written, quote: round.evidence_quote }
          : null)),
  };
}

/** The record a first reading of a round becomes. */
function recordFor(reading: Reading): FeedRecord {
  const { round, source, companyKey, stage, date } = reading;
  return {
    id: recordId(companyKey, stage, date.announcedIso),
    company_key: companyKey,
    company_name: round.company_name,
    company_domain: registrableDomain(reading.website),
    company_website: reading.website,
    company_description: round.company_description ?? null,
    stage,
    certainty: reading.certainty,
    stage_as_written: round.round_type_as_written,
    is_extension: reading.isExtension,
    amount: reading.amount,
    ...(reading.amountScope ? { amount_scope: reading.amountScope } : {}),
    ...(reading.total ? { financing_total_as_written: reading.total.asWritten, financing_total_quote: reading.total.quote } : {}),
    ...(safeMoneyKind(
      round.money_kind_quote ?? round.evidence_quote,
      round.amount_as_written,
      round.money_kind_checked ?? round.money_kind ?? null,
    ) === "combined"
      ? {
          financing_stages: [
            ...new Set(
              [round.round_type_as_written, round.evidence_quote]
                .flatMap((text) =>
                  [...text.matchAll(/\b(?:pre[ -]?seed|seed|series\s+[a-z](?:[+-]\d+)?)\b/gi)].map((m) => classifyStage(m[0]).stage),
                )
                .filter((stage) => stage !== "other"),
            ),
          ],
        }
      : {}),
    valuation_as_written: reading.valuation,
    ...(reading.valuationClaim ? { valuation_claims: [reading.valuationClaim] } : {}),
    lead_investors: mergeLists([], round.lead_investors ?? []),
    other_investors: mergeLists([], round.other_investors ?? []),
    announced_date: date.announcedIso,
    date_precision: date.precision,
    date_basis: date.basis,
    headquarters: reading.headquarters,
    sector: round.sector ?? null,
    evidence_quotes: roundEvidence(round),
    sources: [source],
    confidence: 0,
    status: "new",
    undated: date.undated,
  };
}

/**
 * A second reading of a round already on the page's record: the record with what the reading adds. The
 * first reading's name and date stand unless the record had no date; a field the record lacks is taken,
 * and a longer description, valuation, headquarters, or sector replaces a shorter one.
 */
function mergeReading(existing: FeedRecord, reading: Reading): FeedRecord {
  const { round, date } = reading;
  const dated = existing.undated && date.announcedIso !== null;
  const domain = registrableDomain(reading.source.url);
  const earlier =
    !existing.undated &&
    existing.date_precision === "day" &&
    date.precision === "day" &&
    date.announcedIso &&
    existing.announced_date &&
    date.announcedIso < existing.announced_date &&
    !isListPage(reading.source) &&
    domain &&
    (domain === existing.company_domain || RELEASE_HOSTS.has(domain) || (DEFAULT_TIERS[domain] ?? 0) >= 0.7) &&
    date.basis !== "result";
  const ownHost = existing.company_domain;
  const incomingOwnRelease = ownHost !== null && reading.source.host === ownHost && round.lead_investors.length > 0;
  const existingOwnRelease = ownHost !== null && existing.sources.some((s) => s.host === ownHost) && existing.lead_investors.length > 0;
  return {
    ...existing,
    certainty: strongerCertainty(existing.certainty, reading.certainty),
    company_website: firstNonNull(existing.company_website, reading.website),
    company_domain: firstNonNull(existing.company_domain, registrableDomain(reading.website)),
    company_description: longer(existing.company_description, round.company_description ?? null),
    amount: existing.amount.value === null && reading.amount.value !== null ? reading.amount : existing.amount,
    ...mergeMoney(existing, {
      valuation_claims: reading.valuationClaim ? [reading.valuationClaim] : [],
      financing_total_as_written: reading.total?.asWritten ?? null,
      financing_total_quote: reading.total?.quote ?? null,
      amount_scope: reading.amountScope,
    }),
    financing_stages: [
      ...new Set([
        ...(existing.financing_stages ?? []),
        ...(safeMoneyKind(
          round.money_kind_quote ?? round.evidence_quote,
          round.amount_as_written,
          round.money_kind_checked ?? round.money_kind ?? null,
        ) === "combined"
          ? [...round.evidence_quote.matchAll(/\b(?:pre[ -]?seed|seed|series\s+[a-z](?:[+-]\d+)?)\b/gi)].map(
              (m) => classifyStage(m[0]).stage,
            )
          : []),
      ]),
    ],
    lead_investors: incomingOwnRelease
      ? round.lead_investors
      : existingOwnRelease
        ? existing.lead_investors
        : mergeLists(existing.lead_investors, round.lead_investors ?? []),
    other_investors: mergeLists(existing.other_investors, [
      ...round.other_investors,
      ...(incomingOwnRelease ? existing.lead_investors : []),
    ]),
    headquarters: longer(existing.headquarters, reading.headquarters),
    sector: longer(existing.sector, round.sector ?? null),
    is_extension: existing.is_extension || reading.isExtension,
    evidence_quotes: appendUnique(existing.evidence_quotes, roundEvidence(round), (a, b) => a === b),
    sources: appendUnique(existing.sources, [reading.source], (a, b) => a.url === b.url),
    ...(dated || earlier
      ? { announced_date: date.announcedIso, undated: false, id: recordId(reading.companyKey, reading.stage, date.announcedIso) }
      : {}),
    ...(earlier ? { date_basis: date.basis } : {}),
  };
}

/**
 * The sentences a reading carries: the round's own, then the page's sentence about debt announced beside
 * it, so a record whose amount is the equity keeps the debt in view ("It also includes $30 million in
 * debt and equipment financing") without counting it.
 */
function roundEvidence(round: ExtractedRound): string[] {
  const out = round.evidence_quote ? [round.evidence_quote] : [];
  const debt = cleanText(round.debt_quote ?? null);
  if (debt && debt !== round.evidence_quote) out.push(debt);
  return out;
}

/** `extra` appended to `list`, skipping what `list` already holds or an earlier addition brought in. */
function appendUnique<T>(list: T[], extra: T[], same: (a: T, b: T) => boolean): T[] {
  const out = [...list];
  for (const x of extra) if (!out.some((y) => same(x, y))) out.push(x);
  return out;
}

/**
 * One company, two equity rounds, one single-story page: the page announces the later one and
 * recalls the earlier as history ("the company raised a $3.3M seed; it had raised a $1.3M pre-seed
 * a year before"). The earlier stage drops as background. Roundups and timelines list many
 * rounds by design and are exempt.
 */
function dropEarlierRounds(records: FeedRecord[], ctx: PageContext): { kept: FeedRecord[]; earlier: FeedRecord[] } {
  const earlier = new Set(earlierRoundsOnOnePage(records, ctx.roundsPerPost, ctx.timelineHosts));
  return { kept: records.filter((r) => !earlier.has(keyOf(r))), earlier: records.filter((r) => earlier.has(keyOf(r))) };
}

/** The page says the company just came out of stealth: the rounds it states are being disclosed, not recalled. */
const STEALTH_LAUNCH = /\b(?:out of|from|in) stealth\b/i;

/**
 * An earlier equity round a stealth launch discloses beside the later round the page announces
 * (Parallax's $42M seed with its $75M Series A, "$117M to date"): the page is the only announcement
 * the seed will get. The history lane keeps it as a record, dated by the page; every other lane rides
 * it on the later record as a prior round for the history ledger (lib/persist.ts), never as news.
 * An earlier round the page merely recalls (a day of its own before the page's, or no stealth launch
 * said) had an announcement of its own and stays background, as does one with no later round beside it.
 */
function placeEarlierRounds(
  records: FeedRecord[],
  earlier: FeedRecord[],
  keep: boolean,
  tiers: Record<string, number>,
): { records: FeedRecord[]; background: number } {
  const out = [...records];
  let background = 0;
  for (const e of earlier) {
    const page = e.sources[0]?.url;
    const rung = EQUITY_ORDER[e.stage];
    const at =
      page === undefined || rung === undefined
        ? -1
        : out.findIndex(
            (r) => r.company_key === e.company_key && (EQUITY_ORDER[r.stage] ?? -1) > rung && r.sources.some((s) => s.url === page),
          );
    const later = out[at];
    const said = later
      ? [
          ...later.sources.filter((s) => s.url === page).map((s) => s.title ?? ""),
          ...later.evidence_quotes,
          later.financing_total_quote ?? "",
          ...e.evidence_quotes,
        ]
      : [];
    if (
      !later ||
      !said.some((text) => STEALTH_LAUNCH.test(text)) ||
      (e.date_basis === "stated" && e.announced_date !== later.announced_date)
    ) {
      background++;
      continue;
    }
    if (keep) {
      out.push(settleRecord(e, tiers));
      continue;
    }
    background++;
    const prior = {
      stage_as_written: e.stage_as_written,
      amount_as_written: e.amount.as_written,
      // A day only the round's own sentence states; the page's day is the later round's.
      announced_date: e.date_basis === "stated" ? e.announced_date : null,
      lead_investors: e.lead_investors,
      source_url: page,
    };
    out[at] = { ...later, earlier_rounds: [...(later.earlier_rounds ?? []), prior] };
  }
  return { records: out, background };
}

/** Once every reading is in: the website against every source, the surest date among them, one set of firms, then the score. */
function settleRecord(record: FeedRecord, tiers: Record<string, number>): FeedRecord {
  const dated = settleDate(scrubWebsite(record));
  const reconciled = { ...dated, ...reconcileInvestorLists(dated.lead_investors, dated.other_investors) };
  return { ...reconciled, confidence: scoreConfidence(reconciled, tiers) };
}

/** By stage, then the largest round first: the order the feed shows. */
function sortForFeed(records: FeedRecord[]): FeedRecord[] {
  return [...records].sort((a, b) => {
    if (a.stage !== b.stage) return a.stage.localeCompare(b.stage);
    return (b.amount.usd_millions ?? b.amount.value ?? -1) - (a.amount.usd_millions ?? a.amount.value ?? -1);
  });
}

/**
 * The record's website against every source it carries: a homepage on a publisher's domain is
 * that publisher's page (a website the search guessed was the article that reported the round), however
 * the sources arrived. The domain follows the website. Returns the record with the website it keeps.
 */
function scrubWebsite(record: FeedRecord): FeedRecord {
  const website =
    trustedWebsite(
      record.company_website,
      record.sources.map((s) => registrableDomain(s.url)),
    ) ?? ownSiteAmongSources(record);
  if (website === record.company_website) return record;
  return { ...record, company_website: website, company_domain: registrableDomain(website) };
}

/**
 * A source on the company's own host is the website the record was missing: the press release on
 * acme.ai is Acme's site. The host's first label must be the company key with spaces removed, or
 * its first token when the key is more than one word.
 */
export function ownSiteAmongSources(record: Pick<FeedRecord, "company_key" | "sources">): string | null {
  const key = record.company_key.replace(/\s+/g, "");
  const first = record.company_key.split(" ")[0] ?? "";
  if (key.length < 3) return null;
  for (const s of record.sources) {
    const domain = registrableDomain(s.url);
    if (!domain || SOCIAL_AND_DIRECTORY_HOSTS.has(domain)) continue;
    const label = domain.split(".")[0] ?? "";
    if (label === key || (first.length >= 4 && label === first)) return `https://${domain}`;
  }
  return null;
}

/**
 * Second pass: the same company under two names ("REGENT" and "Regent Craft").
 * Two records with the same stage merge when one name's tokens are a subset of
 * the other's, or they share a registrable domain, and the amounts agree
 * (within 15%, or one is missing). Single short tokens need the domain to agree.
 */
function mergeAliases(records: FeedRecord[]): FeedRecord[] {
  const out: FeedRecord[] = [];
  for (const rec of records) {
    const at = out.findIndex((o) => o.stage === rec.stage && isAlias(o, rec));
    if (at === -1) out.push(rec);
    else out[at] = absorb(out[at], rec);
  }
  return out;
}

export function isAlias(a: FeedRecord, b: FeedRecord): boolean {
  if (a.company_domain && b.company_domain && a.company_domain !== b.company_domain) return false;
  const sameDomain = Boolean(a.company_domain && b.company_domain && a.company_domain === b.company_domain);
  const linkedSite = Boolean(
    (a.company_domain && b.sources.some((source) => registrableDomain(source.url) === a.company_domain)) ||
      (b.company_domain && a.sources.some((source) => registrableDomain(source.url) === b.company_domain)),
  );
  const sameHq = Boolean(a.headquarters && b.headquarters && normalizeCompanyKey(a.headquarters) === normalizeCompanyKey(b.headquarters));
  const words = (description: string) =>
    new Set(
      normalizeCompanyKey(description)
        .split(" ")
        .filter((word) => word.length > 4),
    );
  const bWords = words(b.company_description ?? "");
  const description =
    a.company_description && b.company_description
      ? [...words(a.company_description)].filter((word) => bWords.has(word)).length >= 2
      : false;
  if (!sameDomain && !linkedSite && !sameHq && !description) return false;
  const ta = new Set(a.company_key.split(" ").filter(Boolean));
  const tb = new Set(b.company_key.split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return false;
  const subset = [...ta].every((t) => tb.has(t)) || [...tb].every((t) => ta.has(t));
  const shortSingle = (ta.size === 1 && [...ta][0].length <= 5) || (tb.size === 1 && [...tb][0].length <= 5);
  if (!sameDomain && (!subset || shortSingle)) return false;
  const x = a.amount.value;
  const y = b.amount.value;
  if (x === null || y === null) return true;
  if (a.amount.currency && b.amount.currency && a.amount.currency !== b.amount.currency) return sameDomain;
  return Math.abs(x - y) <= 0.15 * Math.max(x, y);
}

/** True when `from` knows the date better than `into` does. */
export function surerDate(
  into: Pick<FeedRecord, "undated" | "date_precision">,
  from: Pick<FeedRecord, "undated" | "date_precision">,
): boolean {
  if (from.undated) return false;
  if (into.undated) return true;
  return DATE_PRECISION_RANK[from.date_precision] > DATE_PRECISION_RANK[into.date_precision];
}

/**
 * Leads and participants as one set of firms: a firm on both lists under two spellings ("Carlyle-managed
 * funds" as a lead, "Carlyle Group" as a participant) is one lead. Runs after every merge.
 */
export function reconcileInvestorLists(leads: string[], others: string[]): { lead_investors: string[]; other_investors: string[] } {
  const all = dedupeInvestorNames([...leads, ...others]);
  const leadsAlone = dedupeInvestorNames(leads);
  // A survivor is a lead when it is a lead spelling, or when adding it to the leads folds into one of them.
  const lead_investors = all.filter((n) => leadsAlone.includes(n) || dedupeInvestorNames([...leads, n]).length === leadsAlone.length);
  const leadSet = new Set(lead_investors);
  return { lead_investors, other_investors: all.filter((n) => !leadSet.has(n)) };
}

/** The record `into` with what its alias `from` adds; the longer name wins, a date fills an undated record. Neither input changes. */
function absorb(into: FeedRecord, from: FeedRecord): FeedRecord {
  const dated = into.undated && !from.undated;
  return {
    ...into,
    certainty: strongerCertainty(into.certainty, from.certainty),
    company_name: from.company_name.length > into.company_name.length ? from.company_name : into.company_name,
    company_website: firstNonNull(into.company_website, from.company_website),
    company_domain: firstNonNull(into.company_domain, from.company_domain),
    company_description: longer(into.company_description, from.company_description),
    amount: into.amount.value === null && from.amount.value !== null ? from.amount : into.amount,
    ...mergeMoney(into, from),
    lead_investors: mergeLists(into.lead_investors, from.lead_investors),
    other_investors: mergeLists(into.other_investors, from.other_investors),
    headquarters: longer(into.headquarters, from.headquarters),
    sector: longer(into.sector, from.sector),
    is_extension: into.is_extension || from.is_extension,
    evidence_quotes: appendUnique(into.evidence_quotes, from.evidence_quotes, (a, b) => a === b),
    sources: appendUnique(into.sources, from.sources, (a, b) => a.url === b.url),
    ...(dated
      ? { announced_date: from.announced_date, undated: false, id: recordId(into.company_key, into.stage, from.announced_date) }
      : {}),
  };
}

function strongerCertainty(a: FeedRecord["certainty"], b: FeedRecord["certainty"]): FeedRecord["certainty"] {
  return ROUND_CERTAINTY_RANK[a ?? "announced"] >= ROUND_CERTAINTY_RANK[b ?? "announced"] ? (a ?? "announced") : b;
}

/**
 * confidence = 0.15 sources + 0.25 dated + 0.30 agreement + 0.20 tier + 0.10 evidence.
 * Publish at >= 0.75, flag between 0.50 and 0.75, review below 0.50.
 */
export function scoreConfidence(r: FeedRecord, tiers: Record<string, number>): number {
  const hosts = new Set(r.sources.map((s) => s.host || hostOf(s.url)));
  const sources = Math.min(hosts.size, 3) / 3;
  const dated = r.undated ? 0 : r.date_precision === "day" ? 1 : r.date_precision === "week" ? 0.85 : 0.7;
  // Agreement: with one source we cannot check, so 0.5; with many, reward having amount, stage, and a lead.
  const fields = [r.amount.value !== null, r.stage !== "other", r.lead_investors.length > 0];
  const agreement = hosts.size <= 1 ? 0.5 : fields.filter(Boolean).length / fields.length;
  const tier = Math.max(...[...hosts].map((h) => tiers[h] ?? 0.3), 0);
  const evidence = r.evidence_quotes.some((q) => r.amount.as_written && q.includes(r.amount.as_written.split(" ")[0]))
    ? 1
    : r.evidence_quotes.length > 0
      ? 0.5
      : 0;
  const score = 0.15 * sources + 0.25 * dated + 0.3 * agreement + 0.2 * tier + 0.1 * evidence;
  return Math.round(score * 100) / 100;
}

export function splitByDisposition(records: FeedRecord[]): { publish: FeedRecord[]; flagged: FeedRecord[]; review: FeedRecord[] } {
  const publish: FeedRecord[] = [];
  const flagged: FeedRecord[] = [];
  const review: FeedRecord[] = [];
  for (const r of records) {
    if (r.undated || r.confidence < 0.5) review.push(r);
    else if (r.confidence < 0.75) flagged.push(r);
    else publish.push(r);
  }
  return { publish, flagged, review };
}
