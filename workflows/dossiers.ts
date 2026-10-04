// The dossier lane, durable. One company is a few steps: start the agent, wait for it (a step polls
// for up to eight minutes and the next step picks up where it left off, so no function waits out a
// long dive), then check, save, and record. The agent's result is a step's return value, so when the
// check fails (the gateway down, a page read timing out) the retry checks again without paying for
// another dive. A company whose dossier predates the check is only checked.
//
// The sweep and the ingest call processDossierTarget for the companies their rung dives, which
// includes a company whose checked dossier the round just recorded has outdated (lib/intel.ts
// dossierStates); the backfill works every visible company that lacks a current checked dossier, a
// few at a time.

import type { DeepDiveResult } from "@fireround/core";
import { awaitDeepDive } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { db } from "@/lib/db";
import { companiesWithDossier, DEEP_DIVE_CREDITS, finishCompanyDive, reverifyDossier, startCompanyDive } from "@/lib/deepdive";
import { dossierCheckAvailable } from "@/lib/dossier-check";
import { BACKFILL_CHUNK, backfillChunk, dealLanes } from "@/lib/durable";
import { invalidateEntityPages } from "@/lib/entity-invalidation";
import { getFirecrawl } from "@/lib/firecrawl";
import {
  backfillTargets,
  type DossierBackfillParams,
  type DossierTarget,
  deepDiveTargets,
  divesResting,
  dossierBacklog,
  dossierStates,
} from "@/lib/intel";
import { mergeRunCounts, recordRun } from "@/lib/persist";
import { getCoverage } from "@/lib/settings";
import { queueCompanyHistoryStep } from "@/workflows/history";

export { BACKFILL_CHUNK, dealLanes };

/** Polls of up to eight minutes each: a dive still running after about half an hour is cancelled. */
const AWAIT_ROUNDS = 4;
/** Dives the Max rung adds to each sweep from the backlog of visible companies without a checked dossier. */
export const BACKLOG_DIVES_PER_SWEEP = 2;

export interface DossierOutcome {
  companyId: string;
  action: DossierTarget["action"];
  /** verified: saved; rejected: another company, not saved; removed: an unchecked dossier failed its check and was deleted. */
  status: "verified" | "rejected" | "removed" | "failed" | "skipped";
  agentCredits: number;
  checkCredits: number;
}

export interface DossierTally {
  targets: number;
  dived: number;
  reverified: number;
  verified: number;
  rejected: number;
  removed: number;
  failed: number;
  skipped: number;
  /** Dives not started because the credit ceiling was reached. */
  skipped_budget: number;
  credits: number;
  agent_credits: number;
  check_credits: number;
}

export function emptyTally(targets = 0): DossierTally {
  return {
    targets,
    dived: 0,
    reverified: 0,
    verified: 0,
    rejected: 0,
    removed: 0,
    failed: 0,
    skipped: 0,
    skipped_budget: 0,
    credits: 0,
    agent_credits: 0,
    check_credits: 0,
  };
}

/** Add one company's outcome to a tally. Pure. */
export function tallyOutcome(t: DossierTally, o: DossierOutcome): DossierTally {
  const next = { ...t };
  if (o.action === "dive" && o.status !== "skipped") next.dived++;
  if (o.action === "reverify" && o.status !== "skipped") next.reverified++;
  next[o.status]++;
  next.agent_credits += o.agentCredits;
  next.check_credits += o.checkCredits;
  next.credits += o.agentCredits + o.checkCredits;
  return next;
}

/**
 * One company through the lane: check an unchecked dossier, or dive and check. Plain async, called
 * from workflow bodies, so each move is its own step. A failure that outlasts the step's retries is
 * recorded on Runs and returned as failed; the caller moves on to the next company. An automatic
 * pass looks again just before it spends (a backfill plans hours ahead); `force` is the button.
 */
export async function processDossierTarget(target: DossierTarget, opts: { force?: boolean } = {}): Promise<DossierOutcome> {
  const base = { companyId: target.companyId, action: target.action };
  if (target.action === "reverify") {
    try {
      return await afterCheck(await reverifyStep(target.companyId));
    } catch (err) {
      await recordFailureStep(target.companyId, "reverify", String(err), null);
      return { ...base, status: "failed", agentCredits: 0, checkCredits: 0 };
    }
  }
  let started: { jobId: string; startedAt: string } | { skipped: string };
  try {
    started = await startDiveStep(target.companyId, opts.force ?? false);
  } catch (err) {
    await recordFailureStep(target.companyId, "dive", String(err), null);
    return { ...base, status: "failed", agentCredits: 0, checkCredits: 0 };
  }
  if ("skipped" in started) return { ...base, status: "skipped", agentCredits: 0, checkCredits: 0 };
  let result: DeepDiveResult | null = null;
  try {
    for (let i = 0; i < AWAIT_ROUNDS; i++) {
      result = await awaitDiveStep(started.jobId, started.startedAt);
      if (result.status !== "processing") break;
    }
    return await afterCheck(await finishDiveStep(target.companyId, started.jobId, result as DeepDiveResult, started.startedAt));
  } catch (err) {
    await recordFailureStep(target.companyId, "dive", String(err), started.startedAt, result?.creditsUsed ?? null);
    return { ...base, status: "failed", agentCredits: result?.creditsUsed ?? 0, checkCredits: 0 };
  }
}

/**
 * A dossier that passed its check queues its prior rounds for promotion (workflows/history.ts). The
 * queue is idempotent per prior round, and a failure to queue never costs the dossier: the history
 * backfill finds any round left unqueued.
 */
async function afterCheck(outcome: DossierOutcome): Promise<DossierOutcome> {
  if (outcome.status !== "verified") return outcome;
  try {
    await queueCompanyHistoryStep(outcome.companyId);
  } catch {
    // Left for the backfill.
  }
  return outcome;
}

/**
 * Refuses before any spend when nothing could check the result. An automatic pass also stands down
 * when the company gained a current checked dossier since it was planned, or another pass is diving
 * it now.
 */
export async function startDiveStep(
  companyId: string,
  force: boolean,
): Promise<{ jobId: string; startedAt: string } | { skipped: string }> {
  "use step";
  if (!dossierCheckAvailable()) return { skipped: "no model is configured to check the dossier" };
  const handle = await db();
  // A company folded into another after it was queued: the survivor carries the dossier.
  const [exists] = await handle
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .limit(1);
  if (!exists) return { skipped: "company merged into another" };
  if (!force) {
    // A checked dossier a newer round has outdated is dived again; only a current one stands.
    if ((await dossierStates(handle, [companyId])).get(companyId) === "verified") return { skipped: "already checked and current" };
    if ((await divesResting(handle)).has(companyId)) return { skipped: "resting or in flight" };
  }
  const startedAt = new Date();
  const jobId = await startCompanyDive(handle, getFirecrawl(), companyId, { startedAt });
  return { jobId, startedAt: startedAt.toISOString() };
}

/** A request's page is watched, so it polls sooner than the lanes' ten seconds; the budget is the same. */
export async function awaitDiveStep(jobId: string, startedAt: string, pollSeconds?: number): Promise<DeepDiveResult> {
  "use step";
  return awaitDeepDive(getFirecrawl(), jobId, new Date(startedAt).getTime(), { budgetSeconds: 480, pollSeconds });
}

/** A dive still running after the last poll is cancelled and recorded as failed, so it stops spending. */
export async function finishDiveStep(companyId: string, jobId: string, result: DeepDiveResult, startedAt: string): Promise<DossierOutcome> {
  "use step";
  const client = getFirecrawl();
  if (result.status === "processing") await client.cancelAgent(jobId).catch(() => false);
  const handle = await db();
  // Folded into another company while the dive ran: the survivor's own dossier stands, so this one is dropped.
  const [exists] = await handle
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .limit(1);
  if (!exists) return { companyId, action: "dive", status: "skipped", agentCredits: result.creditsUsed ?? 0, checkCredits: 0 };
  const outcome = await finishCompanyDive(handle, client, companyId, result, new Date(startedAt));
  await invalidateEntityPages(handle, { companyIds: [companyId] });
  return {
    companyId,
    action: "dive",
    status: outcome.status,
    agentCredits: outcome.creditsUsed ?? 0,
    checkCredits: outcome.checkCredits,
  };
}

/** Checks a dossier written before the check; one already checked (by a pass that got there first) is left as it is. */
export async function reverifyStep(companyId: string): Promise<DossierOutcome> {
  "use step";
  const handle = await db();
  if ((await companiesWithDossier(handle, [companyId], { verifiedOnly: true })).has(companyId)) {
    return { companyId, action: "reverify", status: "skipped", agentCredits: 0, checkCredits: 0 };
  }
  const r = await reverifyDossier(handle, getFirecrawl(), companyId);
  await invalidateEntityPages(handle, { companyIds: [companyId] });
  return {
    companyId,
    action: "reverify",
    status: r.status === "none" ? "skipped" : r.status,
    agentCredits: 0,
    checkCredits: r.checkCredits,
  };
}

/** A company the lane could not finish still shows on Runs, with what it cost when that is known. */
async function recordFailureStep(
  companyId: string,
  action: DossierTarget["action"],
  error: string,
  startedAt: string | null,
  agentCredits: number | null = null,
): Promise<void> {
  "use step";
  const at = startedAt ? new Date(startedAt) : new Date();
  await recordRun(await db(), {
    id: `${action === "dive" ? "deepdive" : "dossiercheck"}:${companyId}:${at.getTime()}`,
    presetSlug: action === "dive" ? "deep-dive" : "dossier-check",
    lane: "agent",
    window: null,
    startedAt: at,
    finishedAt: new Date(),
    creditsEstimated: action === "dive" ? DEEP_DIVE_CREDITS : null,
    creditsMeasured: agentCredits,
    counts: { companies: 1, agent_credits: agentCredits ?? 0 },
    error: error.slice(0, 500),
  });
}

/** The rung's targets among the companies a sweep or an ingest just wrote. */
export async function deepDiveTargetsStep(insertedIds: string[]): Promise<DossierTarget[]> {
  "use step";
  const handle = await db();
  const plan = await getCoverage(handle);
  return deepDiveTargets(handle, plan, insertedIds);
}

/** On the Max rung, a few more from the backlog each sweep, so the store converges on a checked dossier per company. */
export async function dossierBacklogStep(exclude: string[]): Promise<DossierTarget[]> {
  "use step";
  const handle = await db();
  const plan = await getCoverage(handle);
  if (plan.agent.deepDive !== "all") return [];
  return dossierBacklog(handle, BACKLOG_DIVES_PER_SWEEP, exclude);
}

/** Work through targets one after another; what a sweep or an ingest calls. */
export async function processDossierTargets(targets: DossierTarget[]): Promise<DossierTally> {
  let tally = emptyTally(targets.length);
  for (const t of targets) tally = tallyOutcome(tally, await processDossierTarget(t));
  return tally;
}

/** The Deep dive button: one company, durable, so the page does not wait on the agent. */
export async function companyDossierWorkflow(companyId: string): Promise<DossierOutcome> {
  "use workflow";
  return processDossierTarget({ companyId, action: "dive" }, { force: true });
}

/** What a backfill run hands to the next: the day it began, the companies still to work, and the counts so far. */
export interface BackfillCarry {
  startedAt: string;
  targets: DossierTarget[];
  tally: DossierTally;
}

/**
 * The backfill: unchecked dossiers first, then dives, `concurrency` companies at a time, each company
 * its own steps so a failure retries only that company. A run works backfillChunk(concurrency) companies (twice the lanes), then
 * starts a fresh run with the rest and its counts (a pass over hundreds of companies is thousands of
 * steps, and a workflow replays its whole log on every step). The parent row on Runs (lane dossiers)
 * carries the running counts across runs; each dive and check also records its own row.
 */
export async function backfillDossiersWorkflow(params: DossierBackfillParams, runId: string, carry?: BackfillCarry): Promise<DossierTally> {
  "use workflow";
  const startedAt = carry?.startedAt ?? new Date().toISOString();
  const targets = carry?.targets ?? (await backfillTargetsStep(params));
  let tally = carry?.tally ?? emptyTally(targets.length);
  if (!carry) await parentRunStep(runId, startedAt, tally, false);
  const batch = targets.slice(0, backfillChunk(params.concurrency));
  const rest = targets.slice(backfillChunk(params.concurrency));
  await Promise.all(
    dealLanes(batch, params.concurrency).map(async (lane) => {
      for (const target of lane) {
        if (target.action === "dive" && tally.credits >= params.maxTotalCredits) {
          tally = { ...tally, skipped_budget: tally.skipped_budget + 1 };
          continue;
        }
        const outcome = await processDossierTarget(target);
        tally = tallyOutcome(tally, outcome);
        await progressStep(runId, tally);
      }
    }),
  );
  // Past the ceiling nothing is left to spend on: the remaining dives are counted, not carried.
  const spent = tally.credits >= params.maxTotalCredits;
  const next = spent ? rest.filter((t) => t.action !== "dive") : rest;
  if (spent) tally = { ...tally, skipped_budget: tally.skipped_budget + (rest.length - next.length) };
  if (next.length > 0) {
    await continueBackfillStep(params, runId, { startedAt, targets: next, tally });
    return tally;
  }
  await parentRunStep(runId, startedAt, tally, true);
  return tally;
}

/** Start the next backfill run with what is left. It runs on its own log; the parent row stays open until the last run closes it. */
async function continueBackfillStep(params: DossierBackfillParams, runId: string, carry: BackfillCarry): Promise<void> {
  "use step";
  await mergeRunCounts(await db(), runId, { ...carry.tally });
  await start(backfillDossiersWorkflow, [params, runId, carry]);
}

async function backfillTargetsStep(params: DossierBackfillParams): Promise<DossierTarget[]> {
  "use step";
  return backfillTargets(await db(), { limit: params.limit, reverifyOnly: params.reverifyOnly });
}

/** The parent row: written open when the backfill starts, closed with its counts when it ends. Credits sit in counts, since each dive's own row already carries them. */
async function parentRunStep(runId: string, startedAt: string, tally: DossierTally, finished: boolean): Promise<void> {
  "use step";
  await recordRun(await db(), {
    id: runId,
    presetSlug: "dossiers",
    lane: "dossiers",
    window: null,
    startedAt: new Date(startedAt),
    finishedAt: finished ? new Date() : null,
    creditsEstimated: null,
    creditsMeasured: null,
    counts: { ...tally },
  });
}

async function progressStep(runId: string, tally: DossierTally): Promise<void> {
  "use step";
  await mergeRunCounts(await db(), runId, { ...tally });
}
