// Company enrichment: what they sell, who they sell to, whether they charge a
// software subscription, and (when a pricing page is linked) the pricing model.
// The pricing URL comes from the page's real links, never from the model.
// A homepage's profile is written onto a company only after the extraction says it
// is the same company the record describes: a bare one-word name collides with an older
// company of the same name, and the collision used to win. A homepage the scrape could not read is
// unknown, not refused: the website stays, the profile waits for the next pass. Candidates come from
// the record, then the company's own pages among the store's sources, then the search, then the links
// in the round's press release. A guessed domain never becomes a candidate.
// https://docs.firecrawl.dev/features/scrape

import type { BrandingProfile, Firecrawl } from "firecrawl";
import { z } from "zod";
import { brandSearchName } from "../records/brand-name.ts";
import {
  hostOf,
  NON_ARTICLE_HOSTS,
  namesCompany,
  normalizeCompanyKey,
  registrableDomain,
  SOCIAL_AND_DIRECTORY_HOSTS,
} from "../records/normalize.ts";
import { extractionCredits, mapLimit, RATE, searchCredits } from "./credits.ts";

// Field order is deliberate: the model writes what the site sells before it judges whether that
// is the company the prompt describes, and it has to name the different business before it may
// answer false, so the verdict follows the evidence.
export const CompanyProfile = z.object({
  what_they_sell: z.string().describe("One sentence: the product and who buys it"),
  customer_type: z.enum([
    "B2B software",
    "developer tool or API",
    "consumer",
    "hardware or deep tech",
    "biotech or healthcare",
    "marketplace",
    "services",
    "other",
  ]),
  sells_software_subscription: z.boolean().describe("true if the company charges recurring fees for software"),
  identity_reason: z
    .string()
    .describe(
      "One sentence: what this site sells and whether that is a compatible line of business with the prompt's record. When same_company is false, name the different business.",
    ),
  different_business: z
    .string()
    .nullable()
    .optional()
    .describe(
      'The different industry or product category this site is in, in a few words ("bicycle retail", "pet food", "a personal blog", "a parked domain"), when it is clearly not the record\'s business. Null when the site is the same or a compatible business, including a more specific or more general description of the same products, market, or technology.',
    ),
  same_company: z
    .boolean()
    .describe(
      "true when this website plausibly belongs to the company the prompt's record describes: the same or a near-same name and a compatible line of business. A more specific or more general description of the same products, market, or technology is compatible (a maker of silicon carbide power electronics and a seller of EV chargers and inverters are one business). false only when the site is clearly a different business: a different industry or product category, a personal site, a parked domain, or a directory, named in different_business.",
    ),
  public_listing: z
    .string()
    .nullable()
    .optional()
    .describe(
      'When this site\'s own company has shares trading on a public stock exchange today, the exchange and ticker as written ("NASDAQ: AAPL"), as its investor relations section, stock information, or filings show. Null for a private company, a subsidiary, or when the site does not show a listing; never guess.',
    ),
});
export type CompanyProfile = z.infer<typeof CompanyProfile>;

export const PricingProfile = z.object({
  pricing_model: z.enum([
    "usage-based",
    "seat-based",
    "flat subscription",
    "tiered plans",
    "hybrid (plans plus usage)",
    "free only",
    "sales-led (contact us)",
    "unknown",
  ]),
  has_free_tier: z.boolean(),
  plans: z.array(
    z.object({
      name: z.string(),
      price_as_written: z
        .string()
        .nullable()
        .describe(
          "The plan's price as the page writes it ('$29/month', 'Free', 'Custom'). Null when the page shows only a button or link (Start trial, Contact us) instead of a price.",
        ),
    }),
  ),
  billing_notes: z
    .string()
    .nullable()
    .describe("Anything notable about how they bill: credits, overages, annual discounts, minimums. Null if nothing stands out."),
});
export type PricingProfile = z.infer<typeof PricingProfile>;

// The model must answer different_business (null or a name) so a false always says what it found;
// the parser stays lenient about the field so a profile is never lost over it.
const companyJsonSchema = (() => {
  const schema = z.toJSONSchema(CompanyProfile, { target: "draft-07", io: "output" }) as { required?: string[] };
  schema.required = [...new Set([...(schema.required ?? []), "different_business"])];
  return schema;
})();
const pricingJsonSchema = z.toJSONSchema(PricingProfile, { target: "draft-07", io: "output" });

const NEWS_HOST =
  /(news|press|wire|journal|times|post|insider|tech|crunch|startup|axios|bloomberg|reuters|forbes|medium|substack|linkedin|dealroom|tracxn|fundz|vcnews|wikipedia|crunchbase|pitchbook)/i;
const PARKED =
  /(godaddy\.com\/forsale|forsale\.godaddy|namecheap\.com\/market|sedo\.com|dan\.com|afternic|hugedomains|parkingcrew|bodis\.com)/i;

/** What the branding format read off the homepage: the logo file, the name as the site writes it, the primary colour. */
export interface Brand {
  name: string | null;
  logo: string | null;
  primary_color: string | null;
}

export interface Enrichment {
  company_key: string;
  /**
   * The homepage that verified as this company, or one kept without a verdict: a host the scrape
   * could not read, or an exact-name host the check refused without naming a different business.
   * A kept-without-verdict website carries `profile: null`. Null under "none", "parked", and "unverified".
   */
  company_website: string | null;
  /**
   * Where the website came from. "record": the record named it. "sources": the company's own pages
   * among its rounds' sources or its dossier's, or a press release's link to it. "search": the grounded
   * search found it. "none": no candidate to try. "parked": every candidate was a parked domain.
   * "unverified": candidates were read and none was this company.
   */
  website_source: "record" | "sources" | "search" | "none" | "parked" | "unverified";
  /**
   * What confirmed the website. "homepage": its homepage read answered same_company. "about_page": the
   * homepage was too large for the extraction and its own about page answered instead. "linked": the
   * homepage could not be read, and the round's own pages placed the company on the domain while a
   * search listing on it names the company today; no profile, logo, or description comes of it.
   * Absent on rows written before the field and on rows nothing confirmed.
   */
  identity_basis?: "homepage" | "about_page" | "linked";
  /** The pages behind a "linked" or "about_page" confirmation, so a reader can check them. */
  identity_evidence?: string[];
  /** The record fields the identity check could compare the homepage against; empty means it had only the name. */
  context: Array<"description" | "evidence" | "headline" | "headquarters" | "sector">;
  /** Hosts read and refused this pass (a namesake or parked), so a wrong website on the record can be cleared. */
  refused_hosts: string[];
  /**
   * Hosts the scrape could not read this pass (timeout, block, no JSON profile). Unknown, not
   * refused: a website among them stays on the row, and the next enrichment tries again.
   */
  unreadable_hosts: string[];
  /** The brand logo when the branding format found one, else the homepage favicon; absolute against the page. */
  logo_url: string | null;
  brand: Brand | null;
  profile: CompanyProfile | null;
  pricing_page_url: string | null;
  pricing: PricingProfile | null;
  error?: string;
}

/** A pricing page is a link on the company's own host whose path is /pricing or /plans. */
function pricingLink(links: string[] | undefined, homepage: string): string | null {
  if (!links) return null;
  const home = hostOf(homepage);
  return links.find((l) => hostOf(l) === home && /\/(pricing|plans)(\/|$|\?|#)/i.test(l)) ?? null;
}

/** An image reference from the page as an absolute http(s) URL, or null for data: URIs and anything unusable. */
function imageUrl(raw: string | null | undefined, pageUrl: string): string | null {
  const value = raw?.trim();
  if (!value || value.startsWith("data:")) return null;
  try {
    const u = new URL(value, pageUrl);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The favicon a scrape reported, absolute against the page. A relative or unusable value yields null. */
export function logoFrom(metadata: { favicon?: string | null } | undefined, pageUrl: string): string | null {
  return imageUrl(metadata?.favicon, pageUrl);
}

/**
 * The brand the branding format read, or null when it returned nothing usable. The logo is the
 * brand's own file when there is one, which beats a favicon at any size above 16px.
 */
export function brandFrom(branding: BrandingProfile | undefined, pageUrl: string): Brand | null {
  if (!branding) return null;
  const brand: Brand = {
    name: branding.brandName?.trim() || null,
    logo: imageUrl(branding.logo, pageUrl),
    primary_color: branding.colors?.primary?.trim() || null,
  };
  return brand.name || brand.logo || brand.primary_color ? brand : null;
}

/**
 * The logo a homepage read yields: the branding format's logo file, else the page's favicon. The
 * company pass and the investor logo pass both take it from here, so the two pick alike.
 */
export function homepageLogo(home: { branding?: BrandingProfile; metadata?: { favicon?: string | null } }, pageUrl: string): string | null {
  return brandFrom(home.branding, pageUrl)?.logo ?? logoFrom(home.metadata, pageUrl);
}

function looksParked(links: string[] | undefined, title: string | undefined): boolean {
  if (title && /\b(for sale|is for sale|domain parking|parked)\b/i.test(title)) return true;
  if (!links || links.length === 0) return false;
  const total = links.length;
  const parked = links.filter((l) => PARKED.test(l)).length;
  return parked > 0 && parked >= total / 4;
}

/**
 * Trailing words of a company name that describe the business rather than name it: "Upwind Security"
 * lives at upwind.io, "Cornelis Networks" at cornelis.com, "Kraken Technology Group" at
 * krakentechnology.com. Legal suffixes (Inc., Labs, AI, Technologies) already leave the key.
 */
const NAME_DESCRIPTORS = new Set(
  (
    "security cyber networks network health healthcare group holdings holding technology tech systems software robotics " +
    "therapeutics bio biosciences biotech pharma pharmaceuticals medical energy industries international global platform " +
    "company solutions services cloud data digital analytics aerospace defense defence space motors mobility foods"
  ).split(" "),
);

/** Words a company's domain adds to its name: heyollie, getacme, regentcraft, nilotx, acmehq. */
const DOMAIN_PREFIXES = ["get", "try", "use", "join", "go", "hey", "meet", "with", "the"];
const DOMAIN_SUFFIXES = [
  "hq",
  "app",
  "apps",
  "inc",
  "ai",
  "labs",
  "tech",
  "bio",
  "tx",
  "rx",
  "health",
  "craft",
  "group",
  "global",
  "io",
  "co",
  "official",
  "online",
];

/** Section subdomains that sit under the company's own domain: about.wonder.com is wonder.com. */
const SECTION_SUBDOMAIN = /^(www|about|blog|news|ir|investors?|app|en|careers|press|info|corporate|company|go)\./;

/** The label a domain is known by: the registrable domain's first label, so about.wonder.com reads as "wonder". */
function domainLabel(host: string): { label: string; whole: string } {
  const domain = registrableDomain(host) ?? host;
  return { label: (domain.split(".")[0] ?? "").replace(/-/g, ""), whole: domain.replace(/[.-]/g, "") };
}

/**
 * How well a host spells the company's name. "exact": the domain's label is the whole name (or the
 * name runs on into the suffix, penelope.health), or a long one-word name with a few letters around
 * it (heyollie.com). "loose": the name without its descriptor words (upwind.io for Upwind Security),
 * or the name with a common domain affix (regentcraft.com, nilotx.com). Null when the host does not
 * spell the name at all. A loose host is only a candidate: the homepage read still decides, and a
 * parent company's site (xpeng.com for Xpeng Robotics) is refused there.
 */
export function hostFit(host: string, name: string): "exact" | "loose" | null {
  const { label, whole } = domainLabel(host);
  const key = normalizeCompanyKey(name).split(" ").filter(Boolean);
  if (key.length === 0 || !label) return null;
  const compact = key.join("");
  if (label === compact || whole === compact) return "exact";
  if (key.length === 1 && key[0].length >= 5 && (label.endsWith(key[0]) || label.startsWith(key[0])) && label.length <= key[0].length + 4)
    return "exact";
  const heads = [compact];
  for (let k = key.length - 1; k >= 1; k--) {
    if (key.slice(k).every((t) => NAME_DESCRIPTORS.has(t))) heads.push(key.slice(0, k).join(""));
  }
  for (const head of heads) {
    if (head.length >= 4 && head !== compact && (label === head || whole === head)) return "loose";
    // An affix around a short name spells too many other things (thehive.ai is not every Hive), so
    // it needs the five letters the one-word rule above asks for.
    if (head.length >= 5 && (DOMAIN_SUFFIXES.some((s) => label === head + s) || DOMAIN_PREFIXES.some((p) => label === p + head)))
      return "loose";
  }
  return null;
}

/** The registrable label must equal the company key, not merely contain a token ("Town" must not resolve to a town). */
export function hostMatchesCompany(host: string, name: string): boolean {
  return hostFit(host, name) === "exact";
}

/** The homepage a page on the company's site stands for: its host, without a section subdomain. */
export function homepageOf(url: string): string | null {
  const host = hostOf(url);
  if (!host) return null;
  const domain = registrableDomain(host);
  const bare = domain && host !== domain ? host.replace(SECTION_SUBDOMAIN, "") : host;
  return `https://${bare}`;
}

/** Legal suffixes a search for the company does not need: "Upwind Security Inc." searches as "Upwind Security". */
const LEGAL_SUFFIX = /[\s,]+(inc|llc|ltd|limited|corp|corporation|co|gmbh|ag|sas|sa|s\.?p\.?a|spa|bv|plc|pte|pty|oy|ab|srl)\.?$/i;

/** The company's name as a search should write it: the legal suffixes off, the words it is known by kept. */
export function searchName(name: string, domain: string | null = null): string {
  let out = brandSearchName(name, domain);
  for (;;) {
    const next = out.replace(LEGAL_SUFFIX, "").trim();
    if (next === out || !next) break;
    out = next;
  }
  return out;
}

/** Words after a name that make it an institution rather than a company: "Regent University", "Cathedral Church". */
const INSTITUTION_WORD =
  /^(university|college|school|academy|church|cathedral|parish|chapel|hospital|museum|library|foundation|council|ministry|department|society|association|club|city|county)$/;

/**
 * Whether the homepage's own brand name is a different entity that contains the company's name.
 * Washington National Cathedral's site, cathedral.org, passed the model's identity check for
 * Cathedral, the defense startup: the headquarters matched and the model read the record back
 * as the page. The brand said otherwise. A brand with proper words in front of the name, or an
 * institution word after it, names someone else. Taglines (anything with a separator, or longer
 * than six words) and brands that do not contain the name say nothing either way.
 */
/**
 * A homepage on a trailing fragment of the company's name whose own brand is that fragment: scale.com,
 * branded "Scale AI", is not CScale, whatever an identity read says (2026-09-30). The near-same
 * name is what lets the read call it the same company, so the brand decides.
 */
export function brandDisownsHost(host: string, brand: string | null | undefined, name: string): boolean {
  if (!brand?.trim() || hostFit(host, name) !== null) return false;
  const { label } = domainLabel(host);
  const compact = normalizeCompanyKey(name).replace(/\s+/g, "");
  if (label.length < 3 || !compact.includes(label) || compact.startsWith(label)) return false;
  // The site calls itself by the fragment ("Scale AI" on scale.com): its own company, not this one.
  const first = normalizeCompanyKey(brand).split(" ")[0] ?? "";
  return first === label && !namesCompany(brand, name, { share: 1 }) && !namesCompany(name, brand, { share: 1 });
}

export function brandNamesOtherEntity(brand: string | null | undefined, name: string): boolean {
  if (!brand || /[|,:;\u00b7\u2013\u2014-]/.test(brand)) return false;
  if (/^home\s*[\\/]\s*/i.test(brand)) return false;
  const words = (s: string): string[] => [...s.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]);
  const b = words(brand);
  const n = words(searchName(name));
  if (b.length > 1 && INSTITUTION_WORD.test(b[b.length - 1]) && !n.every((w) => b.includes(w))) return true;
  if (b.length > 6 || n.length === 0 || b.length <= n.length) return false;
  const at = b.findIndex((_, i) => n.every((w, j) => b[i + j] === w));
  if (at < 0) return false;
  const before = b.slice(0, at);
  const after = b.slice(at + n.length);
  if (before.some((w) => !DOMAIN_PREFIXES.includes(w))) return true;
  return after.some((w) => INSTITUTION_WORD.test(w));
}

export interface EnrichInput {
  company_key: string;
  company_name: string;
  company_website: string | null;
  /** What the record said the company does; grounds the website search and the identity check. */
  company_description?: string | null;
  headquarters?: string | null;
  sector?: string | null;
  /** The sentence the round was extracted from: what the press said the company is, when the record has no description. */
  evidence?: string | null;
  /** The headline of the round's first source, one more statement of who this company is. */
  headline?: string | null;
  /**
   * The pages the company's rounds were read from, with the titles they carried. A page on the
   * company's own domain names its homepage; a press release links it.
   */
  source_pages?: Array<{ url: string; title: string | null }>;
  /** The pages a deep dive on the company read: its own site is usually among them, often several times. */
  dossier_sources?: string[];
}

/** The record's context that tells one company of a name from another; the fields a caller passes when it has them. */
export type CompanyContext = Pick<
  EnrichInput,
  "company_name" | "company_description" | "headquarters" | "sector" | "evidence" | "headline"
>;

/** The record's account of what the company does: its description, else the sentence it was extracted from. */
export function describedAs(context: CompanyContext): string | null {
  return context.company_description?.trim() || context.evidence?.trim() || null;
}

/**
 * Whether the record knows enough about the company to tell a namesake apart. Without any of this,
 * a site found by search cannot be verified, and an unverifiable profile is worse than none.
 */
export function contextFields(context: CompanyContext): Enrichment["context"] {
  const out: Enrichment["context"] = [];
  if (context.company_description?.trim()) out.push("description");
  if (context.evidence?.trim()) out.push("evidence");
  if (context.headline?.trim()) out.push("headline");
  if (context.headquarters?.trim()) out.push("headquarters");
  if (context.sector && context.sector !== "other") out.push("sector");
  return out;
}

export function hasContext(context: CompanyContext): boolean {
  return contextFields(context).length > 0;
}

/** Function words, and the funding vocabulary a description lifted from an announcement carries. */
const QUERY_NOISE = new Set(
  (
    "a an the and or of for to in on at by with that is its it as from into their this which who whose was were be been " +
    "has have had are our we they them also than then over under about after before between through " +
    "based company startup firm inc ltd llc co corp " +
    "raised raises raise raising funding round rounds seed series pre investors investor led lead leads announced announces " +
    "million billion valuation capital ventures venture partners fund today closed secured backed"
  ).split(/\s+/),
);

/**
 * Words from the record's description that tell this company from a namesake: the first sentence,
 * minus function words, funding vocabulary, numbers, and the company's own name, capped at six.
 */
export function distinguishingWords(context: CompanyContext): string[] {
  const nameTokens = new Set(normalizeCompanyKey(context.company_name).split(" ").filter(Boolean));
  const firstSentence = (describedAs(context) ?? "").split(/(?<=[.!?])\s+/)[0] ?? "";
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of firstSentence.split(/[\s,;:()"']+/)) {
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    const key = word.toLowerCase();
    // A one-letter token is a round letter ("Series C") or an initial, never a distinguishing word.
    if (!word || word.length < 2 || /\d/.test(word) || QUERY_NOISE.has(key) || nameTokens.has(key) || seen.has(key)) continue;
    // "San Diego-based" is the city plus a suffix the noise list already names.
    const trimmed = word.replace(/-(based|headquartered|founded)$/i, "");
    seen.add(key);
    out.push(trimmed);
    if (out.length === 6) break;
  }
  return out;
}

/**
 * The search query: the name plus what the record knows (description words, the city, the
 * sector), so a one-word name plus its city and line of business finds the startup and not the
 * older brand that shares the name. Without
 * any context it is the bare name and "official website", the old query.
 */
export function websiteQuery(context: CompanyContext): string {
  const parts = [searchName(context.company_name), ...distinguishingWords(context)];
  const seen = new Set(parts.map((p) => p.toLowerCase()));
  const push = (value: string | null | undefined) => {
    for (const token of (value ?? "").split(/\s+/)) {
      const key = token.toLowerCase();
      if (!token || seen.has(key)) continue;
      seen.add(key);
      parts.push(token);
    }
  };
  // The city carries the signal; the country after the comma rarely does.
  push(context.headquarters?.split(",")[0]);
  if (context.sector && context.sector !== "other") push(context.sector);
  return parts.length === 1 ? `${parts[0]} official website` : parts.join(" ");
}

/**
 * What the extraction is told to check the homepage against. The line of business is the test, not
 * the name: a namesake in another industry shares the name, often the city, and is still a miss.
 * The test is compatibility, not wording: a record describes a technology ("silicon carbide power
 * electronics") and a homepage sells the products ("inverters and EV chargers"), and that is one
 * business, so a false has to name the different business it found.
 */
export function identityPrompt(context: CompanyContext, site?: { shortName: string }): string {
  const name = context.company_name.trim();
  const facts = [
    `Identity check. We are looking for the company named "${name}"`,
    context.company_description ? `, which the record describes as: ${context.company_description.trim().replace(/[.\s]+$/, "")}` : null,
    ".",
    context.evidence ? ` The press reported it as: "${context.evidence.trim()}"` : null,
    context.headline ? ` Under the headline: "${context.headline.trim()}"` : null,
    context.headquarters ? ` Headquarters: ${context.headquarters.trim()}.` : null,
    context.sector && context.sector !== "other" ? ` Sector: ${context.sector}.` : null,
    " First describe what this website's company actually sells. Then decide whether this site plausibly belongs to the company",
    " in the record: the same or a near-same name, and a compatible line of business. Compatible means the same products, market,",
    " or technology, even when one side describes it more specifically or more generally than the other, or names the technology",
    " where the other names the products (silicon carbide power electronics and EV chargers or inverters are the same business).",
    " Different wording is not a different company. Set same_company to true when it plausibly belongs to this company.",
    ` Set same_company to false only when the site is clearly a different business: a company called "${name}" in a different`,
    " industry or product category, a personal site, a parked domain, or a directory, even if the name, city, or logo match.",
    ` A parent company, group, or sibling business of which "${name}" is only one unit or subsidiary (a carmaker whose robotics`,
    " unit is the record) is a different company too: answer false and name it. When",
    " it is false, name that different business in different_business and in identity_reason; when it is true or you cannot name",
    " a different business, leave different_business null. In identity_reason, one sentence naming what the site sells and",
    " whether that is compatible with the record.",
    // A host that spells only part of the name is where a parent's site passes for its unit's: the
    // model reads "humanoid robots" on xpeng.com and calls the carmaker the robotics company.
    site
      ? ` This site's domain spells only "${site.shortName}", not the full name "${name}". If the site's main business is broader than the record's company, a group or a parent whose one unit or product line is the record's company, answer false and name the parent's main business.`
      : null,
  ];
  return facts.filter((f): f is string => f !== null).join("");
}

/**
 * Whether a refusal named the business it found instead. A false that names none ("sells inverters,
 * record says power electronics") is a wording quibble, not a namesake; the prompt asks the model
 * for the name as a field rather than reading it out of the reason's prose.
 */
export function namesDifferentBusiness(profile: CompanyProfile): boolean {
  return (profile.different_business ?? "").trim().length > 0;
}

/** A search result on a host that spells the company's name: the title and snippet it was listed under. */
export interface Listing {
  url: string;
  title: string | null;
  description: string | null;
}

export interface WebsiteSearch {
  /** Up to `max` homepages in search order, one per host. */
  homepages: string[];
  /** Every result on a name-spelling host, by homepage: what the domain says about itself today. */
  listings: Map<string, Listing>;
}

/**
 * The homepages a five-result search offers for the company, in search order, one per host. A host
 * must spell the company's name (exactly, or without its descriptor words); the news-word filter reads
 * only hosts that do not, so krakentechnology.com is not dropped for the "tech" in it.
 */
export async function searchWebsites(
  client: Firecrawl,
  context: CompanyContext,
  max = 3,
  opts: { loose?: boolean } = {},
): Promise<WebsiteSearch> {
  const res = await client.search(websiteQuery(context), { limit: 5, highlights: false });
  const homepages: string[] = [];
  const listings = new Map<string, Listing>();
  const items = (res.web ?? []).map((item) => ({
    url: "url" in item && typeof item.url === "string" ? item.url : "",
    title: "title" in item && typeof item.title === "string" ? item.title : null,
  }));
  // A host that spells only part of the name must list its own front page under the whole name
  // (upwind.io as "Upwind Security: Cloud & AI Security"); a parent's news post about its unit
  // (xpeng.com/news/..., "XPENG Robotics raises") does not make the parent's site the unit's.
  const frontPageNamesCompany = (domain: string | null) =>
    items.some(
      (i) =>
        registrableDomain(i.url) === domain && /^\/?$/.test(pathOf(i.url)) && namesCompany(i.title, context.company_name, { share: 1 }),
    );
  for (const item of res.web ?? []) {
    const url = "url" in item ? item.url : undefined;
    if (!url) continue;
    const host = hostOf(url);
    if (SOCIAL_AND_DIRECTORY_HOSTS.has(registrableDomain(url) ?? "") || NON_ARTICLE_HOSTS.has(registrableDomain(url) ?? "")) continue;
    const fit = hostFit(host, context.company_name);
    if (!fit || (fit === "loose" && (opts.loose === false || !frontPageNamesCompany(registrableDomain(url))))) continue;
    const homepage = homepageOf(url);
    if (!homepage) continue;
    if (!listings.has(homepage)) {
      const title = "title" in item && typeof item.title === "string" ? item.title : null;
      const description = "description" in item && typeof item.description === "string" ? item.description : null;
      listings.set(homepage, { url, title, description });
    }
    if (homepages.includes(homepage) || homepages.length === max) continue;
    homepages.push(homepage);
  }
  return { homepages, listings };
}

/** A URL's path, or "" when it does not parse. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/** Up to three homepages a five-result grounded search offers for the company, in search order, one per host. */
export async function findWebsite(client: Firecrawl, context: CompanyContext, max = 3): Promise<string[]> {
  return (await searchWebsites(client, context, max)).homepages;
}

/** Wires whose releases link the company's own site, usually in the first line and the "About" paragraph. */
const WIRE_HOST = /(^|\.)(prnewswire|businesswire|globenewswire|prweb|accesswire|einpresswire|newswire|newsfilecorp)\.(com|ca|co\.uk)$/;

/** A roundup or list page links dozens of companies, so its links name nobody in particular. */
const ROUNDUP_TITLE = /\b(roundup|round-up|weekly|funding report|biggest|top \d+|\d+ (startups|companies)|this week|newsletter)\b/i;

/** Hosts a press link points to that are never a company's homepage. */
const NEVER_HOMEPAGE =
  /(^|\.)(google|apple|bit\.ly|t\.co|lnkd\.in|wikipedia|sec\.gov|youtube|youtu\.be|instagram|facebook|tiktok|x|twitter)\./;

/** A host no homepage search should take: directories, social networks, wires, publishers. */
function neverCompanySite(host: string): boolean {
  const domain = registrableDomain(host) ?? host;
  return SOCIAL_AND_DIRECTORY_HOSTS.has(domain) || NON_ARTICLE_HOSTS.has(domain) || WIRE_HOST.test(host) || NEVER_HOMEPAGE.test(`${host}.`);
}

/**
 * Homepages the store's own evidence names, best first: a page on a host that spells the company's
 * name among its rounds' sources (a loose spelling needs the page's title to name the company too) or
 * its dossier's, then a host the dossier read two or more pages of (mmimicro.com for Medical
 * Microinstruments), which a publisher or directory never is. Each is only a candidate: the
 * homepage read decides.
 */
export function siteCandidates(
  name: string,
  sources: Array<{ url: string; title: string | null }> = [],
  dossier: string[] = [],
  max = 3,
): string[] {
  const ranked: Array<{ homepage: string; rank: number; order: number }> = [];
  const add = (url: string, rank: number) => {
    const homepage = homepageOf(url);
    if (!homepage) return;
    const domain = registrableDomain(homepage);
    const seen = ranked.find((r) => registrableDomain(r.homepage) === domain);
    if (seen) {
      seen.rank = Math.min(seen.rank, rank);
      return;
    }
    ranked.push({ homepage, rank, order: ranked.length });
  };
  const pages = [...sources, ...dossier.map((url) => ({ url, title: null }))];
  for (const p of pages) {
    const host = hostOf(p.url);
    if (!host || neverCompanySite(host)) continue;
    const fit = hostFit(host, name);
    if (fit === "exact") add(p.url, 0);
    else if (fit === "loose" && (p.title === null || namesCompany(p.title, name, { share: 1 }))) add(p.url, 1);
    else if (
      p.title &&
      namesCompany(p.title, name, { share: 1 }) &&
      domainLabel(host).label === `hello${normalizeCompanyKey(name).replace(/\s+/g, "")}`
    )
      add(p.url, 1);
  }
  const counts = new Map<string, number>();
  for (const url of dossier) {
    const domain = registrableDomain(url);
    if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  // A site's own front page or about page among them: a portal's two articles (finance.sina.com.cn,
  // eu.36kr.com) are not the company's site, however often the dossier quoted them.
  const ownPages = new Set(dossier.filter((url) => OWN_SITE_PATH.test(pathOf(url))).map((url) => registrableDomain(url)));
  for (const url of dossier) {
    const host = hostOf(url);
    const domain = registrableDomain(url);
    if (!host || !domain || neverCompanySite(host) || NEWS_HOST.test(domain)) continue;
    if ((counts.get(domain) ?? 0) < 2 || !ownPages.has(domain)) continue;
    add(url, 2);
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, max)
    .map((r) => r.homepage);
}

/** The paths a company's own site has and a publisher's does not: the front page, about, team, product. */
const OWN_SITE_PATH =
  /^\/?$|^\/(about|about-us|about-[^/]+|company|team|our-[^/]+|who-we-are|platform|products?|solutions)(\.html?)?(\/|$)/i;

/** A markdown link: its visible text and its target. */
const MARKDOWN_LINK = /\[([^\]]{0,200})\]\((https?:\/\/[^\s)]+)\)/g;

/** What one press page's links say about the company's site: the homepages it points to, best first. */
export function pressLinks(markdown: string, pageUrl: string, name: string): string[] {
  const own = registrableDomain(pageUrl);
  const firstWord = normalizeCompanyKey(name).split(" ")[0] ?? "";
  const aboutAt = firstWord ? markdown.toLowerCase().search(new RegExp(`about\\s+${firstWord}`)) : -1;
  const scored = new Map<string, number>();
  for (const m of markdown.matchAll(MARKDOWN_LINK)) {
    const [, text, url] = m;
    const host = hostOf(url);
    if (!host || registrableDomain(host) === own || neverCompanySite(host)) continue;
    const fit = hostFit(host, name);
    let path = "";
    try {
      path = new URL(url).pathname.replace(/\/+$/, "");
    } catch {
      continue;
    }
    // A link to a site's root or one level down: a company links its homepage, a publisher links an article.
    const shallow = path.split("/").filter(Boolean).length <= 1;
    const anchor = text.replace(/[*_`]/g, "").trim();
    const anchorIsHost = hostOf(`https://${anchor.replace(/^https?:\/\//, "")}`) === host;
    let score = 0;
    if (fit === "exact") score = 4;
    else if (shallow && namesCompany(anchor, name, { share: 1 })) score = 3;
    else if (fit === "loose") score = 2;
    else if (shallow && anchorIsHost && aboutAt >= 0 && (m.index ?? 0) > aboutAt) score = 1;
    if (score === 0 || NEWS_HOST.test(fit ? "" : host)) continue;
    const homepage = homepageOf(url);
    if (homepage) scored.set(homepage, Math.max(scored.get(homepage) ?? 0, score));
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
}

/** The round's pages worth reading for links: wire releases first, then single-story pages that name the company. */
export function pressPages(name: string, sources: Array<{ url: string; title: string | null }>, max = 2): string[] {
  const wires = sources.filter((s) => WIRE_HOST.test(hostOf(s.url)));
  const stories = sources.filter(
    (s) =>
      !WIRE_HOST.test(hostOf(s.url)) &&
      !neverCompanySite(hostOf(s.url)) &&
      !hostFit(hostOf(s.url), name) &&
      namesCompany(s.title, name, { share: 1 }) &&
      !ROUNDUP_TITLE.test(s.title ?? ""),
  );
  return [...new Set([...wires, ...stories].map((s) => s.url))].slice(0, max);
}

/** Whether a search listing on the domain names the company today and is not a parked page. */
export function listingNamesCompany(listing: Listing | undefined, name: string): boolean {
  if (!listing) return false;
  const text = `${listing.title ?? ""} ${listing.description ?? ""}`;
  if (/\b(for sale|domain parking|parked|buy this domain)\b/i.test(text)) return false;
  return namesCompany(listing.title, name, { share: 1 }) || namesCompany(listing.title, searchName(name), { share: 1 });
}

/** A link on the homepage to its own about page, the small page an identity check can read when the homepage is too big. */
export function aboutLink(links: string[] | undefined, homepage: string): string | null {
  if (!links) return null;
  const domain = registrableDomain(homepage);
  const onSite = links.filter((l) => registrableDomain(l) === domain);
  const path = (l: string) => {
    try {
      const u = new URL(l);
      return { host: u.hostname.replace(/^www\./, ""), path: u.pathname.toLowerCase().replace(/\/+$/, "") };
    } catch {
      return null;
    }
  };
  const rank = (l: string): number => {
    const p = path(l);
    if (!p) return 99;
    if (/^\/(about-us|about|company|who-we-are|our-story|about-[a-z-]+)$/.test(p.path)) return p.path.startsWith("/about") ? 0 : 1;
    if (p.host.startsWith("about.") && /^(\/about[-a-z]*(\/default\.aspx)?|)$/.test(p.path)) return 0;
    return 99;
  };
  const best = onSite.map((l) => ({ l, r: rank(l) })).filter((x) => x.r < 99);
  best.sort((a, b) => a.r - b.r);
  return best[0]?.l ?? null;
}

/** Scrapes one enrichment may spend on homepages: the record's website and the search's candidates together. */
export const MAX_HOMEPAGE_SCRAPES = 3;

/** Scrapes one enrichment may spend on the store's own evidence and press-release links. */
export const MAX_EVIDENCE_SCRAPES = 3;

export interface EnrichResult {
  enrichments: Enrichment[];
  creditsEstimated: number;
}

export interface EnrichOptions {
  concurrency?: number;
  /** Read the pricing page when the homepage links one. Off at the Lite rung. */
  pricingPage?: boolean;
}

export async function enrichCompanies(client: Firecrawl, companies: EnrichInput[], options: EnrichOptions = {}): Promise<EnrichResult> {
  const { concurrency = 6, pricingPage = true } = options;
  let searches = 0;
  let pages = 0;
  // Markdown reads of press pages for their links: the base page, no JSON.
  let linkReads = 0;
  const enrichments = await mapLimit(companies, concurrency, async (c): Promise<Enrichment> => {
    // The website lands on the row once a homepage verifies, or is kept without a verdict (an
    // unreadable host, or an exact-name host refused over wording); a thrown search leaves it null.
    const row: Enrichment = {
      company_key: c.company_key,
      company_website: null,
      website_source: c.company_website ? "record" : "none",
      logo_url: null,
      brand: null,
      context: contextFields(c),
      refused_hosts: [],
      unreadable_hosts: [],
      profile: null,
      pricing_page_url: null,
      pricing: null,
    };
    try {
      // onlyMainContent false on purpose: pricing links live in nav and footer. The branding format
      // rides on the same read (the rate card lists no surcharge for it) and returns the logo file.
      // The JSON format carries the identity prompt, so the same read says whether this is our company.
      const basePrompt = identityPrompt(c);
      /** The prompt for one candidate: a host that spells only part of the name is asked about a parent too. */
      const promptFor = (url: string) =>
        hostFit(hostOf(url), c.company_name) === "loose" ? identityPrompt(c, { shortName: domainLabel(hostOf(url)).label }) : basePrompt;
      const scrapeHome = (url: string) =>
        client.scrape(url, {
          formats: ["links", "branding", { type: "json", schema: companyJsonSchema, prompt: promptFor(url) }],
          onlyMainContent: false,
          timeout: 60_000,
        });
      type Home = Awaited<ReturnType<typeof scrapeHome>>;
      /** Where a candidate came from: the record, the store's own evidence, or a search result. */
      type Origin = "record" | "sources" | "search";
      type Attempt = { url: string; host: string; reason: string; origin: Origin };
      // Every host read and refused (a namesake or parked), for the error when nothing verifies.
      const tried: Array<Attempt & { parked: boolean }> = [];
      // Hosts the scrape could not read: unknown rather than refused, so the first stays on the row.
      const unreadable: Attempt[] = [];
      // An exact-name host the model refused without naming a different business: kept, profile withheld.
      const doubted: Attempt[] = [];
      const all = () => [...tried, ...unreadable, ...doubted];
      // Candidates only the bare name's search offered, with none of the record's words behind them.
      const nameOnly = new Set<string>();
      // The search's cap counts the record's website too, as it always has; the store's evidence and the
      // Evidence has its own budget, so namesake-heavy searches cannot use up its reads.
      const searchAttempts = () => all().filter((a) => a.origin === "record" || a.origin === "search").length;
      const evidenceAttempts = () => all().filter((a) => a.origin === "sources").length;
      const already = (url: string) => {
        const domain = registrableDomain(url) ?? hostOf(url);
        return all().some((a) => (registrableDomain(a.url) ?? a.host) === domain);
      };
      type Verified = {
        url: string;
        home: Home;
        profile: CompanyProfile;
        origin: Origin;
        basis: "homepage" | "about_page";
        about?: string;
      };
      /**
       * A homepage too large for the extraction comes back with its links and no JSON ("Your input
       * exceeds the context window", as wonder.com and twelvelabs.io did). Its own about page is small
       * and says the same thing, so the identity check reads that instead.
       */
      const readAbout = async (home: Home, url: string): Promise<{ profile: CompanyProfile; about: string } | null> => {
        const about = aboutLink(home.links, url);
        if (!about) return null;
        try {
          const page = await client.scrape(about, {
            formats: [{ type: "json", schema: companyJsonSchema, prompt: promptFor(url) }],
            onlyMainContent: true,
            timeout: 60_000,
          });
          pages++;
          const parsed = CompanyProfile.safeParse(page.json);
          return parsed.success ? { profile: parsed.data, about } : null;
        } catch {
          return null;
        }
      };
      /** Read one candidate; the verified page with its profile, or null with the outcome recorded. */
      const verify = async (url: string, origin: Origin): Promise<Verified | null> => {
        const host = hostOf(url) || url;
        let home: Home;
        try {
          home = await scrapeHome(url);
        } catch (err) {
          unreadable.push({ url, host, origin, reason: `scrape failed: ${err instanceof Error ? err.message : String(err)}` });
          return null;
        }
        pages++;
        if (looksParked(home.links, home.metadata?.title)) {
          tried.push({ url, host, origin, reason: "domain appears parked or for sale", parked: true });
          return null;
        }
        let basis: Verified["basis"] = "homepage";
        let aboutUrl: string | undefined;
        let profile: CompanyProfile | null = null;
        const parsed = CompanyProfile.safeParse(home.json);
        if (parsed.success) profile = parsed.data;
        else {
          const about = await readAbout(home, url);
          if (about) {
            profile = about.profile;
            basis = "about_page";
            aboutUrl = about.about;
          }
        }
        if (!profile) {
          unreadable.push({ url, host, origin, reason: "no profile extracted" });
          return null;
        }
        const brandName = home.branding?.brandName?.trim();
        if (brandNamesOtherEntity(brandName, c.company_name) || brandDisownsHost(host, brandName, c.company_name)) {
          tried.push({ url, host, origin, reason: `the site's own name is ${brandName}, not ${c.company_name}`, parked: false });
          return null;
        }
        if (!profile.same_company) {
          const reason = profile.identity_reason || `not ${c.company_name}`;
          // The benefit of the doubt for an exact-name host: the record described the company, the
          // host is its name, and the model could not say what other business this is. That is a
          // wording quibble (Zenergize: "sells inverters", record says "SiC power electronics"), so
          // the website stays and the profile waits for a verdict; a named namesake is still refused.
          if (c.company_description?.trim() && hostMatchesCompany(host, c.company_name) && !namesDifferentBusiness(profile)) {
            doubted.push({ url, host, origin, reason });
            return null;
          }
          tried.push({ url, host, origin, reason, parked: false });
          return null;
        }
        return { url, home, profile, origin, basis, about: aboutUrl };
      };
      const describe = (list: Attempt[], reason?: string) => list.map((t) => `${t.host} (${reason ?? t.reason})`).join("; ");
      /** The row when nothing verified: the first kept host stays on it, with its source and no profile. */
      const unresolved = (): Enrichment => {
        row.refused_hosts = tried.map((t) => t.host);
        row.unreadable_hosts = unreadable.map((t) => t.host);
        // The record's own website outranks a search candidate; otherwise the first host kept. A host
        // only the bare name's search offered is no better than a guess when it cannot be read: hive.com,
        // a project-management tool, would have landed on HIVE, a London maker of machine brains.
        const keepable = [...unreadable.filter((u) => !nameOnly.has(u.url)), ...doubted];
        const kept = keepable.find((k) => k.url === c.company_website) ?? keepable[0] ?? null;
        if (kept) {
          row.company_website = kept.url;
          row.website_source = kept.origin;
        } else {
          row.website_source = tried.length === 0 ? "none" : tried.every((t) => t.parked) ? "parked" : "unverified";
        }
        const parts = [
          tried.length > 0 ? `no homepage verified as ${c.company_name}: ${describe(tried)}` : null,
          unreadable.length > 0 ? describe(unreadable, "could not be read") : null,
          doubted.length > 0 ? `kept without a verdict on the name host: ${describe(doubted)}` : null,
        ].filter((p): p is string => p !== null);
        if (parts.length > 0) row.error = parts.join("; ");
        return row;
      };

      let verified: Verified | null = null;
      // The company's own announcement is stronger identity evidence than a search result that
      // merely spells its name, so try the store's own pages before the existing record website.
      // The homepages the store's own evidence names: the company's pages among its rounds' and
      // its dossier's sources. They came from pages about this company, so no record context is needed
      // to look; the homepage read still decides.
      if (!verified) {
        for (const url of siteCandidates(c.company_name, c.source_pages, c.dossier_sources)) {
          if (evidenceAttempts() >= MAX_EVIDENCE_SCRAPES) break;
          if (already(url)) continue;
          verified = await verify(url, "sources");
          if (verified) break;
        }
      }
      if (!verified && c.company_website) verified = await verify(c.company_website, "record");
      if (!verified && !hasContext(c)) {
        // Nothing to check a search result against: a namesake would pass, so no search is made.
        unresolved();
        row.error = [row.error, "no description, evidence, headline, city, or sector on the record to verify a search result against"]
          .filter(Boolean)
          .join("; ");
        return row;
      }
      const listings = new Map<string, Listing>();
      const linkedBy = new Map<string, string>();
      if (!verified) {
        searches++;
        // A host that spells only part of the name needs a record that says what the company does:
        // with only a name to judge on, thehive.ai passes for any Hive.
        const loose = Boolean(c.company_description?.trim());
        const grounded = await searchWebsites(client, c, 3, { loose });
        for (const [k, v] of grounded.listings) listings.set(k, v);
        let candidates = grounded.homepages.filter((u) => !already(u));
        // The grounded query is built from the record's words, and a record known only by a funding
        // sentence ("OpenAI to raise $40 billion in SoftBank-led round") makes a news query whose five
        // results are all articles. With no homepage offered at all, the name's own search gets a turn;
        // what it finds still has to pass the same identity check against the same record.
        if (candidates.length === 0 && searchAttempts() < MAX_HOMEPAGE_SCRAPES) {
          searches++;
          const named = await searchWebsites(client, { company_name: c.company_name }, 3, { loose });
          for (const [k, v] of named.listings) if (!listings.has(k)) listings.set(k, v);
          candidates = named.homepages.filter((u) => !already(u));
          for (const u of candidates) nameOnly.add(u);
        }
        for (const url of candidates) {
          if (searchAttempts() >= MAX_HOMEPAGE_SCRAPES) break;
          verified = await verify(url, "search");
          if (verified) break;
        }
      }
      // A press release names the company's site in its first line or its "About" paragraph: the
      // round's own wire release, or a single story that names the company, is read for its links
      // (a markdown read, one credit) when nothing has verified yet.
      if (!verified) {
        for (const page of pressPages(c.company_name, c.source_pages ?? [])) {
          let markdown = "";
          try {
            const read = await client.scrape(page, { formats: ["markdown"], onlyMainContent: true, timeout: 60_000 });
            markdown = read.markdown ?? "";
          } catch {
            continue;
          } finally {
            linkReads++;
          }
          const linked = pressLinks(markdown, page, c.company_name);
          for (const url of linked) {
            const domain = registrableDomain(url);
            if (domain && !linkedBy.has(domain)) linkedBy.set(domain, page);
          }
          for (const url of linked) {
            if (verified || evidenceAttempts() >= MAX_EVIDENCE_SCRAPES) break;
            if (already(url)) continue;
            verified = await verify(url, "sources");
          }
          if (verified) break;
        }
      }
      if (!verified) {
        // A homepage that could not be read is confirmed only by two things that do not depend on
        // reading it: the round's own pages place the company on the domain (its announcement is
        // published there, or its press release links it), and a search listing on the domain names the
        // company today, so the domain has not lapsed or been parked since. A listing alone is only a
        // name, which a namesake shares; a link alone may be years old. Nothing is read off the site, so
        // no profile, logo, or description is written.
        for (const u of unreadable) {
          const domain = registrableDomain(u.url);
          if (!domain) continue;
          const ownPage = (c.source_pages ?? []).find(
            (p) => registrableDomain(p.url) === domain && namesCompany(p.title, c.company_name, { share: 1 }),
          );
          const linkPage = linkedBy.get(domain);
          const listing = [...listings.entries()].find(([home]) => registrableDomain(home) === domain)?.[1];
          if ((ownPage || linkPage) && listingNamesCompany(listing, c.company_name)) {
            row.company_website = u.url;
            row.website_source = u.origin;
            row.identity_basis = "linked";
            row.identity_evidence = [ownPage?.url ?? linkPage, listing?.url].filter((x): x is string => !!x);
            row.refused_hosts = tried.map((t) => t.host);
            row.unreadable_hosts = unreadable.map((t) => t.host);
            return row;
          }
        }
        return unresolved();
      }
      row.website_source = verified.origin;
      row.identity_basis = verified.basis;
      if (verified.about) row.identity_evidence = [verified.about];
      row.refused_hosts = tried.map((t) => t.host);
      row.unreadable_hosts = unreadable.map((t) => t.host);
      const { url: website, home, profile } = verified;
      row.company_website = website;
      row.brand = brandFrom(home.branding, website);
      row.logo_url = homepageLogo(home, website);
      row.profile = profile;
      row.pricing_page_url = pricingLink(home.links, website);
      if (row.pricing_page_url && pricingPage) {
        const pricing = await client.scrape(row.pricing_page_url, {
          formats: [{ type: "json", schema: pricingJsonSchema }],
          onlyMainContent: true,
          timeout: 60_000,
        });
        pages++;
        const parsed = PricingProfile.safeParse(pricing.json);
        row.pricing = parsed.success ? parsed.data : null;
      }
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    }
    return row;
  });
  return { enrichments, creditsEstimated: searches * searchCredits(5) + extractionCredits(pages) + linkReads * RATE.scrapePage };
}
