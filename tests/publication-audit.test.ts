import { type AuditedRound, decideAudit, type PublicationAudit } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { persistRecords, setDisposition } from "../lib/persist";
import { applyAudit, pendingAuditIds, roundForAudit } from "../lib/publication-audit";
import { record, testDb } from "./helpers";

const ok = { verdict: "ok" as const, correct: null, quote: null, source: null };
const clean: PublicationAudit = {
  company: ok,
  round_type: { kind: "private_company_round", quote: null, source: null },
  amount: { ...ok, scope: "round" },
  stage: ok,
  date: ok,
  certainty: ok,
  leads: ok,
  unrelated_sources: [],
  summary: "Right.",
};
const shown: AuditedRound = {
  company: {
    name: "Viking",
    domain: "vikings.com",
    website: "https://vikings.com",
    description: "NFL team",
    hq: "Eagan, Minnesota",
    sector: null,
  },
  stage: "growth",
  stage_as_written: "funding round",
  amount_as_written: "$575M",
  amount_currency: "USD",
  amount_usd_millions: 575,
  financing_total_as_written: null,
  valuation_as_written: null,
  announced_on: "2026-09-29",
  certainty: "announced",
  is_extension: false,
  history: false,
  lead_investors: [],
  other_investors: [],
  sources: [
    { url: "https://ir.viking.example/offering", host: "ir.viking.example", title: "Viking closes offering" },
    { url: "https://news.example/other", host: "news.example", title: "Another company" },
  ],
};
const IR = "https://ir.viking.example/offering";

describe("what an audit verdict does", () => {
  test("a namesake's website or a listed company's offering hides the row", () => {
    const d = decideAudit(shown, {
      ...clean,
      company: { verdict: "wrong", correct: "Viking Therapeutics", quote: "Viking Therapeutics (Nasdaq: VKTX) announced", source: IR },
      round_type: { kind: "public_company_offering", quote: "concurrent offerings of common stock", source: IR },
    });
    expect(d.action).toBe("hold");
    expect(d.reasons).toHaveLength(2);
  });

  test("a total to date shown as the round is moved beside it; a 'nearing' is expected; a page about another round goes", () => {
    const d = decideAudit(shown, {
      ...clean,
      amount: { verdict: "wrong", correct: null, quote: "bringing its total funding to $575 million", source: IR, scope: "cumulative" },
      certainty: { verdict: "wrong", correct: "expected", quote: "is nearing a round", source: IR },
      unrelated_sources: ["https://news.example/other"],
    });
    expect(d.action).toBe("pass");
    expect(d.fixes.map((f) => f.kind).sort()).toEqual(["amount_scope", "certainty", "drop_sources"]);
  });

  test("a 'wrong company' whose right answer is the row's own website is a note, not a hold", () => {
    const d = decideAudit(shown, {
      ...clean,
      company: {
        verdict: "wrong",
        correct: "Viking (https://vikings.com/), based in Minneapolis",
        quote: "Viking, based in Minneapolis",
        source: IR,
      },
    });
    expect(d.action).toBe("pass");
    expect(d.notes[0]).toContain("company profile");
    const named = decideAudit(shown, {
      ...clean,
      company: {
        verdict: "wrong",
        correct: "Viking Therapeutics; the vikings.com site does not match",
        quote: "Viking Therapeutics announced",
        source: IR,
      },
    });
    expect(named.action).toBe("hold");
  });

  test("a wrong verdict without the sentence that proves it changes nothing", () => {
    const d = decideAudit(shown, { ...clean, company: { verdict: "wrong", correct: "Someone else", quote: null, source: null } });
    expect(d).toMatchObject({ action: "pass", reasons: [], fixes: [] });
  });
});

describe("the publication gate", () => {
  const on = async () => {
    const db = await testDb();
    await db.insert(schema.settings).values({ key: "publication_audit", value: true });
    return db;
  };
  const acme = record({ company_name: "Acme", company_domain: "acme.com", announced_date: "2026-09-02" });
  // The verification ledger's promotion, as promoteCheckedRound writes it.
  const promote = (db: Awaited<ReturnType<typeof testDb>>) =>
    db.update(schema.fundingRounds).set({ disposition: "publish" }).where(eq(schema.fundingRounds.id, acme.id));

  test("a round asking to be published waits in review until its audit passes, then publishes", async () => {
    const db = await on();
    await persistRecords(db, [acme], "series-a-b", "run");
    await promote(db);
    const [held] = await db.select().from(schema.fundingRounds);
    expect(held).toMatchObject({ disposition: "review" });
    expect(held.pendingDisposition).not.toBeNull();
    expect(await pendingAuditIds(db, 10)).toEqual([acme.id]);
    const row = await roundForAudit(db, acme.id);
    if (!row) throw new Error("no row");
    const outcome = await applyAudit(
      db,
      row,
      { decision: decideAudit(shown, clean), audit: clean, pages: 1, usage: { input: 0, output: 0 } },
      "test",
    );
    expect(outcome).toBe("passed");
    const [after] = await db.select().from(schema.fundingRounds);
    expect(after.disposition).toBe(held.pendingDisposition);
    expect(after.pendingDisposition).toBeNull();
  });

  test("a fact that changes after the audit sends the row back through the gate", async () => {
    const db = await on();
    await persistRecords(db, [acme], "series-a-b", "run");
    await promote(db);
    const row = await roundForAudit(db, acme.id);
    if (!row) throw new Error("no row");
    await applyAudit(db, row, { decision: decideAudit(shown, clean), audit: clean, pages: 1, usage: { input: 0, output: 0 } }, "test");
    await db.update(schema.fundingRounds).set({ amountAsWritten: "$90M" }).where(eq(schema.fundingRounds.id, acme.id));
    const [moved] = await db.select().from(schema.fundingRounds);
    expect(moved.disposition).toBe("review");
    expect(moved.pendingDisposition).not.toBeNull();
  });

  test("a hold keeps the row hidden with its reasons; a person's publish is its own audit", async () => {
    const db = await on();
    await persistRecords(db, [acme], "series-a-b", "run");
    const row = await roundForAudit(db, acme.id);
    if (!row) throw new Error("no row");
    const verdict = { ...clean, round_type: { kind: "debt_or_project_finance" as const, quote: "a credit facility", source: IR } };
    expect(
      await applyAudit(
        db,
        row,
        { decision: decideAudit(shown, verdict), audit: verdict, pages: 1, usage: { input: 0, output: 0 } },
        "test",
      ),
    ).toBe("held");
    const [held] = await db.select().from(schema.fundingRounds);
    expect(held).toMatchObject({ disposition: "review", pendingDisposition: null });
    expect(JSON.stringify(held.verification)).toContain("publication audit: not a private company's round");
    await setDisposition(db, acme.id, "publish");
    const [published] = await db.select().from(schema.fundingRounds);
    expect(published.disposition).toBe("publish");
  });

  test("with the gate off nothing changes", async () => {
    const db = await testDb();
    await persistRecords(db, [acme], "series-a-b", "run");
    await promote(db);
    const [row] = await db.select().from(schema.fundingRounds);
    expect(row.disposition).toBe("publish");
    expect(row.pendingDisposition).toBeNull();
  });
});
