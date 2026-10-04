import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { cronAuthorized } from "@/lib/cron-auth";
import { claimCronTick } from "@/lib/cron-lease";
import { db } from "@/lib/db";
import { publicationAuditWorkflow } from "@/workflows/publication-audit";

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tick = new Date();
  const requested = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 60) : 20;
  if (!(await claimCronTick(await db(), "publication-audit", tick))) return NextResponse.json({ ok: true, skipped: "already claimed" });
  const runId = `audit:${randomUUID()}`;
  const started = await start(publicationAuditWorkflow, [runId, limit]);
  return NextResponse.json({ ok: true, runId, workflowRunId: started?.runId ?? null });
}
