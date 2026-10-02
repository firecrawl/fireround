// Pure normalization rules. Every function here is deterministic and covered by
// normalize.test.ts; the golden-week eval runs over them too.

import * as chrono from "chrono-node";
import { getDomain } from "tldts";
import { normalizeCompanyKey } from "./keys.ts";
import type { Stage } from "./schema.ts";

export { normalizeCompanyKey, normalizeInvestorKey } from "./keys.ts";

const PLACEHOLDER =
  /^(not\s+(stated|specified|mentioned|provided|available|disclosed|given|known)|unknown|undisclosed|unspecified|n\/?a|none|null|nil|tbd|-+|—)\.?$/i;

/** Extraction models answer "Not stated." where the schema asked for null. Free text passes through this; a placeholder becomes null. */
export function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = value.trim();
  if (!s || PLACEHOLDER.test(s)) return null;
  return s;
}

export interface NamesCompanyOptions {
  /** Tokens of the name shorter than this do not count: "and", "the", "co" name nobody. Default 1, every token counts. */
  minTokenLength?: number;
  /**
   * Whether a text word that begins with a name token, or a name token that begins with a text word of
   * four or more letters, counts as the token. Slugs and sentences truncate and inflect ("thyme" for
   * "thymecare", "robotic" for "robotics"); a title or a headline writes the name out. Default false.
   */
  prefix?: boolean;
  /**
   * The share of the name's counted tokens the text must carry, 0 to 1. Half is enough for a sentence or
   * a slug, which shorten a name to its first word; a title must carry the whole name. Default 0.5.
   */
  share?: number;
}

/**
 * Whether a text names the company. Both sides normalize as company keys, so case, punctuation, and
 * corporate suffixes drop out; then enough of the name's tokens must appear among the text's words. A
 * name with no token long enough to count ("AI", "Go") is named only as the whole phrase, since one
 * short word inside another is not the company.
 */
export function namesCompany(text: string | null | undefined, name: string, opts: NamesCompanyOptions = {}): boolean {
  const key = normalizeCompanyKey(name);
  const body = normalizeCompanyKey(text ?? "");
  if (!key || !body) return false;
  const tokens = key.split(" ").filter((t) => t.length >= (opts.minTokenLength ?? 1));
  if (tokens.length === 0) return ` ${body} `.includes(` ${key} `);
  const words = body.split(" ");
  const present = new Set(words);
  const hit = (t: string) =>
    present.has(t) || (opts.prefix === true && words.some((w) => w.startsWith(t) || (t.startsWith(w) && w.length >= 4)));
  return tokens.filter(hit).length >= (opts.share ?? 0.5) * tokens.length;
}

export interface StageClassification {
  stage: Stage;
  isExtension: boolean;
}

/** Map a free-text round label onto the stage enum. "Series A extension" is series_a with isExtension. */
export function classifyStage(label: string): StageClassification {
  const t = label.toLowerCase().replace(/\s+/g, " ").trim();
  const isExtension =
    /\b(extension|ext\.?|top[\s-]?up)\b|\b(?:additional|follow[ -]?on)\s+investment\s+(?:in|into|of)\s+(?:the\s+)?(?:seed|series\s+[a-z])\b/.test(
      t,
    );
  const done = (stage: Stage): StageClassification => ({ stage, isExtension });

  // A Form D says what was sold (equity, debt, options), never which round it was: the filing has
  // no stage field, and a security description like "Series B Preferred" names a share class that
  // only sometimes matches the round's name. STAGES has no "unknown venture" value, so the honest
  // stage is `other`, decided here before the series rule can read a share class as a round. The
  // label stays on the record as stage_as_written, so the reader sees "Form D (equity)".
  if (/\bform d\b/.test(t)) return /\b(?:safe|simple agreement for future equity)\b/.test(t) ? done("convertible") : done("other");

  if (/\bpre[\s-]*seed\b/.test(t) || /\bangel\b/.test(t)) return done("pre_seed");
  if (/\bpre[\s-]*a\b/.test(t)) return done("pre_a");
  // "Pre-Series A" is the bridge between seed and A, not a pre-seed.
  if (/\bpre[\s-]*series\b/.test(t)) return done("bridge");
  if (/\bseed\b/.test(t)) return done("seed");
  if (/\bbridge\b/.test(t)) return done("bridge");
  if (/\b(debt|venture debt|credit facility|growth capital facility|multi[ -]year facility|loan)\b/.test(t)) return done("debt");
  if (/\bgrant\b/.test(t)) return done("grant");
  if (/\b(convertible|safe(?:\s+note)?|simple agreement for future equity|note)\b/.test(t)) return done("convertible");
  if (/\bsecondary\b/.test(t)) return done("secondary");
  if (/\bundisclosed\b/.test(t)) return done("undisclosed");

  // "Série A" and "Serie B" are the French, Spanish, and Italian for a lettered round.
  const m = /\bs[eé]ries?[\s-]*([a-z])(?:\d|\b)/.exec(t);
  if (m) {
    const letter = m[1];
    if (letter === "a") return done("series_a");
    if (letter === "b") return done("series_b");
    if (letter === "c") return done("series_c");
    if (letter >= "d" && letter <= "j") return done("series_d_plus");
  }
  if (/\b(growth|late[\s-]stage|pre[\s-]ipo|mezzanine)\b/.test(t)) return done("growth");
  return done("other");
}

/** An unlabelled round at least this large is a growth round. */
export const GROWTH_ROUND_USD_MILLIONS = 500;

/**
 * The stage once the amount is known. A page that calls a round only a "funding round" or "new
 * financing" gives the classifier nothing, but a round of half a billion dollars or more with no
 * letter is a late-stage growth round (OpenAI's $6.6 billion and $40 billion, Groq's $750 million),
 * not "Other". A lettered or named stage is never touched, and neither is a Form D, which names a
 * filing, not a round.
 */
export function stageForAmount(stage: Stage, asWritten: string, usdMillions: number | null): Stage {
  if (stage !== "other" && stage !== "undisclosed") return stage;
  if (/\bform d\b/i.test(asWritten)) return stage;
  return usdMillions !== null && usdMillions >= GROWTH_ROUND_USD_MILLIONS ? "growth" : stage;
}

/** Parse the many ways a date arrives (ISO, prose, "2 days ago") into a Date, or null. */
export function parseDate(value: string | null | undefined, now: Date = new Date()): Date | null {
  if (!value) return null;
  const v = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const parsed = chrono.parseDate(v, now, { forwardDate: false });
  return parsed ?? null;
}

const RELATIVE_DATE_WORDS = /\b(today|yesterday|tomorrow|tonight|ago|now|this|last|next|past|recently|earlier)\b/i;
/** A stamp on the page that is not its publish date: "Updated September 03, 2026" on a company profile. */
const STAMP_WORDS = /\b(updated|modified|edited|revised|reviewed|accessed|retrieved)\b/i;
const HAS_YEAR = /\b(?:19|20)\d{2}\b/;

function utcDay(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.getUTCDate() !== day ? null : d;
}

/**
 * A date the page itself states (a round's date, a dateline, a byline), read without a clock.
 * ISO passes as written; a dotted numeric date is day first ("01.02.2021" is 1 February, the
 * convention wherever dots are used). Anything else must name a year and a day: "Sept. 2, 2026",
 * "2 September 2026". Relative phrasing ("today", "2 days ago", "this week") and a date with no
 * year ("Aug 13") are null, since resolving them needs the run's clock, which is what this parser
 * exists to keep out of a record. A month with no day ("September 2026") is null too, and so is
 * an "Updated ..." stamp, which dates the page's last edit rather than its news.
 */
export function parseStatedDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const v = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (iso) return utcDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dotted = /^(\d{1,2})\.(\d{1,2})\.((?:19|20)\d{2})$/.exec(v);
  if (dotted) return utcDay(Number(dotted[3]), Number(dotted[2]), Number(dotted[1]));
  if (RELATIVE_DATE_WORDS.test(v) || STAMP_WORDS.test(v) || !HAS_YEAR.test(v)) return null;
  // The reference instant is fixed, so nothing about the run's clock can reach the result.
  const parsed = chrono.parse(v, new Date("2000-01-01T12:00:00Z"), { forwardDate: false })[0];
  if (!parsed) return null;
  if (!parsed.start.isCertain("day") || !parsed.start.isCertain("month") || !parsed.start.isCertain("year")) return null;
  const d = parsed.start.date();
  return new Date(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T12:00:00Z`);
}

/** Many publishers date their URLs (/2026/09/03/, -2026-09-03). Last-resort date. */
export function dateFromUrl(url: string | undefined): Date | null {
  if (!url) return null;
  // "/2026/08/19/" and "2026-08-19" as most sites write it; "/20260819537737/" as Business Wire does (the day, then the release id).
  const m =
    /(20\d{2})[/-](0[1-9]|1[0-2])[/-](0[1-9]|[12]\d|3[01])(?![\d])/.exec(url) ??
    /\/(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{4,}\//.exec(url);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Registrable domain (eTLD+1): the industry join key for a company. */
export function registrableDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  const withScheme = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
  return getDomain(withScheme) ?? null;
}

/** The last path segment of a URL without its extension: `/news/ollie-raises-7-5m-seed` gives `ollie-raises-7-5m-seed`. */
export function urlSlug(url: string): string {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    return decodeURIComponent(last).replace(/\.(html?|php|aspx?)$/i, "");
  } catch {
    return "";
  }
}

const NUMERIC_ID = /^\d{5,}$/;

/** The slug's words, without a leading or trailing numeric id (`148809-crusoe-raises`, `avendus-11787457991475`). */
export function slugWords(slug: string): string[] {
  const parts = slug.split(/[-_]+/).filter(Boolean);
  if (parts.length > 1 && NUMERIC_ID.test(parts[parts.length - 1])) parts.pop();
  if (parts.length > 1 && NUMERIC_ID.test(parts[0])) parts.shift();
  return parts;
}

/**
 * A slug read as a headline: `acme-raises-7-5m-seed` becomes "Acme raises 7.5M seed". Digit
 * groups split by the slug's dash rejoin with a point, a money unit after a number is upper
 * case, a numeric id at either end goes, and the first letter is capitalised.
 */
export function humanizeSlug(slug: string): string {
  const parts = slugWords(slug);
  const words: string[] = [];
  for (const part of parts) {
    const prev = words[words.length - 1];
    if (prev !== undefined && /^\d+$/.test(prev) && /^\d+[a-z]*$/i.test(part)) words[words.length - 1] = `${prev}.${part}`;
    else words.push(part);
  }
  const sentence = words.map((w) => w.replace(/^(\d+(?:\.\d+)?)([kmb])$/i, (_, n, unit) => `${n}${unit.toUpperCase()}`)).join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** Hosts that are never a company's own website. */
export const SOCIAL_AND_DIRECTORY_HOSTS = new Set([
  "linkedin.com",
  "x.com",
  "twitter.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "crunchbase.com",
  "pitchbook.com",
  "dealroom.co",
  "tracxn.com",
  "medium.com",
  "substack.com",
  "github.com",
]);

/**
 * Directories, investor databases, and deal-sourcing sites: their pages describe companies and
 * investors, never report a round, and are never a company's own website either. The sweep does
 * not extract from them and the resolver does not take a website on them.
 */
export const NON_ARTICLE_HOSTS = new Set([
  "privateequitylist.com",
  "windportfolio.com",
  "seedtable.com",
  "tracxn.com",
  "crunchbase.com",
  "pitchbook.com",
  "dealroom.co",
  "cbinsights.com",
  "golden.com",
  "wellfound.com",
  "angel.co",
  "linkedin.com",
  "f6s.com",
  "growjo.com",
  "zoominfo.com",
  "rocketreach.co",
  "signalhire.com",
]);

/** Hosts inside a non-article domain that are publishers in their own right. */
export const ARTICLE_HOST_EXCEPTIONS = new Set(["news.crunchbase.com"]);

/**
 * Directory domains where only part of the site is a directory: the first path segment names it. A
 * company profile (TipRanks' "Immediate Leadership, Clients & Company Overview", a CryptoRank project
 * page titled with its price and market cap) was listed as a source for the company's round.
 */
const NON_ARTICLE_SECTIONS: Record<string, Set<string>> = {
  "dealroom.co": new Set(["companies", "investors"]),
  "tipranks.com": new Set(["private-companies", "stocks"]),
  "cryptorank.io": new Set(["ico", "price", "funds"]),
};

/** A one-segment path that is site chrome (a section index, a feed, an about page), not an article. */
const CHROME_SEGMENTS = new Set([
  "news",
  "blog",
  "blogs",
  "insights",
  "funding-rounds",
  "funding",
  "investors",
  "portfolio",
  "companies",
  "startups",
  "ecosystem",
  "press",
  "press-releases",
  "newsroom",
  "articles",
  "posts",
  "stories",
  "resources",
  "deals",
  "events",
  "about",
  "about-us",
  "team",
  "contact",
  "search",
  "feed",
  "rss",
  "sitemap",
  "archive",
  "archives",
  "latest",
  "all",
  "category",
  "categories",
  "tag",
  "tags",
  "topic",
  "topics",
  "author",
  "authors",
  "page",
  "editorial-standards",
  "editorial-policy",
  "privacy",
  "privacy-policy",
  "terms",
  "terms-of-service",
  "advertise",
  "subscribe",
  "newsletter",
  "newsletters",
  "contact-us",
]);

/**
 * A one-segment path that is a site's front page under another name: `techmeme.com/index.html` is
 * Techmeme's homepage, whose headlines change by the hour, and a round read off it once pinned
 * Techmeme's front page to Basecamp Research's Series C.
 */
const FRONT_PAGE_SEGMENTS = new Set(["index", "home", "default", "front", "frontpage", "river"]);

/**
 * Applicant tracking systems and job boards: a posting names the company and often its latest round
 * ("we just raised our $140M Series C"), and it is never a report of the round. Matched on the
 * registrable domain, or on the host for a board that shares a domain with something else.
 */
const JOB_BOARD_DOMAINS = new Set([
  "ashbyhq.com",
  "greenhouse.io",
  "lever.co",
  "workable.com",
  "smartrecruiters.com",
  "recruitee.com",
  "bamboohr.com",
  "breezy.hr",
  "jobvite.com",
  "icims.com",
  "myworkdayjobs.com",
  "teamtailor.com",
  "personio.de",
  "personio.com",
  "applytojob.com",
  "pinpointhq.com",
  "homerun.co",
  "getro.com",
  "workatastartup.com",
  "indeed.com",
  "glassdoor.com",
  "ziprecruiter.com",
  "otta.com",
]);
const JOB_BOARD_HOSTS = new Set(["jobs.gem.com", "app.dover.com", "ats.rippling.com"]);
/** A path segment that files a page under a site's jobs: `/careers/...`, `/jobs/view/...`, `/companies/acme/jobs`. */
const JOB_SEGMENTS = new Set([
  "careers",
  "career",
  "jobs",
  "job",
  "job-openings",
  "open-positions",
  "open-roles",
  "vacancies",
  "vacancy",
  "join-us",
]);

/**
 * Whether a URL is a job posting or a jobs page: a board or tracking system's host (`jobs.ashbyhq.com`,
 * `boards.greenhouse.io`), a `jobs.` or `careers.` subdomain, or a path filed under jobs or careers.
 * Pure. A posting is never a source for a round, however well it names the company.
 */
export function isJobPostingUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const domain = registrableDomain(url) ?? host;
  if (JOB_BOARD_DOMAINS.has(domain) || JOB_BOARD_HOSTS.has(host)) return true;
  if (/^(?:jobs|careers|career|boards|job-boards)\./.test(host)) return true;
  return u.pathname
    .split("/")
    .filter(Boolean)
    .some((s) => JOB_SEGMENTS.has(safeDecode(s).toLowerCase()));
}

/** A path segment decoded, or as written when its escapes are malformed. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** A leading segment under which a site lists items; up to one more segment names the list. */
const LISTING_ROOTS = new Set(["category", "categories", "tag", "tags", "topic", "topics", "author", "authors", "page"]);

/** A segment deeper in the path that names a list when at most one segment follows it (`/newsroom/subject/funding`). */
const LISTING_SEGMENTS = new Set(["subject", "subjects", "category", "categories", "tag", "tags", "topic", "topics", "section"]);

/**
 * A path that opens with one of these is a record in a directory of companies, investors, or funds
 * (/companies/backed-by/blue-lake-capital, /investors/sequoia, /portfolio/acme), whatever the host:
 * trackers keep their data there, and news sites do not publish articles under them.
 */
const DIRECTORY_ROOTS = new Set([
  "companies",
  "company",
  "investors",
  "investor",
  "portfolio",
  "funds",
  "fund",
  "startup",
  "startups",
  "backed-by",
  "funded-by",
  "investments",
  "event",
  "events",
  "ecosystem",
  "ecosystems",
]);
/** A segment anywhere in the path that names a relation to an investor: the page lists a portfolio. */
const DIRECTORY_SEGMENTS = new Set(["backed-by", "funded-by", "invested-in", "portfolio-companies"]);

/**
 * Whether a URL can be an article: a page written about one event (or a roundup of them), as
 * opposed to a site root, a section index, a paginated list, a tag or author archive, or a page on
 * a directory of companies and investors. Pure, so the sweep can count what it declines to
 * extract, and the audit's index and directory URLs are its test cases.
 */
/**
 * A title that names a directory, a ranking, or a tracker: "Top 50 EdTech companies", "Seed Funding
 * Tracker", "Angel investors in Berlin", "List of funded startups". Such pages state rounds as data or
 * history and never as news; a roundup ("This week's biggest rounds") is not one of them. A ranking of
 * the best-funded startups is one: Offilancer's database-dated angel round came off "The best-funded
 * HR-tech startups in the Netherlands in 2026" as a new round (a singular "best-funded startup raises"
 * is a headline, not a ranking).
 *
 * Some markers are only nouns a headline can use about the company itself: a database or directory
 * company, a fitness tracker, a model leaderboard, a round "from angel investors". Those name a
 * directory only when the title does not read as an announcement, so "PlanetScale raises $30M Series B
 * for its database service" and "Acme raises $3M from angel investors" stay news. The list and ranking
 * shapes ("Top 50", "List of", "Companies to watch") are a directory whatever else the title says.
 */
export function isDirectoryTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  if (
    /\b(?:best|most|highest|top|well)[- ]funded\s+(?:[\w&.'’-]+\s+){0,4}?(?:startups|companies|scale-?ups|firms|unicorns)\b|\b(?:top|best|leading)\s+\d+\b|\b(?:index of|lists? of)\b|\b(?:startups?|compan(?:y|ies)|funding|investors?|vc|deals?|unicorns?)\s+(?:database|directory|tracker)\b|\bdatabase of\b|\b(?:companies|startups) (?:backed|funded|invested in|financed) by\b|\bportfolio (?:companies|of)\b|\b(?:investments|deals) (?:by|of|made by)\b|\binvestors? (?:to watch|list)\b|\bcompanies to watch\b|\bstartups to watch\b|^how to\b|\bhow to (?:find|get|raise|secure)\b|\b(?:a |the )?(?:guide|explainer|primer|playbook|handbook) (?:to|for|on)\b|\bwhat is (?:a |an )?(?:pre-seed|seed|series [a-z])\b|\bstandard deal\b|\bexit strateg(?:y|ies)\b/i.test(
      title,
    )
  )
    return true;
  if (
    !/\b(?:tracker|directory|database|ranking|rankings|leaderboard)\b|\b(?:angel|active|top|best)\s+investors?\b|\binvestors? in\b/i.test(
      title,
    )
  )
    return false;
  return !/\b(?:raises?|raised|raising|secures?|secured|lands?|landed|closes?|closed|bags?|bagged|nabs?|nabbed|snags?|snagged|picks up|scores?|gets|receives?|announces?|completes?|leads?|led|backs?|backed|invests?|invested)\b.*?(?:[$€£¥]\s?\d|\b\d+(?:[.,]\d+)?\s?(?:k|m|mn|million|b|bn|billion)\b|\b(?:pre-seed|seed|series [a-z]|funding|round|investment)\b)/i.test(
    title,
  );
}

export function isArticleUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const domain = registrableDomain(url) ?? host;
  const segments = u.pathname
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponent(s).toLowerCase());
  if (NON_ARTICLE_HOSTS.has(domain) && !ARTICLE_HOST_EXCEPTIONS.has(host)) return false;
  if (NON_ARTICLE_SECTIONS[domain]?.has(segments[0] ?? "")) return false;
  // A paginated list, by query or by path.
  for (const key of u.searchParams.keys()) if (/^(page|paged|pg)$/i.test(key)) return false;
  const pageIndex = segments.findIndex((s, i) => s === "page" && /^\d+$/.test(segments[i + 1] ?? ""));
  if (pageIndex >= 0) return false;
  if (segments.length === 0) return false;
  if (isJobPostingUrl(url)) return false;
  const lone = segments.length === 1 ? segments[0].replace(/\.(html?|php|aspx?)$/, "") : null;
  if (lone !== null && (CHROME_SEGMENTS.has(lone) || FRONT_PAGE_SEGMENTS.has(lone))) return false;
  // A site search at any depth (`/search/acme`, `/search/news?q=acme`); a root `/?s=acme` has no segment and went above.
  if (segments[0] === "search") return false;
  if (LISTING_ROOTS.has(segments[0]) && segments.length <= 2) return false;
  if (segments.some((seg, i) => i > 0 && LISTING_SEGMENTS.has(seg) && segments.length - i <= 2)) return false;
  // A news section that shares a directory's name files its articles by year (`/companies/2026/07/...`)
  // or under a headline slug (`/startups/malaysian-deep-tech-startup-nanoskunkworkx-raises-us2m-...`);
  // a directory entry is a name (`/company/light-links`, `/investors/sequoia`).
  const headlineSlug = (segments[segments.length - 1] ?? "").split(/[-_]+/).filter((w) => /[a-z]/.test(w)).length >= 5;
  if (DIRECTORY_ROOTS.has(segments[0]) && segments.length >= 2 && !/^\d{4}$/.test(segments[1]) && !headlineSlug) return false;
  if (segments.some((seg) => DIRECTORY_SEGMENTS.has(seg))) return false;
  // A wire's "all releases in this category" page ends in -list.
  if (/-list$/.test(segments[segments.length - 1])) return false;
  return true;
}

/**
 * Whether an evidence quote is a row from a table or a card rather than a sentence: two or more field
 * separators (a middle dot, a pipe, a tab) and no clause. "$93M raised · Series C1 · Seoul, South Korea"
 * is a directory's row about a round that happened some time; an article states it in a sentence.
 */
export function isTableRowQuote(quote: string | null | undefined): boolean {
  if (!quote) return false;
  const separators = (quote.match(/\s[·|•]\s|\t/g) ?? []).length;
  if (separators < 2) return false;
  // A sentence with separators still has a subject and a verb clause longer than a few words.
  const longestCell = Math.max(...quote.split(/\s[·|•]\s|\t/).map((c) => c.trim().split(/\s+/).length));
  return longestCell <= 6;
}

/** A money figure: a currency mark or code beside a number, or a number with a scale word. */
const MONEY_FIGURE =
  /[$€£¥₹]\s?\d|\b\d[\d.,]*\s*(?:million|billion|mn|bn|m|b|crore|cr|lakh|k)\b|\b(?:usd|eur|gbp|inr|rs\.?|sar|aed|pln|nok|sek|chf)\s?\d/i;

/** Any verb a sentence reporting a round uses, down to "is" and "has": a data point has none. */
const ROUND_CLAUSE =
  /\b(?:rais(?:e|es|ed|ing)|secur(?:e|es|ed|ing)|clos(?:e|es|ed|ing)|land(?:s|ed|ing)?|bag(?:s|ged)?|nab(?:s|bed)?|snag(?:s|ged)?|pull(?:s|ed)? in|announc(?:e|es|ed|ing)|complet(?:e|es|ed|ing)|receiv(?:e|es|ed|ing)|obtain(?:s|ed)?|attract(?:s|ed)?|garner(?:s|ed)?|gets?|got|win(?:s)?|won|led|leads?|co-?led|backed|invest(?:s|ed|ing)?|inject(?:s|ed)?|fund(?:s|ed|ing)|net(?:s|ted)|scor(?:e|es|ed)|lock(?:s|ed)? in|rak(?:e|es|ed) in|clinch(?:es|ed)?|seal(?:s|ed)?|pick(?:s|ed)? up|haul(?:s|ed)?|draw(?:s|n)?|drew|captur(?:e|es|ed)|bring(?:s)? in|brought in|tak(?:e|es) in|took in|extend(?:s|ed)?|expand(?:s|ed)?|add(?:s|ed)?|allocat(?:e|es|ed)|participat(?:e|es|ed)|join(?:s|ed|ing)?|contribut(?:e|es|ed)|unveil(?:s|ed)?|reveal(?:s|ed)?|disclos(?:e|es|ed)|confirm(?:s|ed)?|emerg(?:e|es|ed|ing)|launch(?:es|ed|ing)?|debut(?:s|ed)?|came out|comes out|sold|sells|reported|has|have|had|was|were|is|are)\b/i;

/** A word that names a round: its stage, or the round itself. "Megarounds" in a trend story's headline is not one. */
const ROUND_WORD = /\b(?:pre[\s-]?seed|seed|series[\s-]+[a-z]\b|round|funding|financing|investment|raise)\b/i;

/**
 * Whether an evidence quote is a data point rather than a sentence: a figure with no verb at all, or
 * a passing mention with no verb, no figure, and no round named. "Xpeng Robotics -- $900M Series A"
 * and "a $1.2 billion round for River AI" are items in a trend story's list of the year's biggest
 * rounds, dated to the story; "megarounds for Silicon Valley-based OpenAI" is the same story naming a
 * company in passing, and became an OpenAI "Series A". A report of a round says who raised it. A
 * verbless quote that names a round but no figure ("an undisclosed seed investment") says too little
 * either way, and a quote of a word or two is a label; neither is one.
 */
export function isDataPointQuote(quote: string | null | undefined): boolean {
  if (!quote || ROUND_CLAUSE.test(quote)) return false;
  if (MONEY_FIGURE.test(quote)) return true;
  return !ROUND_WORD.test(quote) && quote.trim().split(/\s+/).length >= 3;
}

/**
 * Strings a scraper reads off a page's furniture and an extractor splices into a name or a quote: a
 * company name with "Dealroom has a profile for this one." glued to its tail is the name plus a
 * directory's UI hint. Each is matched with or without a trailing period.
 */
const FURNITURE = [
  "Dealroom has a profile for this one",
  "Read more",
  "Learn more",
  "Continue reading",
  "Click here",
  "Subscribe",
  "Sign up",
  "Advertisement",
  "Share this article",
  "Share this",
];

/** The text without page furniture, whitespace collapsed; null when nothing remains. */
export function stripFurniture(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  let s = value;
  for (const f of FURNITURE) {
    // No leading boundary: a name spliced onto the hint has none.
    const re = new RegExp(`${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.?(?!\\w)`, "gi");
    s = s.replace(re, " ");
  }
  s = s
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
  return s ? s : null;
}

/**
 * The start of a use-of-funds clause, not a description: "expands into additional international
 * markets", "plans to hire", "will use the funds". A description says what the company is or does.
 */
const USE_OF_FUNDS_START =
  /^(?:the (?:funds?|funding|capital|round|proceeds|money|investment)\b|(?:it |they |which )?(?:will|plans?|aims?|intends?|expects?|hopes?|seeks?|wants?|looks?|is set|are set)\b|to (?:expand|scale|grow|accelerate|fund|build|hire|develop|launch|support|strengthen|deepen|enter|double|invest|fuel|drive|boost|further|advance|extend|continue|bring|open|increase|broaden|pursue|ramp|roll)\b|(?:expands?|expanding|scales?|scaling|grows?|growing|accelerates?|accelerating|hires?|hiring|invests?|investing|enters?|entering|doubles?|doubling|strengthens?|strengthening|deepens?|deepening|fuels?|fueling|boosts?|boosting|broadens?|broadening|launches?|launching|raises?|raised|raising|secures?|secured|closes?|closed|announces?|announced|uses?|using)\b)/i;

/** True when the text reads as a company description rather than a use-of-funds or news clause. */
export function isCompanyDescription(value: string): boolean {
  return !USE_OF_FUNDS_START.test(value.trim());
}

/** Strip tracking parameters and fragments so the same article dedupes across queries. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    // Tracking and attribution parameters: the same article arrives with and without them.
    for (const k of [...u.searchParams.keys()]) {
      if (
        /^(utm_|fbclid|gclid|dclid|msclkid|mc_|_hs|hsa_|igshid|yclid|ref$|ref_|source$|src$|s$|si$|mod$|cmpid$|ncid$|guccounter$|guce_)/i.test(
          k,
        )
      ) {
        u.searchParams.delete(k);
      }
    }
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

/**
 * True when `date` falls inside [windowStart, now + 1 day], and before `windowEnd` when one is
 * given. A day of slack at each open end covers timezones; `windowEnd` is exclusive and strict,
 * so a month sweep keeps that month's announcements and nothing from the first of the next.
 */
export function withinWindow(date: Date | null, windowStart: Date, now: Date = new Date(), windowEnd?: Date): boolean {
  if (!date) return false;
  const slackMs = 86_400_000;
  const t = date.getTime();
  if (t < windowStart.getTime() - slackMs || t > now.getTime() + slackMs) return false;
  return windowEnd === undefined || t < windowEnd.getTime();
}

/** A calendar month, `back` months before the one containing `now`: 0 is the month to date. */
export interface MonthWindow {
  kind: "month";
  back: number;
}

export type Window = "day" | "week" | MonthWindow;

/** The window as the string a run row, a URL, or a workflow argument carries. */
export type WindowSpec = "day" | "week" | "month" | `month-${number}`;

/** "day", "week", "month" (the month to date), "month-1", "month-2", ... "month-0" is "month". Anything else throws. */
export function parseWindow(input: string): Window {
  if (input === "day" || input === "week") return input;
  const m = /^month(?:-(\d{1,3}))?$/.exec(input);
  if (m) return { kind: "month", back: Number(m[1] ?? 0) };
  throw new Error(`unknown window: ${input}`);
}

export function formatWindow(window: Window): WindowSpec {
  if (typeof window === "string") return window;
  return window.back === 0 ? "month" : `month-${window.back}`;
}

/** The UTC calendar month `back` months before the one containing `now`, as [start, end). */
export function monthRange(back: number, now: Date = new Date()): { start: Date; end: Date } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() - back;
  return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
}

export function windowStartFor(window: Window, now: Date = new Date()): Date {
  if (typeof window !== "string") return monthRange(window.back, now).start;
  const days = window === "day" ? 1 : 7;
  return new Date(now.getTime() - days * 86_400_000);
}

/**
 * Days an hourly day-window sweep resolves over: the search still asks for the past day, but an
 * article that surfaces on day two or three (HighLife's and GEMBA's September 22 rounds were first
 * returned on the 25th) lands late instead of being dropped as out of window. The same span as the
 * sweep's seen ledger (`SWEEP_SEEN_DAYS.day` in lib/lanes.ts), so a page is never skipped as read
 * while its round could still land.
 */
export const DAY_WINDOW_RESOLVE_DAYS = 3;

/** Where a sweep's resolve window opens: three days back for the day window, else the window's own start. */
export function resolveWindowStartFor(window: Window, now: Date = new Date()): Date {
  if (window === "day") return new Date(now.getTime() - DAY_WINDOW_RESOLVE_DAYS * 86_400_000);
  return windowStartFor(window, now);
}

/** The exclusive end of a month window; a day or week window runs to now and has none. */
export function windowEndFor(window: Window, now: Date = new Date()): Date | undefined {
  return typeof window === "string" ? undefined : monthRange(window.back, now).end;
}

/**
 * Search `tbs` value: sort by date inside the recency window. https://docs.firecrawl.dev/features/search
 * A past month has no honest `tbs`: the custom range (`cdr:1,cd_min:MM/DD/YYYY,cd_max:MM/DD/YYYY`)
 * is accepted by the SDK but ignored by the API (tested 2026-09-04: news results came back from
 * the current week whatever the range), so the month to date uses `qdr:m` and an older month the
 * year, sorted by relevance, and the resolver's [windowStart, windowEnd) keeps the month's own
 * announcements. `windowQueryHint` pulls the year's results toward the month.
 */
export function tbsFor(window: Window): string {
  if (window === "day") return "sbd:1,qdr:d";
  if (window === "week") return "sbd:1,qdr:w";
  return window.back === 0 ? "sbd:1,qdr:m" : "qdr:y";
}

/**
 * Words appended to every query for a past month ("July 2026"): under `qdr:y` the query alone
 * returns the year's most relevant articles, and naming the month moved in-month results from
 * about half to nine in ten on the default preset's queries. The month to date needs none.
 */
export function windowQueryHint(window: Window, now: Date = new Date()): string | null {
  if (typeof window === "string" || window.back === 0) return null;
  return monthRange(window.back, now).start.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The window as a reader sees it on a run: "day", "week", "month", or "Jul 2026" for a past month. */
export function windowLabel(window: Window, now: Date = new Date()): string {
  if (typeof window === "string" || window.back === 0) return formatWindow(window);
  return monthRange(window.back, now).start.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
  "₩": "KRW",
  "₦": "NGN",
  "₱": "PHP",
  "₺": "TRY",
  "₪": "ILS",
  "₫": "VND",
  "฿": "THB",
  "₴": "UAH",
  "₽": "RUB",
  "₵": "GHS",
  "৳": "BDT",
  "₸": "KZT",
};
const CURRENCY_SYMBOL = new RegExp(`[${Object.keys(CURRENCY_SYMBOLS).join("").replace("$", "\\$")}]`);
// A code may be glued to the figure ("USD1.6m"), so the boundary after it is loose.
const CURRENCY_CODES =
  /\b(USD|EUR|GBP|JPY|INR|KRW|CAD|AUD|NZD|CHF|SEK|NOK|DKK|SGD|HKD|CNY|RMB|BRL|ILS|AED|SAR|TWD|MXN|ZAR|PLN|CZK|HUF|RON|TRY|IDR|MYR|PHP|THB|VND|PKR|BDT|NGN|KES|EGP|GHS|ARS|CLP|COP|PEN|UAH|KZT|QAR|KWD|MAD)(?![a-z])/i;
const CURRENCY_WORDS: Record<string, string> = {
  crore: "INR",
  cr: "INR",
  lakh: "INR",
  rs: "INR",
  rupees: "INR",
  rupee: "INR",
  yuan: "CNY",
  renminbi: "CNY",
  yen: "JPY",
  won: "KRW",
  dollars: "USD",
  dollar: "USD",
  euros: "EUR",
  euro: "EUR",
  pounds: "GBP",
  pound: "GBP",
};

/** Dollar signs with a country prefix: "NZ$2 million" is New Zealand dollars, not USD. `US$` stays USD. */
const DOLLAR_PREFIXES: Record<string, string> = {
  US: "USD",
  USD: "USD",
  NZ: "NZD",
  NZD: "NZD",
  AU: "AUD",
  AUD: "AUD",
  A: "AUD",
  C: "CAD",
  CA: "CAD",
  CAD: "CAD",
  S: "SGD",
  SG: "SGD",
  SGD: "SGD",
  HK: "HKD",
  HKD: "HKD",
  R: "BRL",
  NT: "TWD",
  MX: "MXN",
};
const DOLLAR_PREFIX = /(?<![A-Za-z])(USD|US|NZD|NZ|AUD|AU|A|CAD|CA|C|SGD|SG|S|HKD|HK|R|NT|MX)\$/;

export interface ParsedAmount {
  value: number | null;
  currency: string | null;
}

/**
 * True when the text's only claim to a currency is a bare "$": no country prefix, no code, no word.
 * "$46 million" is bare; "US$46 million", "$53 million CAD", and "46 million dollars" are not.
 */
export function isBareDollar(asWritten: string | null | undefined): boolean {
  if (!asWritten) return false;
  const s = asWritten.replace(/,/g, "");
  const sym = CURRENCY_SYMBOL.exec(s);
  if (sym?.[0] !== "$") return false;
  if (DOLLAR_PREFIX.test(s) || /\bus\$/i.test(s)) return false;
  if (CURRENCY_CODES.test(s)) return false;
  if (/\b(dollars?|euros?|pounds?|yuan|yen|won|rupees?|crore|lakh)\b/i.test(s)) return false;
  return true;
}

/** A bare dollar changes currency only when the same figure has an explicit marker in its evidence. */
export function dollarFromEvidence(
  asWritten: string | null | undefined,
  parsed: ParsedAmount,
  evidence: string | null | undefined,
): ParsedAmount {
  if (parsed.currency !== "USD" || !isBareDollar(asWritten)) return parsed;
  const stated = new Set<string>();
  const text = evidence ?? "";
  const figures = [
    ...text.matchAll(/(?:USD|US|AUD|AU|NZD|NZ|CAD|CA|SGD|SG|HKD|HK|A|C|S)\$\s*\d[\d,.]*\s*(?:million|billion|bn|m|thousand|k)?/gi),
    ...text.matchAll(/\b(?:USD|AUD|NZD|CAD|SGD|HKD)\s*\$?\s*\d[\d,.]*\s*(?:million|billion|bn|m|thousand|k)?/gi),
    ...text.matchAll(/\$\s*\d[\d,.]*\s*(?:million|billion|bn|m|thousand|k)?\s*(?:USD|AUD|NZD|CAD|SGD|HKD)\b/gi),
  ];
  for (const [figure] of figures) {
    const explicit = parseAmount(figure);
    if (explicit.value === parsed.value && explicit.currency) stated.add(explicit.currency);
  }
  const words: Array<[RegExp, string]> = [
    [/\bAustralian dollars?\b/gi, "AUD"],
    [/\bCanadian dollars?\b/gi, "CAD"],
    [/\bSingapore(?:an)? dollars?\b/gi, "SGD"],
    [/\bNew Zealand dollars?\b/gi, "NZD"],
    [/\bHong Kong dollars?\b/gi, "HKD"],
  ];
  for (const [marker, currency] of words) {
    for (const match of text.matchAll(marker)) {
      const before = text.slice(Math.max(0, match.index - 35), match.index);
      const figure = /\d[\d,.]*\s*(?:million|billion|bn|m|thousand|k)?\s*$/i.exec(before)?.[0];
      if (figure && parseAmount(figure).value === parsed.value) stated.add(currency);
    }
  }
  return stated.size === 1 ? { ...parsed, currency: [...stated][0] } : parsed;
}

/** Numbers a figure is spelled with before "million" or "billion". */
const SPELLED_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  hundred: 100,
};
const EUROPEAN_NUMBERS: Array<[number, string]> = [
  [1, "un uno una ein eins eine einen einem einer une um uma"],
  [2, "dos zwei deux due dois duas"],
  [3, "tres drei trois tre"],
  [4, "cuatro vier quatre quattro quatro"],
  [5, "cinco funf cinq cinque"],
  [6, "seis sechs sei"],
  [7, "siete sieben sept sette sete"],
  [8, "ocho acht huit otto oito"],
  [9, "nueve neun neuf nove"],
  [10, "diez zehn dix dieci dez"],
  [11, "once elf onze undici"],
  [12, "doce zwolf douze dodici"],
  [13, "trece dreizehn treize tredici treze"],
  [14, "catorce vierzehn quatorze quattordici catorze quatorze"],
  [15, "quince funfzehn quinze quindici"],
  [16, "dieciseis sechzehn seize sedici dezasseis dezesseis"],
  [17, "diecisiete siebzehn dix-sept diciassette dezassete dezessete"],
  [18, "dieciocho achtzehn dix-huit diciotto dezoito"],
  [19, "diecinueve neunzehn dix-neuf diciannove dezanove dezenove"],
  [20, "veinte zwanzig vingt venti vinte"],
  [30, "treinta dreissig trente trenta trinta"],
  [40, "cuarenta vierzig quarante quaranta quarenta"],
  [50, "cincuenta funfzig cinquante cinquanta cinquenta"],
  [60, "sesenta sechzig soixante sessanta sessenta"],
  [70, "setenta siebzig soixante-dix settanta"],
  [80, "ochenta achtzig quatre-vingts ottanta oitenta"],
  [90, "noventa neunzig quatre-vingt-dix novanta"],
  [100, "cien ciento hundert cent cento cem"],
];

const NUMBER_WORD_VALUES = new Map(Object.entries(SPELLED_NUMBERS));
for (const [value, words] of EUROPEAN_NUMBERS) for (const word of words.split(" ")) NUMBER_WORD_VALUES.set(word.replace(/-/g, " "), value);

const EUROPEAN_UNITS = [
  ["uno", "ein", "un", "uno", "um"],
  ["dos", "zwei", "deux", "due", "dois"],
  ["tres", "drei", "trois", "tre", "tres"],
  ["cuatro", "vier", "quatre", "quattro", "quatro"],
  ["cinco", "funf", "cinq", "cinque", "cinco"],
  ["seis", "sechs", "six", "sei", "seis"],
  ["siete", "sieben", "sept", "sette", "sete"],
  ["ocho", "acht", "huit", "otto", "oito"],
  ["nueve", "neun", "neuf", "nove", "nove"],
];
const EUROPEAN_TENS = [
  ["veinte", "zwanzig", "vingt", "venti", "vinte"],
  ["treinta", "dreissig", "trente", "trenta", "trinta"],
  ["cuarenta", "vierzig", "quarante", "quaranta", "quarenta"],
  ["cincuenta", "funfzig", "cinquante", "cinquanta", "cinquenta"],
  ["sesenta", "sechzig", "soixante", "sessanta", "sessenta"],
  ["setenta", "siebzig", "septante", "settanta", "setenta"],
  ["ochenta", "achtzig", "huitante", "ottanta", "oitenta"],
  ["noventa", "neunzig", "nonante", "novanta", "noventa"],
];
for (const [i, tens] of EUROPEAN_TENS.entries()) {
  for (const [j, units] of EUROPEAN_UNITS.entries()) {
    const value = (i + 2) * 10 + j + 1;
    NUMBER_WORD_VALUES.set(`${tens[0]} y ${units[0]}`, value);
    if (i === 0) NUMBER_WORD_VALUES.set(`veinti${units[0]}`, value);
    NUMBER_WORD_VALUES.set(`${units[1]}und${tens[1]}`, value);
    NUMBER_WORD_VALUES.set(`${tens[2]} ${j === 0 ? "et " : ""}${units[2]}`, value);
    NUMBER_WORD_VALUES.set(`${j === 0 || j === 7 ? tens[3].slice(0, -1) : tens[3]}${units[3]}`, value);
    NUMBER_WORD_VALUES.set(`${tens[4]} e ${units[4]}`, value);
  }
}
const FRENCH_SMALL = [
  "un",
  "deux",
  "trois",
  "quatre",
  "cinq",
  "six",
  "sept",
  "huit",
  "neuf",
  "dix",
  "onze",
  "douze",
  "treize",
  "quatorze",
  "quinze",
  "seize",
  "dix sept",
  "dix huit",
  "dix neuf",
];
for (const [i, word] of FRENCH_SMALL.entries()) {
  NUMBER_WORD_VALUES.set(`quatre vingt ${word}`, 81 + i);
  if (i >= 9) NUMBER_WORD_VALUES.set(`soixante ${i === 10 ? "et " : ""}${word}`, 61 + i);
}
NUMBER_WORD_VALUES.set("quatre vingt", 80);
const NUMBER_WORD_TOKENS = new Set([...NUMBER_WORD_VALUES.keys()].flatMap((word) => word.split(" ")));
const SPELLED_AMOUNT = new RegExp(
  `(?<![a-z-])(?:${[...NUMBER_WORD_VALUES.keys()]
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/ /g, "[ -]+"))
    .join("|")})(?=\\s+(?:million|billion)\\b)`,
  "gi",
);

export function normalizeAmountText(text: string): string {
  let normalized = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/(\d)-(?=(?:million|billion|thousand)\b)/gi, "$1 ")
    .replace(/\b(?:millones|millon|millionen|millions|milioni|milione|milhoes|milhao|mio\.?)\b/gi, "million")
    .replace(/\b(?:milliards?|milliarden|milliarde|miliardi|miliardo|bilhoes|bilhao)\b/gi, "billion")
    .replace(/\bmillion\.(?=\s|$)/gi, "million")
    .replace(/(\d)\s*\+(?=\s*(?:billion|bn|b|million|mn|mm|m|thousand|k|crore|cr|lakh)\b)/gi, "$1");
  normalized = normalized.replace(SPELLED_AMOUNT, (words: string, offset: number, source: string) => {
    const preceding = source
      .slice(0, offset)
      .trim()
      .toLowerCase()
      .split(/[\s-]+/);
    if (["and", "et", "e", "y", "und", "coma", "komma", "virgule", "virgola", "virgula"].includes(preceding.at(-1) ?? "")) preceding.pop();
    if (NUMBER_WORD_TOKENS.has(preceding.at(-1) ?? "")) return words;
    return String(NUMBER_WORD_VALUES.get(words.toLowerCase().replace(/[ -]+/g, " ")));
  });
  return normalized.replace(/\d[\d.,]*\d/g, (number) => {
    if (/^\d{1,3}(?:\.\d{3}){2,}$/.test(number)) return number.replace(/\./g, "");
    if (/^\d+,\d{1,2}$/.test(number) || /^\d{1,3}(?:\.\d{3})+,\d+$/.test(number)) return number.replace(/\./g, "").replace(",", ".");
    return number.replace(/,/g, "");
  });
}

/**
 * "$46 million", "€15M", "Rs 24 crore", "RMB 3 billion" -> { value in millions of the currency, currency }.
 * The first figure is the announced one: "NZ$2 million (AU$1.64 million)" is 2 million NZD, and
 * "$90M (€77.5M)" is 90 million USD. Conversion to USD happens separately with a dated rate (fx.ts).
 */
export function parseAmount(asWritten: string | null | undefined): ParsedAmount {
  if (!asWritten) return { value: null, currency: null };
  const s = normalizeAmountText(asWritten).trim();

  // The earliest currency indicator wins: "$10 million (37,500,000 SAR)" is USD.
  const candidates: Array<{ index: number; currency: string }> = [];
  const prefixed = DOLLAR_PREFIX.exec(s);
  if (prefixed) candidates.push({ index: prefixed.index, currency: DOLLAR_PREFIXES[prefixed[1]] ?? "USD" });
  const sym = CURRENCY_SYMBOL.exec(s);
  if (sym) candidates.push({ index: sym.index, currency: CURRENCY_SYMBOLS[sym[0]] ?? "USD" });
  const code = CURRENCY_CODES.exec(s);
  if (code) candidates.push({ index: code.index, currency: code[1].toUpperCase() === "RMB" ? "CNY" : code[1].toUpperCase() });
  // "150 million US dollars (about 1.01 billion yuan)" is USD: the words count as indicators too.
  const word = /\b(crore|cr|lakh|rs|rupees?|yuan|renminbi|yen|won|(?:u\.?s\.? )?dollars?|euros?|pounds?)\b/i.exec(s);
  if (word) candidates.push({ index: word.index, currency: CURRENCY_WORDS[word[1].toLowerCase().replace(/^u\.?s\.? /, "")] ?? "USD" });
  const us = /\bus\$/i.exec(s);
  if (us) candidates.push({ index: us.index, currency: "USD" });
  candidates.sort((a, b) => a.index - b.index);
  let currency = candidates[0]?.currency ?? null;
  // A bare "$" stays USD. "$53 million CAD" names its currency right after the figure.
  const bareDollar = sym !== null && sym[0] === "$" && candidates[0]?.index === sym.index && !prefixed && !us;
  if (bareDollar && code && code.index > sym.index) {
    const between = s.slice(sym.index + 1, code.index);
    if (/^\s*\d[\d.]*\s*(?:billion|bn|b|million|mn|mm|m|thousand|k)?\s*$/i.test(between)) {
      currency = code[1].toUpperCase() === "RMB" ? "CNY" : code[1].toUpperCase();
    }
  }

  const num = /(\d+(?:\.\d+)?)\s*(billion|bn|b|million|mn|mm|m|thousand|k|crore|cr|lakh)?\b/i.exec(s);
  if (!num) return { value: null, currency };
  let value = Number(num[1]);
  const unit = (num[2] ?? "").toLowerCase();
  if (unit === "billion" || unit === "bn" || unit === "b") value *= 1000;
  else if (unit === "thousand" || unit === "k") value /= 1000;
  else if (unit === "crore" || unit === "cr")
    value *= 10; // 1 crore = 10 million
  else if (unit === "lakh")
    value /= 10; // 1 lakh = 0.1 million
  else if (unit === "") {
    // Funding figures carry a unit. A bare number is either a full dollar figure (46000000) or noise ("$9094").
    if (value >= 100_000) value /= 1_000_000;
    else return { value: null, currency };
  }
  return { value: Math.round(value * 1000) / 1000, currency };
}
