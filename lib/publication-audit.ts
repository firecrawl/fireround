// The publication gate's app side: which pages the audit reads, the row it is shown, and what its
// verdict does to the stored round (packages/core/src/llm/publication-audit.ts holds the check itself).
//
// A round reaches visitors only through the gate. Migration 20261004120000 adds a trigger: while the
// `publication_audit` setting is on, a row written as publish or flagged without a passing audit of
// its current facts is kept in review, with the disposition it asked for in `pending_disposition`.
// auditPendingRounds reads those rows, and a pass restores the disposition it asked for. A fact that
// changes later (company, stage, amount, day, certainty) no longer matches the audited fingerprint, so
// the row goes back through. A person's own publish counts as an audit (`human`).

import {
  type AuditDecision,
  type AuditedRound,
  auditPrompt,
  DEFAULT_TIERS,
  decideAudit,
  generatePublicationAudit,
  type PublicationAudit,
  type ReadPages,
  type ReconcileModel,
  registrableDomain,
  type SourceText,
} from "@fireround/core";
import { type Db, schema } from "@fireround/core/db";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { listRounds, type RoundRow } from "./persist.ts";

const { fundingRounds, roundSources, settings } = schema;

const WIRES = /(?:^|\.)(?:prnewswire|businesswire|globenewswire|accesswire|newswire|einpresswire|prweb)\.com$|(?:^|\.)sec\.gov$/;
const PAGES = 6;

/** The audit's view of a row: what a visitor sees. */
export function auditedRound(row: RoundRow): AuditedRound {
  return {
    company: {
      name: row.company.name,
      domain: row.company.domain,
      website: row.company.website,
      description: row.company.description,
      hq: row.company.hq,
      sector: row.company.sector,
    },
    stage: row.stage,
    stage_as_written: row.stage_as_written,
    amount_as_written: row.amount.as_written,
    amount_currency: row.amount.currency,
    amount_usd_millions: row.amount.usd_millions,
    financing_total_as_written: row.financing_total_as_written,
    valuation_as_written: row.valuation_as_written,
    announced_on: row.announced_on,
    certainty: row.certainty,
    is_extension: row.is_extension,
    history: row.history,
    lead_investors: row.lead_investors,
    other_investors: row.other_investors,
    sources: row.sources.map((s) => ({ url: s.url, host: s.host, title: s.title })),
  };
}

/** The pages worth reading, best first: the company's own, a wire or filing, an established outlet, then the rest. */
export function pagesToAudit(row: RoundRow, tiers: Record<string, number> = DEFAULT_TIERS): RoundRow["sources"] {
  const own = row.company.domain;
  const rank = (s: RoundRow["sources"][number]) => {
    const domain = registrableDomain(s.url) ?? s.host;
    if (own && domain === own) return 0;
    if (WIRES.test(domain)) return 1;
    if ((tiers[s.host] ?? tiers[domain] ?? 0) >= 0.7) return 2;
    return 3;
  };
  return [...row.sources].sort((a, b) => rank(a) - rank(b)).slice(0, PAGES);
}

export interface AuditRun {
  decision: AuditDecision;
  audit: PublicationAudit;
  pages: number;
  usage: { input: number; output: number };
}

/** Read the row's best pages and audit it. Null when no page could be read: the gate cannot judge it. */
export async function auditRow(
  row: RoundRow,
  read: ReadPages,
  model: ReconcileModel,
  tiers: Record<string, number> = DEFAULT_TIERS,
): Promise<AuditRun | null> {
  const chosen = pagesToAudit(row, tiers);
  const pages: SourceText[] = await read(
    chosen.map((s) => ({ url: s.url, host: s.host, title: s.title ?? undefined, published: s.published ?? undefined })),
  );
  if (pages.length === 0) return null;
  const input = auditedRound(row);
  const { output, usage } = await generatePublicationAudit(model, auditPrompt(input, pages));
  if (!output) return null;
  // The model reads the first screens of each page; a roundup names the round further down. A page
  // leaves the row only when it was read and its whole text never names the company.
  const names = (text: string) => {
    const words = row.company.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return words.length > 0 && text.toLowerCase().replace(/[^a-z0-9]+/g, " ").includes(words);
  };
  const unrelated = output.unrelated_sources.filter((url) => {
    const page = pages.find((p) => p.url === url);
    return page !== undefined && !names(page.markdown);
  });
  const audit = { ...output, unrelated_sources: unrelated };
  return { decision: decideAudit(input, audit), audit, pages: pages.length, usage };
}

/** Whether the gate is on for this store. Off by default, so a self-hosted instance without a model behaves as before. */
export async function auditGateOn(handle: Db): Promise<boolean> {
  const [row] = await handle.select({ value: settings.value }).from(settings).where(eq(settings.key, "publication_audit")).limit(1);
  return row?.value === true;
}

/** The fingerprint of the facts the audit judged, as the trigger computes it. */
async function factsOf(handle: Db, id: string): Promise<string | null> {
  const rows = await handle.execute<{ facts: string }>(sql`select round_audit_facts(r) as facts from funding_rounds r where r.id = ${id}`);
  const list = (rows as unknown as { rows?: Array<{ facts: string }> }).rows ?? (rows as unknown as Array<{ facts: string }>);
  return list[0]?.facts ?? null;
}

const holdNote = (reasons: string[]) => `held for review: publication audit: ${reasons.join("; ")}`;

/**
 * Write a verdict. Corrections apply first; a pass then stamps the audit with the fingerprint of the
 * facts it judged (a row that moved meanwhile is left for the next pass) and restores the disposition
 * the row asked for; a hold leaves it in review with the reasons in its notes.
 */
export async function applyAudit(
  handle: Db,
  row: RoundRow,
  run: AuditRun,
  label: string,
  now = new Date(),
): Promise<"passed" | "held" | "moved"> {
  const facts = await factsOf(handle, row.id);
  const { decision } = run;
  const verification = row.verification ?? { status: "unverified", notes: [], url: null };
  const notes = [...verification.notes];
  const set: Partial<typeof fundingRounds.$inferInsert> = {};
  for (const fix of decision.fixes) {
    if (fix.kind === "certainty") {
      set.certainty = fix.to;
      set.reportedOn = row.reported_on ?? row.announced_on;
      notes.push(`publication audit: ${fix.to}, not announced: "${fix.quote}" (${fix.source})`);
    } else if (fix.kind === "amount_scope") {
      set.financingTotalAsWritten = row.amount.as_written;
      set.amountScope = fix.scope === "includes_debt" ? "financing_total" : fix.scope;
      set.amountAsWritten = null;
      set.amountValue = null;
      set.amountUsdMillions = null;
      notes.push(
        `publication audit: ${row.amount.as_written} is ${fix.scope.replace(/_/g, " ")}, not this round's money: "${fix.quote}" (${fix.source})`,
      );
    } else if (fix.kind === "date") {
      set.announcedOn = fix.to;
      set.datePrecision = "day";
      set.dateBasis = "stated";
      set.pinned = { ...(row.pinned ?? {}), announced_on: fix.to };
      notes.push(`publication audit: announced ${fix.to}: "${fix.quote}" (${fix.source})`);
    } else if (fix.kind === "stage") {
      set.stageAsWritten = fix.to;
      notes.push(`publication audit: stage ${fix.to}: "${fix.quote}" (${fix.source})`);
    } else if (fix.kind === "drop_sources") {
      await handle.delete(roundSources).where(and(eq(roundSources.roundId, row.id), inArray(roundSources.sourceId, fix.urls)));
      notes.push(`publication audit: dropped ${fix.urls.length} page(s) about another round`);
    }
  }
  notes.push(...decision.notes);
  const audit = {
    status: decision.action === "pass" ? ("pass" as const) : ("fail" as const),
    model: label,
    at: now.toISOString(),
    reasons: decision.reasons,
    summary: run.audit.summary,
  };
  if (decision.action === "hold") {
    notes.push(holdNote(decision.reasons));
    const updated = await handle
      .update(fundingRounds)
      .set({
        ...set,
        audit,
        auditFacts: null,
        pendingDisposition: null,
        disposition: "review",
        verification: { ...verification, notes: [...new Set(notes)] },
        updatedAt: now,
      })
      .where(and(eq(fundingRounds.id, row.id), sql`round_audit_facts(${fundingRounds}) = ${facts}`))
      .returning({ id: fundingRounds.id });
    return updated.length ? "held" : "moved";
  }
  // Corrections change the facts, so the pass is stamped on the corrected row: the update below writes
  // the corrected fields and the audit in one statement, and the trigger fingerprints the result.
  const [{ pending } = { pending: null }] = await handle
    .select({ pending: fundingRounds.pendingDisposition })
    .from(fundingRounds)
    .where(eq(fundingRounds.id, row.id))
    .limit(1);
  const wanted = row.disposition === "review" ? pending : row.disposition;
  const updated = await handle
    .update(fundingRounds)
    .set({
      ...set,
      audit,
      auditFacts: null,
      verification: { ...verification, notes: [...new Set(notes)] },
      ...(wanted === "publish" || wanted === "flagged" ? { disposition: wanted, pendingDisposition: null } : {}),
      updatedAt: now,
    })
    .where(and(eq(fundingRounds.id, row.id), sql`round_audit_facts(${fundingRounds}) = ${facts}`))
    .returning({ id: fundingRounds.id, disposition: fundingRounds.disposition });
  if (!updated.length) return "moved";
  return updated[0].disposition === "publish" || updated[0].disposition === "flagged" ? "passed" : "held";
}

/** The rows waiting at the gate, oldest first. */
export async function pendingAuditIds(handle: Db, limit: number): Promise<string[]> {
  const rows = await handle
    .select({ id: fundingRounds.id })
    .from(fundingRounds)
    .where(and(isNotNull(fundingRounds.pendingDisposition), eq(fundingRounds.disposition, "review")))
    .orderBy(asc(fundingRounds.updatedAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function roundForAudit(handle: Db, id: string): Promise<RoundRow | null> {
  const { rows } = await listRounds(handle, { ids: [id], includeReview: true, certainty: "all", limit: 1 });
  return rows[0] ?? null;
}
