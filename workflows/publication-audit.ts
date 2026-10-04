// The publication gate's lane: every five minutes, the rows the gate holds are audited, oldest first,
// one step each (lib/publication-audit.ts). A pass publishes the row and queues it for delivery; a
// hold leaves it in review with its reasons. A row no page of which could be read waits for the next run.

import { DEFAULT_TIERS, firecrawlReader, publicationAuditModel } from "@fireround/core";
import { db } from "@/lib/db";
import { enqueueDeliveries } from "@/lib/delivery";
import { invalidateEntityPages } from "@/lib/entity-invalidation";
import { getFirecrawl } from "@/lib/firecrawl";
import { recordRun } from "@/lib/persist";
import { applyAudit, auditGateOn, auditRow, pendingAuditIds, roundForAudit } from "@/lib/publication-audit";
import { loadPublisherTiers } from "@/lib/rules";

export async function publicationAuditWorkflow(runId: string, limit = 20): Promise<{ audited: number; passed: number; held: number }> {
  "use workflow";
  const startedAt = new Date().toISOString();
  const ids = await dueStep(limit);
  const counts = { audited: 0, passed: 0, held: 0, unread: 0, moved: 0 };
  for (const id of ids) {
    const outcome = await auditStep(id);
    counts.audited++;
    counts[outcome]++;
  }
  await recordStep(runId, startedAt, counts);
  return { audited: counts.audited, passed: counts.passed, held: counts.held };
}

async function dueStep(limit: number): Promise<string[]> {
  "use step";
  const handle = await db();
  if (!(await auditGateOn(handle)) || !publicationAuditModel()) return [];
  return pendingAuditIds(handle, limit);
}

async function auditStep(id: string): Promise<"passed" | "held" | "unread" | "moved"> {
  "use step";
  const handle = await db();
  const model = publicationAuditModel();
  const row = await roundForAudit(handle, id);
  if (!model || !row || row.disposition !== "review") return "moved";
  const tiers = { ...DEFAULT_TIERS, ...(await loadPublisherTiers()) };
  const run = await auditRow(row, firecrawlReader(getFirecrawl()), model, tiers);
  if (!run) return "unread";
  const outcome = await applyAudit(handle, row, run, model.label);
  if (outcome === "passed" && !row.history) await enqueueDeliveries(handle, [id], row.preset_slug);
  await invalidateEntityPages(handle, { roundIds: [id] });
  return outcome;
}

async function recordStep(runId: string, startedAt: string, counts: Record<string, number>): Promise<void> {
  "use step";
  const handle = await db();
  await recordRun(handle, {
    id: runId,
    presetSlug: "publication-audit",
    lane: "audit",
    startedAt: new Date(startedAt),
    finishedAt: new Date(),
    creditsEstimated: counts.audited * 4,
    counts,
  });
}
