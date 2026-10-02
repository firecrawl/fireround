// One applier for both verdicts. The single-page judge and the cross-source reconciler ask a model the
// same questions about a record (is this its round as news, is this its company, what stage, what
// amount, what day, who led, who was never in the round, where is the company) and correct the record
// the same way; only the verdict shapes differ. Each maps its verdict into a Correction and calls
// applyCorrection, so what replaces what, what nulls, what the notes say, and how the record is rescored
// live once. Not exported from the package: the verdict schemas are the public surface.

import { convertToUsd, type RateTable } from "./fx.ts";
import { dedupeInvestorNames, normalizeInvestorName } from "./investors.ts";
import { canonicalUrl, classifyStage, dateFromUrl, hostOf, parseAmount, parseStatedDate, stageForAmount } from "./normalize.ts";
import { MONTHLY_LIST, reconcileInvestorLists, scoreConfidence, WEEKLY_LIST } from "./resolve.ts";
import type { FeedRecord } from "./schema.ts";

/** A field as the verdict states it: the value copied from a page, null when no page states it, and the page. */
export interface Stated {
  value: string | null;
  /** The URL of the page that states it; for the judge, the one page it read. */
  source: string | null;
}

export interface CitedName {
  name: string;
  source: string | null;
}

export interface Correction {
  announcement: "yes" | "history" | "not_a_round" | "unclear";
  companyMatches: boolean;
  stage: Stated;
  amount: Stated & {
    /**
     * Whether the figure may fill a record that has no amount. The judge, reading one page with the
     * record's own sentence beside it, fills only when that sentence carries the figure (one page's
     * figure for a tranche was the round's cumulative total); the reconciler cites the sentence it read.
     */
    fillsEmpty: boolean;
  };
  date: Stated & {
    /**
     * How well the verdict knows the day. Null when the verdict grades nothing (the judge states a day or
     * nothing): then a day that only echoes a list page's own date is refused, see echoesListDate.
     */
    precision: "day" | "week" | "month" | null;
  };
  /** The round's valuation as the pages state it for this round; absent when the verdict does not ask (the judge). */
  valuation?: Stated;
  leads: CitedName[];
  others: string[];
  notThisRound: string[];
  headquarters: Stated;
  /** The verdict's own sentence on what disagreed; null when it says the record matches. */
  notes: string | null;
  /** Whether the notes name the page that stated each field: the reconciler read several, the judge one. */
  cited: boolean;
  /** The URL the verification records as read. */
  url: string | null;
  /**
   * What the reader saw, for the investor rule; the reconciler sets it, the judge does not. `readAll`
   * says every source the record has was read; `mentions` says whether the read text names an
   * investor. A record investor the verdict's lists leave out is then unsupported when no source
   * was left unread, or when the read text names it (seen, and not placed in this round). The
   * judge reads one page and cannot speak for the record's other sources, so its silence keeps a seat.
   */
  coverage?: { readAll: boolean; mentions: (name: string) => boolean };
}

export interface CorrectionOptions {
  rates: RateTable | null;
  tiers?: Record<string, number>;
  /** Stamped on the verification beside status, notes, and url: the reconciler's verifier and sources_seen. */
  verification?: Pick<NonNullable<FeedRecord["verification"]>, "verifier" | "sources_seen" | "sources_listed">;
}

const AMOUNT_TOLERANCE = 0.05;

/**
 * Whether a day handed back for a record dated to a week or a month only echoes the list page that
 * stamped it. The same date read from the same page found no day for the round; a weekly or monthly
 * list states no round's day whatever it hands back (a month-precision date became the list's last
 * day); and a page dated the very day the list stamped is the list or its same-day echo. A different
 * page that states a day inside the week (a release) is a real day.
 */
function echoesListDate(r: FeedRecord, d: Date, url: string | null): boolean {
  if (r.date_precision === "day") return false;
  const listPage = r.sources[0]?.url ?? null;
  if (d.toISOString().slice(0, 10) === r.announced_date && (url === null || url === listPage)) return true;
  const judged = url ? r.sources.find((x) => x.url === url) : undefined;
  if (judged && (WEEKLY_LIST.test(judged.title ?? "") || WEEKLY_LIST.test(judged.url) || MONTHLY_LIST.test(judged.title ?? "")))
    return true;
  // The judged page's own day is its URL's or its published day: the issue's date, not the round's.
  const pageOwnDay = url ? (dateFromUrl(url) ?? (judged?.published ? parseStatedDate(judged.published) : null)) : null;
  const listDay = r.announced_date ? parseStatedDate(r.announced_date) : null;
  return (
    pageOwnDay !== null &&
    listDay !== null &&
    Math.abs(d.getTime() - pageOwnDay.getTime()) <= 86_400_000 &&
    listDay.getTime() === pageOwnDay.getTime()
  );
}

/** One page under two spellings of its URL: the scheme, a www, and a trailing slash say nothing. */
export function samePage(a: string, b: string): boolean {
  const bare = (u: string) => canonicalUrl(u).replace(/^https?:\/\/(?:www\.)?/i, "");
  return bare(a) === bare(b);
}

/**
 * Whether a graded day sharpens a week or a month to the very day of the list page that stamped it,
 * citing that list: the issue's date, not the round's. The reconciler handed back Term Sheet's own
 * Sep 23 as Fearn's "day" (fortune.com) for a seed announced on June 10. The same day from another
 * page (a release, a dated article about this round alone) is a real day.
 */
function sharpensListStamp(r: FeedRecord, iso: string, precision: string, url: string | null): boolean {
  if (precision !== "day" || r.date_precision === "day" || iso !== r.announced_date) return false;
  if (url === null) return true;
  const listPage = r.sources[0]?.url ?? null;
  if (listPage !== null && samePage(url, listPage)) return true;
  const judged = r.sources.find((x) => samePage(x.url, url));
  return Boolean(judged && (WEEKLY_LIST.test(judged.title ?? "") || WEEKLY_LIST.test(judged.url) || MONTHLY_LIST.test(judged.title ?? "")));
}

/**
 * The record after the correction: pure, so the same verdict always gives the same record. Fields no
 * page states are nulled; fields a page states differently are corrected; the lead list becomes the
 * pages'; non-investors leave; the verification and the confidence are set.
 */
export function applyCorrection(record: FeedRecord, c: Correction, opts: CorrectionOptions): FeedRecord {
  const r: FeedRecord = {
    ...record,
    amount: { ...record.amount },
    lead_investors: [...record.lead_investors],
    other_investors: [...record.other_investors],
  };
  const notes: string[] = [];
  let corrected = false;
  const tag = (parts: Array<string | null>) => {
    const named = parts.filter((p): p is string => p !== null);
    return named.length ? ` (${named.join(", ")})` : "";
  };
  const who = (source: string | null) => (c.cited ? (source ? hostOf(source) : "a source") : null);
  const cite = (source: string | null) => tag([who(source)]);
  const remark = c.notes ? [c.notes] : [];
  const verification = (status: NonNullable<FeedRecord["verification"]>["status"], lines: string[]) => ({
    status,
    notes: lines,
    url: c.url,
    ...opts.verification,
  });

  if (c.announcement === "history" || c.announcement === "not_a_round") {
    r.verification = verification("not_news", [
      c.announcement === "history" ? "the page recalls this round as history" : "the page is not about a funding round for this company",
      ...remark,
    ]);
    return r;
  }
  if (!c.companyMatches) {
    r.verification = verification("contradicted", ["the page's company is not the record's", ...remark]);
    return r;
  }

  // Stage: the page's label wins when it maps to a different stage. A label the classifier cannot place
  // ("funding round") says nothing against a specific one and does not erase it.
  if (c.stage.value) {
    const { stage, isExtension } = classifyStage(c.stage.value);
    if (stage !== r.stage && stage !== "other") {
      notes.push(`stage ${r.stage_as_written} read as ${c.stage.value}${cite(c.stage.source)}`);
      r.stage = stage;
      r.stage_as_written = c.stage.value;
      r.is_extension = isExtension || r.is_extension;
      corrected = true;
    } else if (isExtension && !r.is_extension) {
      notes.push(`the page calls it an extension (${c.stage.value})${cite(c.stage.source)}`);
      r.is_extension = true;
      corrected = true;
    }
  }

  // Amount: what no page states is not the round's; what a page states differently replaces.
  if (!c.amount.value) {
    if (r.amount.as_written !== null) {
      notes.push(`amount ${r.amount.as_written} not stated for this round`);
      r.amount = { value: null, currency: null, as_written: null, usd_millions: null, fx_rate: null, fx_date: null };
      corrected = true;
    }
  } else {
    let parsed = parseAmount(c.amount.value);
    const current = r.amount.value;
    // A figure copied without its currency ("17.2m" for "€17.2m") is the record's own amount when the numbers match.
    if (
      parsed.value !== null &&
      parsed.currency === null &&
      current !== null &&
      Math.abs(parsed.value - current) <= AMOUNT_TOLERANCE * current
    )
      parsed = { ...parsed, currency: r.amount.currency };
    const differs =
      parsed.value !== null &&
      (current !== null || c.amount.fillsEmpty) &&
      (current === null ||
        parsed.currency !== r.amount.currency ||
        Math.abs(parsed.value - current) > AMOUNT_TOLERANCE * Math.max(parsed.value, current));
    if (differs && parsed.value !== null) {
      notes.push(`amount ${r.amount.as_written ?? "none"} read as ${c.amount.value}${cite(c.amount.source)}`);
      r.amount = {
        value: parsed.value,
        currency: parsed.currency,
        as_written: c.amount.value,
        ...convertToUsd(parsed.value, parsed.currency, opts.rates, c.amount.value),
      };
      corrected = true;
    }
  }

  // Valuation: this round's only. One no page states for this round goes, better missing than
  // recalled from another round (Corgi's September extension carried May's $1.3 billion).
  if (c.valuation) {
    const was = r.valuation_as_written;
    if (!c.valuation.value) {
      if (was) {
        notes.push(`valuation ${was} not stated for this round`);
        r.valuation_as_written = null;
        r.valuation_ruled_out = "no source states it for this round";
        corrected = true;
      }
    } else {
      const page = parseAmount(c.valuation.value).value;
      const mine = parseAmount(was).value;
      if (page !== null && (mine === null || Math.abs(page - mine) > AMOUNT_TOLERANCE * Math.max(page, mine))) {
        notes.push(`valuation ${was ?? "none"} read as ${c.valuation.value}${cite(c.valuation.source)}`);
        r.valuation_as_written = c.valuation.value;
        delete r.valuation_ruled_out;
        corrected = true;
      }
    }
  }

  // Date: the day the pages fix, at the precision the verdict supports. An ungraded day is a day, and
  // outranks whatever the record borrowed unless it only echoes the list page the record took its week
  // or month from; a graded day may not sharpen a list's stamp by citing the list itself.
  if (c.date.value) {
    const d = parseStatedDate(c.date.value);
    if (d) {
      const iso = d.toISOString().slice(0, 10);
      const graded = c.date.precision !== null;
      const precision = c.date.precision ?? "day";
      // The page that fixed the day is dated by it, so a source listed with no date of its own shows the day it was read at.
      const dated = c.date.source ? r.sources.findIndex((s) => samePage(s.url, c.date.source as string)) : -1;
      if (precision === "day" && dated >= 0 && !r.sources[dated].published) {
        r.sources = r.sources.map((s, i) => (i === dated ? { ...s, published: iso } : s));
      }
      const echoed = graded ? sharpensListStamp(r, iso, precision, c.date.source) : echoesListDate(r, d, c.date.source);
      if (!echoed && (iso !== r.announced_date || precision !== r.date_precision)) {
        const was = tag([graded ? r.date_precision : null]);
        const now = tag([graded ? precision : null, who(c.date.source)]);
        notes.push(
          iso === r.announced_date && !graded
            ? `date ${iso} confirmed to the day (was ${r.date_precision})${now}`
            : `date ${r.announced_date ?? "none"}${was} read as ${iso}${now}`,
        );
        r.announced_date = iso;
        r.date_precision = precision;
        r.date_basis = precision === "day" ? "stated" : "page";
        r.undated = false;
        corrected = true;
      }
    }
  }

  // A figure the read-back settled can make an unlabelled round a growth round (OpenAI's $40 billion).
  r.stage = stageForAmount(r.stage, r.stage_as_written, r.amount.usd_millions);

  // Investors: the pages' lists are the record's. A record name that folds into a page name keeps the
  // page's role for it; a record name the pages place outside the round leaves; a page lead the record
  // lacked joins. A record name the lists leave out is unsupported when the reader saw every source or
  // saw the name and still left it out (Ultraviolette's existing backers, listed on the page beside
  // the round, rode through as participants when silence kept a seat), and leaves with its role; it
  // keeps its seat only when a source the reader never saw could state it (a record's lead, named on
  // another source, was once removed for being absent), or when the verdict is the judge's one page.
  // The verdict's names pass the same hygiene as the extractor's: a "funds managed by Acme" or an
  // owner-wrapped fund the model copied off the page resolves to the firm, a placeholder to nothing.
  const leads = c.leads.flatMap((n) => {
    const name = normalizeInvestorName(n.name);
    return name !== null && name.length > 1 ? [{ name, source: n.source }] : [];
  });
  const leadNames = leads.map((n) => n.name);
  const normalize = (n: string) => {
    const name = normalizeInvestorName(n);
    return name !== null && name.length > 1 ? [name] : [];
  };
  const others = c.others.flatMap(normalize);
  const excluded = c.notThisRound.flatMap(normalize);
  const inList = (name: string, list: string[]) =>
    list.length > 0 && dedupeInvestorNames([...list, name]).length === dedupeInvestorNames(list).length;
  const recordNames = [...r.lead_investors, ...r.other_investors];
  const silent = recordNames.filter((n) => !inList(n, excluded) && !inList(n, leadNames) && !inList(n, others));
  const unsupported = c.coverage ? silent.filter((n) => c.coverage?.readAll || c.coverage?.mentions(n)) : [];
  if (leadNames.length + others.length + excluded.length + unsupported.length > 0) {
    const dropped = recordNames.filter((n) => inList(n, excluded));
    const unknown = silent.filter((n) => !unsupported.includes(n));
    const keptLeads = recordNames.filter((n) => inList(n, leadNames) || (unknown.includes(n) && r.lead_investors.includes(n)));
    const keptOthers = recordNames.filter(
      (n) => !inList(n, leadNames) && (inList(n, others) || (unknown.includes(n) && r.other_investors.includes(n))),
    );
    const set = reconcileInvestorLists([...leadNames, ...keptLeads], [...keptOthers, ...others.filter((n) => !inList(n, leadNames))]);
    const changedLeads =
      set.lead_investors.length !== r.lead_investors.length || set.lead_investors.some((n) => !r.lead_investors.includes(n));
    const changedOthers =
      set.other_investors.length !== r.other_investors.length || set.other_investors.some((n) => !r.other_investors.includes(n));
    if (changedLeads || changedOthers) {
      if (dropped.length) notes.push(`not investors in this round: ${dropped.join(", ")}`);
      if (unsupported.length) notes.push(`not supported for this round: ${unsupported.join(", ")}`);
      const demoted = r.lead_investors.filter((n) => keptOthers.includes(n));
      if (demoted.length) notes.push(`not leads: ${demoted.join(", ")}`);
      const newLeads = set.lead_investors.filter((n) => !r.lead_investors.includes(n));
      if (newLeads.length)
        notes.push(`leads: ${newLeads.map((n) => `${n}${cite(leads.find((x) => x.name === n)?.source ?? null)}`).join(", ")}`);
      r.lead_investors = set.lead_investors;
      r.other_investors = set.other_investors;
      corrected = true;
    }
  }

  // Headquarters: filled when a page states it about the company; a dateline is not that. A fill is
  // not a correction.
  if (c.headquarters.value && !r.headquarters) {
    r.headquarters = c.headquarters.value;
    notes.push(`headquarters ${c.headquarters.value}${cite(c.headquarters.source)}`);
  }

  notes.push(...remark);
  r.verification = verification(corrected ? "corrected" : "confirmed", notes);
  r.confidence = scoreConfidence(r, opts.tiers ?? {});
  return r;
}
