// The canonical store. One Postgres dialect everywhere: PGlite locally, Neon deployed.
// Table file doubles as the ERD; drizzle-kit emits the DDL from it.

import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { Preset } from "../presets/types.ts";
import type { RoundCertainty } from "../records/certainty.ts";
import { AMOUNT_KINDS, STAGES } from "../records/schema.ts";

export const stageEnum = pgEnum("stage", STAGES);
export const amountKindEnum = pgEnum("amount_kind", AMOUNT_KINDS);
export const recordStatusEnum = pgEnum("record_status", ["new", "updated", "seen"]);
export const dispositionEnum = pgEnum("disposition", ["publish", "flagged", "review", "rejected"]);
export const investorRoleEnum = pgEnum("investor_role", ["lead", "participant", "unknown"]);
export const aliasKindEnum = pgEnum("alias_kind", ["name", "domain", "linkedin"]);
export const enrichmentKindEnum = pgEnum("enrichment_kind", ["profile", "pricing", "founders", "deep_dive", "alexandria", "apollo"]);
export const deliveryChannelEnum = pgEnum("delivery_channel", ["slack", "webhook", "email"]);
export const deliveryStatusEnum = pgEnum("delivery_status", ["pending", "sent", "failed", "dead_letter"]);

export const cronLeases = pgTable(
  "cron_leases",
  {
    route: text("route").notNull(),
    tick: timestamp("tick", { withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.route, t.tick] })],
);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const companies = pgTable(
  "companies",
  {
    id: text("id").primaryKey(), // normalized name key, or domain when known
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    domain: text("domain"),
    linkedinSlug: text("linkedin_slug"),
    website: text("website"),
    /** Favicon or brand image from the company's own homepage, captured by the enrichment scrape. */
    logoUrl: text("logo_url"),
    description: text("description"),
    hq: text("hq"),
    sector: text("sector"),
    ownerId: text("owner_id"), // nullable now; multi-user later without a migration rewrite
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [uniqueIndex("companies_domain_idx").on(t.domain), index("companies_name_key_idx").on(t.nameKey)],
);

export const companyAliases = pgTable(
  "company_aliases",
  {
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id),
    kind: aliasKindEnum("kind").notNull(),
    aliasKey: text("alias_key").notNull(),
    alias: text("alias").notNull(),
    sourceUrl: text("source_url"),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.kind, t.aliasKey] })],
);

/** Verified company-owned sections, discovered from the homepage or a mapped linked site. */
export const companyNewsrooms = pgTable(
  "company_newsrooms",
  {
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id),
    url: text("url").notNull(),
    monitorId: text("monitor_id"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.url] }), index("company_newsrooms_checked_idx").on(t.checkedAt)],
);

/** Discovery attempts also rest when no newsroom was found. */
export const companyNewsroomScans = pgTable("company_newsroom_scans", {
  companyId: text("company_id")
    .primaryKey()
    .references(() => companies.id),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull(),
});

export const fundingRounds = pgTable(
  "funding_rounds",
  {
    id: text("id").primaryKey(), // company_key:stage:announced_date
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id),
    presetSlug: text("preset_slug").notNull(),
    stage: stageEnum("stage").notNull(),
    stageAsWritten: text("stage_as_written").notNull(),
    isExtension: boolean("is_extension").notNull().default(false),
    amountValue: numeric("amount_value", { precision: 18, scale: 3 }), // millions of amountCurrency
    amountCurrency: text("amount_currency"),
    amountAsWritten: text("amount_as_written"),
    amountUsdMillions: numeric("amount_usd_millions", { precision: 18, scale: 3 }),
    fxRate: numeric("fx_rate", { precision: 18, scale: 8 }),
    fxDate: text("fx_date"),
    valuationAsWritten: text("valuation_as_written"),
    /** Every reading's valuation with the sentence and page that state it (records/valuation.ts); the column above is the one they support. */
    valuationClaims: jsonb("valuation_claims").$type<Array<{ value: string; quote: string | null; url: string; tier: number }>>(),
    /** A larger total the page states beside the new money (a series' running total), with its sentence; never the amount, never a valuation. */
    financingTotalAsWritten: text("financing_total_as_written"),
    financingTotalQuote: text("financing_total_quote"),
    /** What the amount covers: tranche, round, or financing_total. */
    amountScope: text("amount_scope"),
    financingStages: jsonb("financing_stages").$type<string[]>(),
    announcedOn: text("announced_on"), // YYYY-MM-DD; null when undated
    certainty: text("certainty").$type<RoundCertainty>().notNull().default("announced"),
    reportedOn: text("reported_on"),
    datePrecision: text("date_precision").notNull().default("unknown"),
    /** Where the day came from: stated by the text, the page's byline, a URL, a search result, or none. Lets a later pass know whether a sibling source may move it. */
    dateBasis: text("date_basis"),
    /** Earliest-report search completed against this day, before the row could become visible. */
    freshnessCheckedOn: text("freshness_checked_on"),
    headquarters: text("headquarters"),
    sector: text("sector"),
    evidenceQuotes: jsonb("evidence_quotes").$type<string[]>().notNull().default([]),
    confidence: numeric("confidence", { precision: 4, scale: 2 }).notNull().default("0"),
    /** The judge's verdict against the primary page: status, notes, and the URL read. Null until judged. */
    verification: jsonb("verification").$type<{ status: string; notes: string[]; url: string | null }>(),
    status: recordStatusEnum("status").notNull().default("new"),
    disposition: dispositionEnum("disposition").notNull().default("review"),
    /**
     * An earlier round promoted from a checked dossier (lib/history.ts), verified against its own
     * announcement like any row, at its real date. Never delivered, never unread, never trending,
     * and left out of the feed's default view; company and investor pages list it.
     */
    history: boolean("history").notNull().default(false),
    /**
     * Why the row is held from delivery, or null. Set when a history or lead source (an Apollo funding
     * event, a dossier's prior round, a verified earlier row) reports the same round more than 45 days
     * before a day the company never stated: the row is a late re-report until a person says otherwise
     * (lib/late-report.ts). A held row is never delivered, and no reading moves its disposition.
     */
    hold: text("hold"),
    /** The publication audit's last verdict on this row (lib/publication-audit.ts). */
    audit: jsonb("audit").$type<{ status: "pass" | "fail" | "human"; model?: string; at?: string; reasons?: string[]; summary?: string }>(),
    /** The fingerprint of the facts the passing audit judged; the trigger compares it on every write. */
    auditFacts: text("audit_facts"),
    /** The disposition a row asked for while the publication gate holds it in review for its audit. */
    pendingDisposition: dispositionEnum("pending_disposition"),
    /**
     * Facts a person set by hand (`pnpm fix-records`: a redate's day, a restage's stage) with the page
     * that states them. No later reading, read-back, merge, or maintenance pass moves a pinned fact:
     * bluecore-energy's hand-checked Sep 8 was back at a trade republication's Sep 22 a day later.
     */
    pinned: jsonb("pinned").$type<{ announced_on?: string; stage?: string; valuation?: string | null }>(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    index("funding_rounds_company_idx").on(t.companyId),
    index("funding_rounds_announced_idx").on(t.announcedOn),
    index("funding_rounds_status_idx").on(t.status),
    index("funding_rounds_preset_idx").on(t.presetSlug),
    // The published rows in the feed's two orders (announced or amount, desc nulls last, then id),
    // so the first page, the landing glimpse, and the weekly counts walk an index instead of
    // sorting every visible row. The plain announced index above runs asc, which cannot serve
    // "desc nulls last". Partial: review and rejected rows never appear in these reads.
    index("funding_rounds_visible_announced_idx")
      .on(t.announcedOn.desc().nullsLast(), t.id.desc().nullsFirst())
      .where(sql`${t.disposition} in ('publish', 'flagged')`),
    index("funding_rounds_visible_amount_idx")
      .on(t.amountUsdMillions.desc().nullsLast(), t.id.desc().nullsFirst())
      .where(sql`${t.disposition} in ('publish', 'flagged')`),
  ],
);

export const investors = pgTable("investors", {
  id: text("id").primaryKey(), // normalized name key
  name: text("name").notNull(),
  /** Registrable domain of the investor's own site ("a16z.com"), the key its logo is fetched by; null when unknown. */
  domain: text("domain"),
  /**
   * When a search last looked for the domain. A miss leaves the domain null with this set, so the
   * next run does not pay for the same search again; a retry is an explicit choice (`retryAfterDays`).
   */
  domainCheckedAt: timestamp("domain_checked_at", { withTimezone: true }),
  /** The logo the branding format read off the investor's homepage, else that page's favicon; absolute. Null until read. */
  logoUrl: text("logo_url"),
  /**
   * When a branding scrape last read the homepage at `domain`. A page with no logo leaves logo_url
   * null with this set, so the scrape is paid for once; a new domain clears both.
   */
  logoCheckedAt: timestamp("logo_checked_at", { withTimezone: true }),
  /**
   * What kind of investor (INVESTOR_TYPES in investor-domain.ts): the homepage verdict's kind when a
   * site verified, "person" when the name reads as an individual and no firm's site claimed it. Null
   * until the resolver has looked.
   */
  kind: text("kind"),
  /** One sentence from the investor's own homepage on what it does; null when the site does not say. */
  description: text("description"),
  /** Headquarters exactly as the investor's own homepage states it; null when it does not. */
  headquarters: text("headquarters"),
  createdAt: timestamps.createdAt,
});

export const roundInvestors = pgTable(
  "round_investors",
  {
    roundId: text("round_id")
      .notNull()
      .references(() => fundingRounds.id, { onDelete: "cascade" }),
    investorId: text("investor_id")
      .notNull()
      .references(() => investors.id),
    role: investorRoleEnum("role").notNull().default("unknown"),
  },
  // The key leads with the round; an investor's page, the directory, and the palette look up by investor.
  (t) => [primaryKey({ columns: [t.roundId, t.investorId] }), index("round_investors_investor_idx").on(t.investorId)],
);

export const sources = pgTable(
  "sources",
  {
    id: text("id").primaryKey(), // canonical URL
    url: text("url").notNull(),
    host: text("host").notNull(),
    title: text("title"),
    publishedAt: text("published_at"),
    query: text("query"),
    runId: text("run_id"),
    rawExtraction: jsonb("raw_extraction"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // fetched_at: the overview's top sources read a window of recent pages.
  (t) => [index("sources_host_idx").on(t.host), index("sources_fetched_idx").on(t.fetchedAt)],
);

export const pageSnapshots = pgTable(
  "page_snapshots",
  {
    hash: text("hash").primaryKey(),
    markdown: text("markdown").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("page_snapshots_created_idx").on(t.createdAt)],
);

export const pageSnapshotReads = pgTable(
  "page_snapshot_reads",
  {
    sourceUrl: text("source_url").notNull(),
    snapshotHash: text("snapshot_hash")
      .notNull()
      .references(() => pageSnapshots.hash),
    rawExtraction: jsonb("raw_extraction"),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sourceUrl, t.snapshotHash] }), index("page_snapshot_reads_at_idx").on(t.readAt)],
);

export const roundSources = pgTable(
  "round_sources",
  {
    roundId: text("round_id")
      .notNull()
      .references(() => fundingRounds.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    fieldClaims: jsonb("field_claims").$type<Record<string, unknown>>(),
  },
  // The key leads with the round; a preset's source count and the repair passes look up by source.
  (t) => [primaryKey({ columns: [t.roundId, t.sourceId] }), index("round_sources_source_idx").on(t.sourceId)],
);

/** A visible round is searched again at fixed offsets from first sight, unless independent evidence completes it sooner. */
export const roundVerification = pgTable(
  "round_verification",
  {
    roundId: text("round_id")
      .primaryKey()
      .references(() => fundingRounds.id, { onDelete: "cascade" }),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    claimedBy: text("claimed_by"),
    credits: integer("credits").notNull().default(0),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [index("round_verification_due_idx").on(t.status, t.nextAttemptAt)],
);

export const enrichments = pgTable(
  "enrichments",
  {
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id),
    kind: enrichmentKindEnum("kind").notNull(),
    data: jsonb("data").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    sourceUrl: text("source_url"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.kind] })],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    presetSlug: text("preset_slug").notNull(),
    lane: text("lane").notNull(), // sweep | agent | monitor | enrich
    window: text("window"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    creditsEstimated: integer("credits_estimated"),
    creditsMeasured: integer("credits_measured"),
    counts: jsonb("counts").$type<Record<string, number>>(),
    error: text("error"),
  },
  // Every read of runs is the newest first or a recent window: the last run, the day's count, Runs.
  (t) => [index("runs_started_idx").on(t.startedAt)],
);

export const presetMonitors = pgTable("preset_monitors", {
  presetSlug: text("preset_slug").primaryKey(),
  monitorId: text("monitor_id").notNull(),
  estimatedCreditsPerMonth: integer("estimated_credits_per_month"),
  createdAt: timestamps.createdAt,
});

/** Webhook intake, keyed on Firecrawl's payload id. Replay defense lives here (signatures carry no timestamp). */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb("payload").notNull(),
});

/** URLs the monitor alerted on, unique per monitor. Only a fresh insert starts extraction. */
export const candidates = pgTable(
  "candidates",
  {
    monitorId: text("monitor_id").notNull(),
    url: text("url").notNull(),
    checkId: text("check_id"),
    judgeReason: text("judge_reason"),
    status: text("status").notNull().default("pending"), // pending | extracted | failed
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.monitorId, t.url] })],
);

/** Fan-out outbox: one row per (record, channel). A duplicate step run sees `sent` and exits. */
export const deliveries = pgTable(
  "deliveries",
  {
    roundId: text("round_id")
      .notNull()
      .references(() => fundingRounds.id, { onDelete: "cascade" }),
    channel: deliveryChannelEnum("channel").notNull(),
    target: text("target").notNull(), // webhook url, slack channel, email
    status: deliveryStatusEnum("status").notNull().default("pending"),
    deliveredCertainty: text("delivered_certainty"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.roundId, t.channel, t.target] })],
);

/** Where new records go: a Slack incoming webhook, a Standard Webhooks endpoint, an email. */
export const deliveryTargets = pgTable("delivery_targets", {
  id: text("id").primaryKey(),
  channel: deliveryChannelEnum("channel").notNull(),
  target: text("target").notNull(),
  slackTeamId: text("slack_team_id"),
  slackBotUserId: text("slack_bot_user_id"),
  slackUserId: text("slack_user_id"),
  label: text("label"),
  /** Standard Webhooks signing secret (whsec_...), shown once at creation. */
  secret: text("secret"),
  presetSlug: text("preset_slug"), // null: every preset
  minConfidence: numeric("min_confidence", { precision: 4, scale: 2 }).notNull().default("0.5"),
  includeExpected: boolean("include_expected").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  ...timestamps,
});

/** Opaque, revocable tokens that gate feed URLs. Stored hashed. */
export const feedTokens = pgTable("feed_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  label: text("label"),
  presetSlug: text("preset_slug"),
  includeExpected: boolean("include_expected").notNull().default(false),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamps.createdAt,
});

/** Presets created in the UI, the same shape as a presets/ file. On a slug collision the file wins. */
export const customPresets = pgTable("custom_presets", {
  slug: text("slug").primaryKey(),
  definition: jsonb("definition").$type<Preset>().notNull(),
  ...timestamps,
});

/**
 * Resolver aliases taught from the review queue: alias company key -> canonical company key.
 * The committed seed lives in rules/aliases.json; these rows are what reviewers add on a
 * deployed instance, where the filesystem is read-only. Distinct from company_aliases, which
 * records the name variants seen for one company.
 */
export const aliasRules = pgTable("alias_rules", {
  aliasKey: text("alias_key").primaryKey(),
  canonicalKey: text("canonical_key").notNull(),
  createdAt: timestamps.createdAt,
});

/** Instance-wide settings, one JSON value per key. `coverage` holds the rung and its overrides. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamps.updatedAt,
});

/** A dossier's prior round as it was queued: the four fields the dossier states, as written. */
export interface HistoryPrior {
  stage_as_written: string;
  amount_as_written: string | null;
  announced_date: string | null;
  lead_investors: string[];
  /** The page a lead named for the round (Apollo's news link): read first, never trusted on its own. */
  source_url?: string | null;
}

/**
 * Where a ledger row's prior round came from: a checked dossier; or a lead, which needs no dossier and
 * is never a fact until a page states it: an Apollo funding event, a prior round the dossier check
 * dropped only for want of evidence among the pages it read ("check"), or a hand-checked round from an
 * audit with the page that states it ("audit", queued by `pnpm fix-records`).
 */
export type HistoryOrigin = "dossier" | "apollo" | "check" | "audit" | "search" | "gap" | "page";

/**
 * One prior round of one company (from its checked dossier, or an Apollo lead) and what became of it: queued, being worked,
 * promoted to a round (history), no source found, or failed and waiting out its backoff. Keyed on
 * the prior round's own words, so a dossier saved again with the same rounds queues nothing new.
 * The rows go with their company (a reset, a fold that deletes the row it folded).
 */
export const historyPromotions = pgTable(
  "history_promotions",
  {
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** The prior round's stage, amount, and date as written, normalized (packages/core/src/records/history.ts priorKey). */
    priorKey: text("prior_key").notNull(),
    prior: jsonb("prior").$type<HistoryPrior>().notNull(),
    /** dossier | apollo | check | audit | search | gap: kept so a lead's yield can be measured apart from the dossiers'. */
    origin: text("origin").$type<HistoryOrigin>().notNull().default("dossier"),
    /** pending | running | promoted | no_source | failed | skipped */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    /** When a pending or failed row is next due; for a running row, when its claim lapses. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    /** Who holds a running row: two passes over one company never search the same prior round twice. */
    claimedBy: text("claimed_by"),
    /** The round the promotion wrote or merged into. */
    roundId: text("round_id"),
    sourceUrl: text("source_url"),
    /** What the last attempt saw: the query, the pages tried, why a page was refused, the disposition. */
    outcome: jsonb("outcome").$type<Record<string, unknown>>(),
    credits: integer("credits").notNull().default(0),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.companyId, t.priorKey] }), index("history_promotions_due_idx").on(t.status, t.nextAttemptAt)],
);

/** A Hacker News story the Trending lane matched to a round, as Algolia returned it. */
export interface TrendingHnStory {
  id: string;
  title: string;
  url: string | null;
  points: number;
  comments: number;
  /** ISO time the story was posted: its weight decays from here. */
  at: string;
}

/**
 * The Trending lane's state per round it follows (a visible round first seen in the last 72 hours):
 * the company's X handle, which search checkpoints have run, the Hacker News stories, and the
 * latest score with its counts, rank, label, and stale verdict. Rescored every hour from the
 * stored posts, so decay stays current without new searches.
 */
export const trendingRounds = pgTable(
  "trending_rounds",
  {
    roundId: text("round_id")
      .primaryKey()
      .references(() => fundingRounds.id, { onDelete: "cascade" }),
    companyId: text("company_id").notNull(),
    /** The round's first_seen_at when the lane took it up: the 72-hour window and the checkpoints count from here. */
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    /** The company's own X handle, lowercased; null when none was found or verified. */
    xHandle: text("x_handle"),
    /** homepage (a homepage link that verified), search (an account named like the company), none. */
    xHandleSource: text("x_handle_source"),
    handleCheckedAt: timestamp("handle_checked_at", { withTimezone: true }),
    /** Search checkpoints done (first seen, +6h, +24h, +48h): a round is searched at most four times. */
    checkpoints: integer("checkpoints").notNull().default(0),
    searchedAt: timestamp("searched_at", { withTimezone: true }),
    hn: jsonb("hn").$type<TrendingHnStory[]>().notNull().default([]),
    hnCheckedAt: timestamp("hn_checked_at", { withTimezone: true }),
    /** Distinct non-outlet X authors with a relevant post: "people on X". */
    people: integer("people").notNull().default(0),
    /** Distinct outlet or aggregator accounts that posted it, kept out of the score. */
    outletAccounts: integer("outlet_accounts").notNull().default(0),
    /** Distinct press publisher hosts among the round's sources. */
    outlets: integer("outlets").notNull().default(0),
    hnPoints: integer("hn_points").notNull().default(0),
    score: doublePrecision("score").notNull().default(0),
    /** The three decayed sums behind the score, for Runs and the API. */
    signals: jsonb("signals").$type<{ x: number; press: number; hn: number }>(),
    /** Rank by score among the rounds followed that are not stale; null when unscored or stale. */
    rank: integer("rank"),
    label: boolean("label").notNull().default(false),
    /** Most posts naming the company and amount predate the announced day: out of Trending, flagged for re-dating. */
    stale: boolean("stale").notNull().default(false),
    staleReason: text("stale_reason"),
    scoredAt: timestamp("scored_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("trending_rounds_score_idx").on(t.score.desc()), index("trending_rounds_company_idx").on(t.companyId)],
);

/**
 * X posts the Trending lane found for a round: one row per status id (a profile-page hit is keyed
 * by its account), with the author, a snippet, the status-id time, whether the relevance rule kept
 * it, and the likes and reposts once the showcase has read the post.
 */
export const trendingPosts = pgTable(
  "trending_posts",
  {
    roundId: text("round_id")
      .notNull()
      .references(() => fundingRounds.id, { onDelete: "cascade" }),
    /** The status id, or `profile:<handle>` for a profile-page result. */
    postKey: text("post_key").notNull(),
    kind: text("kind").notNull(), // post | profile
    statusId: text("status_id"),
    handle: text("handle"),
    authorName: text("author_name"),
    url: text("url").notNull(),
    snippet: text("snippet").notNull(),
    /** From the status id; for a profile hit, from "N hours ago" when the snippet says. */
    postedAt: timestamp("posted_at", { withTimezone: true }),
    relevant: boolean("relevant").notNull().default(false),
    nameHit: boolean("name_hit").notNull().default(false),
    amountHit: boolean("amount_hit").notNull().default(false),
    isSelf: boolean("is_self").notNull().default(false),
    isOutlet: boolean("is_outlet").notNull().default(false),
    queries: jsonb("queries").$type<string[]>().notNull().default([]),
    likes: integer("likes"),
    reposts: integer("reposts"),
    engagementAt: timestamp("engagement_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.roundId, t.postKey] }), index("trending_posts_handle_idx").on(t.handle)],
);

/**
 * A Slack channel a visitor subscribed through the public Add to Slack (lib/slack-subscriptions.ts).
 * Only what delivery needs is kept: the workspace and channel (ids and names), the incoming webhook
 * encrypted with SLACK_WEBHOOK_KEY (a bearer credential, cleared once the subscription ends), what
 * it receives, and the hash of its manage token. One row per (team, channel): installing into the
 * same channel again updates it. Text columns rather than enums keep the migration idempotent.
 */
export const slackSubscriptions = pgTable(
  "slack_subscriptions",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    botUserId: text("bot_user_id"),
    userId: text("user_id"),
    teamName: text("team_name"),
    channelId: text("channel_id").notNull(),
    channelName: text("channel_name"),
    /** AES-256-GCM, `v1.<iv>.<ciphertext and tag>`; null once revoked or unsubscribed. */
    webhookCiphertext: text("webhook_ciphertext"),
    /** A preset slug, or `all`. */
    presetSlug: text("preset_slug").notNull().default("all"),
    includeExpected: boolean("include_expected").notNull().default(false),
    /** instant | daily */
    cadence: text("cadence").notNull().default("instant"),
    /** sha256 of the manage token; the token itself is derived from the key and never stored. */
    manageTokenHash: text("manage_token_hash").notNull(),
    /** active | paused | revoked */
    status: text("status").notNull().default("active"),
    /** Consecutive failed posts; a success resets it. */
    failureCount: integer("failure_count").notNull().default(0),
    /** Why the last post failed or the subscription was revoked, as a short code; never a URL. */
    lastError: text("last_error"),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    lastDigestAt: timestamp("last_digest_at", { withTimezone: true }),
    lastTestAt: timestamp("last_test_at", { withTimezone: true }),
    /** The UTC day postsToday counts, YYYY-MM-DD: the daily cap resets when it changes. */
    postsDay: text("posts_day"),
    postsToday: integer("posts_today").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("slack_subscriptions_team_channel_idx").on(t.teamId, t.channelId),
    uniqueIndex("slack_subscriptions_manage_idx").on(t.manageTokenHash),
    index("slack_subscriptions_status_idx").on(t.status, t.cadence),
  ],
);

/**
 * The daily accuracy check's flags (lib/accuracy.ts), one per (company, rule): what the rule saw
 * last, when it was first and last seen, and what a person or the run did about it. A flag whose
 * condition no longer holds is cleared, not deleted, so Review can say what cleared; a dismissal
 * covers the subjects it was made on, and a new subject opens the flag again. Admin only: nothing
 * public reads this table. Text columns rather than enums keep the migration idempotent.
 */
export const accuracyFlags = pgTable(
  "accuracy_flags",
  {
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** One of ACCURACY_RULES (packages/core/src/records/accuracy.ts). */
    rule: text("rule").notNull(),
    /** high | medium | low */
    severity: text("severity").notNull(),
    reason: text("reason").notNull(),
    /** The round ids, fields, or names the flag is about, sorted. */
    subjects: jsonb("subjects").$type<string[]>().notNull().default([]),
    /** profile | dossier | history: the remedy the run may start on its own, or null. */
    remedy: text("remedy"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when a run no longer sees the condition; null while it holds. */
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dismissedNote: text("dismissed_note"),
    /** The subjects the dismissal was made on. */
    dismissedSubjects: jsonb("dismissed_subjects").$type<string[]>(),
    /** When the run last started this flag's remedy, and what came of it: a remedy rests a week between tries. */
    remediedAt: timestamp("remedied_at", { withTimezone: true }),
    remedyNote: text("remedy_note"),
    /** Remedies started since the flag opened: past a few, the flag waits for a person rather than paying again. */
    remedyAttempts: integer("remedy_attempts").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.rule] }), index("accuracy_flags_open_idx").on(t.clearedAt, t.dismissedAt)],
);

/**
 * What the accuracy check remembers between runs about a company's dossier: the founders it named
 * and those of the dossier before it, so a new dossier that drops a founder is caught. Keyed on the
 * dossier's own timestamp: the pair moves along only when the dossier is rewritten.
 */
export const accuracyMemory = pgTable("accuracy_memory", {
  companyId: text("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  /** The dossier row's fetched_at the founders below were read from. */
  dossierAt: timestamp("dossier_at", { withTimezone: true }),
  founders: jsonb("founders").$type<string[]>().notNull().default([]),
  /** The founders of the dossier before, or null until one dossier has replaced another. */
  previousFounders: jsonb("previous_founders").$type<string[]>(),
  updatedAt: timestamps.updatedAt,
});

/**
 * The X announcements lane's leads (packages/core/src/trending/announcements.ts): one row per
 * funding post (a status id, or a profile page's account and figure), what the post says, and the
 * search for its article on a backoff to 48 hours. `status` is pending until an article that
 * corroborates it lands the round (corroborated), the store already holds the round (known), the
 * post landed on its own as a flagged record (published, still searched for an article), or the
 * schedule ran out (expired). Text columns rather than enums keep the migration idempotent.
 */
export const announcementLeads = pgTable(
  "announcement_leads",
  {
    key: text("key").primaryKey(),
    kind: text("kind").notNull(), // post | profile
    url: text("url").notNull(),
    handle: text("handle"),
    authorName: text("author_name"),
    via: text("via"),
    company: text("company"),
    companyHandle: text("company_handle"),
    amountAsWritten: text("amount_as_written").notNull(),
    amountValue: doublePrecision("amount_value").notNull(),
    currency: text("currency"),
    usdMillions: doublePrecision("usd_millions"),
    label: text("label").notNull(),
    leadInvestors: jsonb("lead_investors").$type<string[]>().notNull().default([]),
    text: text("text").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    /** pending | corroborated | known | published | expired */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    /** The round the lead became or matched. */
    roundId: text("round_id"),
    articleUrl: text("article_url"),
    /** Article URLs already read for this lead: a later attempt reads only new ones. */
    readUrls: jsonb("read_urls").$type<string[]>().notNull().default([]),
    /** When the company's homepage was read for the account that posted; the answer is `selfVerified`. */
    selfCheckedAt: timestamp("self_checked_at", { withTimezone: true }),
    selfVerified: boolean("self_verified").notNull().default(false),
    note: text("note"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("announcement_leads_due_idx").on(t.status, t.nextAttemptAt)],
);

/**
 * Where a merged-away round went: one row per deleted duplicate, naming the row that absorbed it.
 * Round ids are derived from the reading (company, stage, day), so a later sweep that reads the
 * same page under a preset whose ledger never saw it rebuilds the dropped id; persistRecords maps
 * an incoming id through this table (following chains) before its exact-id match, and no delivery
 * is ever queued for a dropped id. Fearn's `fearn:other:2026-09-24` was merged at 06:05 UTC on
 * 2026-09-25, rebuilt at 15:01, and posted to Slack a second time. No foreign key: the kept id may
 * itself be merged later, and the chain is followed on read.
 */
export const roundMerges = pgTable(
  "round_merges",
  {
    droppedId: text("dropped_id").primaryKey(),
    keptId: text("kept_id").notNull(),
    mergedAt: timestamp("merged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("round_merges_kept_idx").on(t.keptId)],
);

/**
 * The public demo's rate limiter (lib/rate-limit.ts): one row per bucket and client, counting hits in
 * a fixed window. In the store rather than in memory because a serverless deployment runs many
 * short-lived instances, each of which would otherwise keep its own count. The client is a hash of
 * its address, never the address itself; rows older than a day are pruned as the limiter runs.
 */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    hits: integer("hits").notNull().default(0),
  },
  (t) => [index("rate_limits_window_idx").on(t.windowStart)],
);

export type CompanyRequestStatus = "queued" | "running" | "done" | "failed" | "refused";
export type CompanyRequestStep = "website" | "profile" | "history" | "rounds";
/** What the homepage's branding read shows, saved before the identity check so the page has a face; display only. */
export interface CompanyRequestBrand {
  name: string | null;
  logo: string | null;
  color: string | null;
  /** Sibling sites the homepage links (tldraw.dev for tldraw.com), saved as the company's domain aliases once it exists. */
  sites?: string[];
}
/** What became of each earlier round a request's research found: the visitor-safe reason it was not verified. */
export interface CompanyRequestTally {
  found: number;
  verified: number;
  /** `source` names who found the round: the funding search, a gap search, Apollo, or the company dossier. */
  priors: Array<{ label: string; verified: boolean; reason: string | null; source?: string }>;
}

export const companyRequests = pgTable(
  "company_requests",
  {
    id: text("id").primaryKey(),
    domain: text("domain").notNull(),
    submittedUrl: text("submitted_url").notNull(),
    status: text("status").$type<CompanyRequestStatus>().notNull().default("queued"),
    companyId: text("company_id").references(() => companies.id),
    step: text("step").$type<CompanyRequestStep>(),
    tally: jsonb("tally").$type<CompanyRequestTally>(),
    brand: jsonb("brand").$type<CompanyRequestBrand>(),
    /** The Deep dive runs on after the request is done: running, done, or failed, with its own start and finish. */
    dossierStatus: text("dossier_status").$type<"running" | "done" | "failed">(),
    dossierStartedAt: timestamp("dossier_started_at", { withTimezone: true }),
    dossierFinishedAt: timestamp("dossier_finished_at", { withTimezone: true }),
    message: text("message"),
    requesterHash: text("requester_hash").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("company_requests_active_domain_idx").on(t.domain).where(sql`${t.status} in ('queued', 'running')`),
    index("company_requests_created_idx").on(t.createdAt),
    index("company_requests_domain_idx").on(t.domain),
    index("company_requests_company_idx").on(t.companyId),
  ],
);

/**
 * The classifier's shadow reading of the live feed's search results (Jev, lib/jev-shadow.ts): each
 * result the sweep or the watch searches returned, the rules' decision on it, and Jev's verdict beside
 * it. Nothing reads it to keep or drop a page; `pnpm jev-shadow` compares the two.
 */
export const pageVerdicts = pgTable(
  "page_verdicts",
  {
    id: text("id").primaryKey(),
    lane: text("lane").notNull(), // sweep | watch
    runId: text("run_id"),
    presetSlug: text("preset_slug"),
    url: text("url").notNull(),
    title: text("title"),
    /** The rules' decision: an article URL without a directory title. */
    rulesKept: boolean("rules_kept").notNull(),
    aboutRaise: doublePrecision("about_raise").notNull(),
    isRound: doublePrecision("is_round").notNull(),
    kind: text("kind").notNull(),
    kindConfidence: doublePrecision("kind_confidence").notNull(),
    model: text("model").notNull(),
    createdAt: timestamps.createdAt,
  },
  // url: persist and the money repair read a page's stored kind when no tier names its host.
  (t) => [index("page_verdicts_created_idx").on(t.createdAt), index("page_verdicts_url_idx").on(t.url)],
);
