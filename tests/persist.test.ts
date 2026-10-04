import type { FeedRecord } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { eq, sql } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { describe, expect, test } from "vitest";
import { corroborateRecord } from "../lib/corroborate";
import {
  claimDomain,
  countRounds,
  dispositionFor,
  isSameRound,
  listRounds,
  listSectors,
  mergeCompanies,
  mergeDuplicateRounds,
  persistRecords,
  reportRound,
  setDisposition,
  setStatus,
  toFeedRow,
} from "../lib/persist";
import {
  mergeDuplicateSources,
  reconcileRoundInvestors,
  rejectDirectoryRounds,
  rekeyInvestors,
  removeOrphanCompanies,
  resetData,
  settleDispositions,
  settleStoredDates,
  ungroundAmounts,
} from "../lib/repair";
import { visibilityEvidence } from "../lib/round-verification";
import { overview } from "../lib/stats";
import { record, testDb } from "./helpers";

const { companies } = schema;

/** A YYYY-MM-DD `daysAgo` days before now, so window tests hold whatever today is. */
function isoDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

async function checkedPublication(db: Db, ...ids: string[]): Promise<void> {
  for (const id of ids) {
    const [row] = (await listRounds(db, { ids: [id], includeReview: true })).rows;
    if (!row?.announced_on || !visibilityEvidence(row.sources, row.company.domain)) throw new Error(`No independent evidence for ${id}`);
    let searches = 0;
    const client = {
      async map() {
        return { links: [] };
      },
      async search() {
        searches++;
        return { news: [], web: [] };
      },
    } as unknown as Firecrawl;
    await corroborateRecord(db, client, id, { broad: true, rates: null });
    expect(searches).toBe(4);
    expect((await listRounds(db, { ids: [id], includeReview: true })).rows[0].freshness_checked_on).toBe(row.announced_on);
  }
}

describe("persistRecords", () => {
  test("round certainty migration is safe to rerun", async () => {
    const db = await testDb();
    const migration = await readFile("packages/core/drizzle/20260929200000_round_certainty/migration.sql", "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
    const [row] = await db.select({ certainty: schema.fundingRounds.certainty }).from(schema.fundingRounds).limit(1);
    expect(row).toBeUndefined();
  });

  test("an official closing upgrades an earlier press report in place and keeps its first sighting", async () => {
    const db = await testDb();
    const report = record({
      company_name: "Modal Labs",
      company_domain: "modal.com",
      company_website: "https://modal.com",
      stage: "growth",
      stage_as_written: "Growth",
      announced_date: "2026-09-01",
      certainty: "expected",
      amount: { value: 750, currency: "USD", as_written: "$750 million", usd_millions: 750, fx_rate: 1, fx_date: "2026-09-01" },
      valuation_as_written: "$15.75 billion",
      evidence_quotes: ["Modal Labs is nearing a $750 million round at a $15.75 billion valuation."],
    });
    await persistRecords(db, [report], "series-c-plus", "report");
    const [before] = await db.select().from(schema.fundingRounds);
    const different = record({
      ...report,
      id: "modal-labs:growth:2026-09-03",
      announced_date: "2026-09-03",
      certainty: "announced",
      amount: { ...report.amount, value: 50, usd_millions: 50, as_written: "$50M" },
      valuation_as_written: "$1 billion",
      evidence_quotes: ["Modal Labs raised $50M at a $1 billion valuation."],
    });
    await persistRecords(db, [different], "series-c-plus", "different");
    expect((await db.select().from(schema.fundingRounds)).length).toBe(2);
    const official = record({
      ...report,
      id: "modal-labs:growth:2026-11-01",
      announced_date: "2026-11-01",
      certainty: "announced",
      evidence_quotes: ["Modal Labs announced the close of its $750 million round."],
      sources: [{ url: "https://prnewswire.com/modal-closes", host: "prnewswire.com", title: "Modal closes its round" }],
    });
    const result = await persistRecords(db, [official], "series-c-plus", "official");
    expect(result.persistedIds).toEqual([report.id]);
    const [after] = await db.select().from(schema.fundingRounds).where(sql`${schema.fundingRounds.id} = ${report.id}`);
    expect(after).toMatchObject({
      id: report.id,
      certainty: "announced",
      reportedOn: "2026-09-01",
      announcedOn: "2026-11-01",
    });
    expect(after.firstSeenAt).toEqual(before.firstSeenAt);
    expect((after.verification as { notes: string[] }).notes).toContain("Reported before its announcement on 2026-09-01");
    expect(after.evidenceQuotes).toEqual(expect.arrayContaining(report.evidence_quotes));
    expect((await db.select().from(schema.fundingRounds)).length).toBe(2);
  });

  test("a newsletter's closing does not lift a scoop that the round is still being raised", async () => {
    const db = await testDb();
    const scoop = record({
      company_name: "Modal Labs",
      company_domain: "modal.com",
      stage: "growth",
      stage_as_written: "Growth",
      announced_date: "2026-09-28",
      certainty: "expected",
      amount: { value: 750, currency: "USD", as_written: "$750 million", usd_millions: 750, fx_rate: 1, fx_date: "2026-09-28" },
      evidence_quotes: ["Modal Labs is nearing a $750 million funding round led by Accel at a $15.75 billion valuation."],
      sources: [{ url: "https://techcrunch.com/modal-closing-in", host: "techcrunch.com", title: "Modal Labs closing in on $750M round" }],
    });
    await persistRecords(db, [scoop], "series-c-plus", "scoop");
    const roundup = record({
      ...scoop,
      certainty: "announced",
      evidence_quotes: ["Modal Labs raised $750M in a funding round at a $15.75B valuation led by Accel"],
      sources: [{ url: "https://scouts.yutori.com/funding", host: "scouts.yutori.com", title: "AI Startup Funding Announcements" }],
    });
    await persistRecords(db, [roundup], "series-c-plus", "roundup");
    const [row] = await db.select().from(schema.fundingRounds);
    expect(row.certainty).toBe("expected");
  });

  test("a low-tier closing does not stand against an established outlet's report that the round is still being raised", async () => {
    const db = await testDb();
    const round = record({
      company_name: "FieldAI",
      company_domain: "fieldai.com",
      stage: "series_c",
      stage_as_written: "Series C",
      announced_date: "2026-10-02",
      certainty: "announced",
      amount: { value: 700, currency: "USD", as_written: "$700M", usd_millions: 700, fx_rate: 1, fx_date: "2026-10-02" },
      evidence_quotes: ["FieldAI closed a $700 million round at a $10 billion valuation."],
      sources: [
        {
          url: "https://aiweekly.co/fieldai",
          host: "aiweekly.co",
          title: "FieldAI Lands $700M",
          evidence: "FieldAI closed a $700 million round at a $10 billion valuation.",
        },
        {
          url: "https://siliconangle.com/fieldai",
          host: "siliconangle.com",
          title: "FieldAI reportedly raising $700M",
          evidence: "FieldAI Inc. is reportedly seeking $700 million in funding.",
        },
      ],
    });
    await persistRecords(db, [round], "series-c-plus", "fieldai");
    const [row] = await db.select().from(schema.fundingRounds);
    expect(row.certainty).toBe("expected");
  });

  test("a later accepted Blue Origin closing upgrades its earlier seeking report without a second row", async () => {
    const db = await testDb();
    const expected = record({
      company_name: "Blue Origin",
      company_key: "blue origin",
      company_domain: "blueorigin.com",
      company_website: "https://blueorigin.com",
      stage: "growth",
      stage_as_written: "Growth",
      amount: { value: 10000, currency: "USD", as_written: "$10 billion", usd_millions: 10000, fx_rate: 1, fx_date: "2026-09-24" },
      announced_date: "2026-09-24",
      certainty: "expected",
      evidence_quotes: ["Blue Origin is working on a $10 billion funding round."],
      sources: [
        {
          url: "https://www.wsj.com/business/blue-origin-seeks-10-billion",
          host: "wsj.com",
          title: "Blue Origin Seeks $10 Billion in Funding Round",
        },
      ],
    });
    await persistRecords(db, [expected], "series-c-plus", "blue-expected");
    const [before] = await db.select().from(schema.fundingRounds);
    const announced = record({
      ...expected,
      id: "blue-origin:growth:2026-09-26",
      announced_date: "2026-09-26",
      certainty: "announced",
      evidence_quotes: ["Blue Origin raises $10 billion in its first outside financing round."],
      sources: [
        {
          url: "https://www.reuters.com/business/blue-origin-raises-10-billion",
          host: "reuters.com",
          title: "Blue Origin raises $10 billion in first outside funding",
        },
      ],
    });
    expect((await persistRecords(db, [announced], "series-c-plus", "blue-announced")).persistedIds).toEqual([expected.id]);
    const [after] = await db.select().from(schema.fundingRounds);
    expect(after).toMatchObject({ id: expected.id, certainty: "announced", announcedOn: "2026-09-26", reportedOn: "2026-09-24" });
    expect(after.firstSeenAt).toEqual(before.firstSeenAt);
    expect(after.evidenceQuotes).toEqual(expect.arrayContaining([...expected.evidence_quotes, ...announced.evidence_quotes]));
    expect((await db.select().from(schema.fundingRounds)).length).toBe(1);
  });

  test("a later unjudged stage guess cannot overwrite a verified Series B", async () => {
    const db = await testDb();
    const verified = record({
      id: "ema:series_b:2026-09-23",
      company_name: "Ema",
      stage: "series_b",
      stage_as_written: "Series B",
      verification: { status: "corrected", notes: [], url: "https://ema.example/news" },
    });
    await persistRecords(db, [verified], "series-a-b", "run-1");
    await checkedPublication(db, verified.id);
    await persistRecords(
      db,
      [{ ...verified, stage: "series_a", stage_as_written: "Series A", confidence: 0.9, verification: undefined }],
      "series-a-b",
      "run-2",
    );
    const { rows } = await listRounds(db, { ids: [verified.id] });
    expect(rows[0]).toMatchObject({ stage: "series_b", stage_as_written: "Series B", verification: { status: "corrected" } });
    expect(rows[0].sources).toHaveLength(1);
  });

  test("a judged stage correction outranks a higher-confidence unverified guess", async () => {
    const db = await testDb();
    const guessed = record({
      id: "ema:series_b:2026-09-23",
      company_name: "Ema",
      stage: "series_a",
      stage_as_written: "Series A",
      confidence: 0.9,
      verification: undefined,
    });
    await persistRecords(db, [guessed], "series-a-b", "run-1");
    await persistRecords(
      db,
      [
        {
          ...guessed,
          stage: "series_b",
          stage_as_written: "Series B",
          confidence: 0.61,
          verification: { status: "corrected", notes: [], url: "https://ema.example/news" },
        },
      ],
      "series-a-b",
      "run-2",
    );
    await checkedPublication(db, guessed.id);
    const { rows } = await listRounds(db, { ids: [guessed.id] });
    expect(rows[0]).toMatchObject({ stage: "series_b", stage_as_written: "Series B", verification: { status: "corrected" } });
  });

  test("inserts new records, dedupes on re-run, flips to updated when facts change", async () => {
    const db = await testDb();
    const acme = record({ company_name: "Acme", company_domain: "acme.com", company_website: "https://acme.com" });
    const first = await persistRecords(db, [acme], "series-a-b", "run-1");
    await checkedPublication(db, acme.id);
    expect(first).toMatchObject({ inserted: 1, updated: 0, unchanged: 0, changedIds: [acme.id] });

    const again = await persistRecords(db, [acme], "series-a-b", "run-2");
    expect(again).toMatchObject({ inserted: 0, updated: 0, unchanged: 1, changedIds: [] });

    const { rows } = await listRounds(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("new");
    expect(rows[0].company.domain).toBe("acme.com");
    expect(rows[0].lead_investors).toEqual(["Fund One"]);
    expect(rows[0].sources.map((s) => s.host)).toEqual(["reuters.com"]);

    const corrected = { ...acme, amount: { ...acme.amount, as_written: "$25M", value: 25, usd_millions: 25 } };
    const third = await persistRecords(db, [corrected], "series-a-b", "run-3");
    expect(third).toMatchObject({ updated: 1, changedIds: [acme.id] });
    // A change to a row nobody has read is not news to anyone: it stays new.
    let after = await listRounds(db);
    expect(after.rows[0].status).toBe("new");
    expect(after.rows[0].amount.usd_millions).toBe(25);
    // Once read, a change flips it to updated.
    await setStatus(db, [acme.id], "seen");
    const again2 = { ...corrected, lead_investors: ["Fund One", "Fund Two"] };
    await persistRecords(db, [again2], "series-a-b", "run-4");
    after = await listRounds(db);
    expect(after.rows[0].status).toBe("updated");
  });

  test("the OpenAI case: a Series A with no amount after verified billion-dollar rounds starts in review, with the reason", async () => {
    const db = await testDb();
    const noAmount = { value: null, currency: null, as_written: null, usd_millions: null, fx_rate: null, fx_date: null };
    await persistRecords(
      db,
      [
        record({
          company_name: "OpenAI",
          company_key: "openai",
          stage: "other",
          stage_as_written: "funding round",
          announced_date: "2025-03-31",
          amount: { value: 40, currency: "USD", as_written: "$40 billion", usd_millions: 40000, fx_rate: 1, fx_date: "2025-03-31" },
        }),
      ],
      "series-a-b",
      "run-1",
      { history: true },
    );
    const bogus = record({
      company_name: "OpenAI",
      company_key: "openai",
      stage: "series_a",
      stage_as_written: "Series A",
      announced_date: "2026-09-23",
      amount: noAmount,
      confidence: 0.8,
      evidence_quotes: ["megarounds for Silicon Valley-based OpenAI"],
    });
    await persistRecords(db, [bogus], "series-a-b", "run-2");
    const { rows } = await listRounds(db, { includeReview: true });
    const held = rows.find((r) => r.id === bogus.id);
    expect(held?.disposition).toBe("review");
    expect(
      held?.verification?.notes.some((n) => n.startsWith("held for review: a Series A with no amount after a verified other round")),
    ).toBe(true);
    // Without a freshness search, even this well-sourced reading waits in Review.
    const fresh = record({ company_name: "Acme", stage: "series_a", amount: noAmount });
    await persistRecords(db, [fresh], "series-a-b", "run-3");
    const acme = (await listRounds(db, { includeReview: true })).rows.find((r) => r.id === fresh.id);
    expect(acme?.disposition).toBe("review");
    // Known only from a weekly list, with no amount: review too.
    const listed = record({ company_name: "Globex", stage: "seed", amount: noAmount, date_precision: "week" });
    await persistRecords(db, [listed], "series-a-b", "run-4");
    expect((await listRounds(db, { includeReview: true })).rows.find((r) => r.id === listed.id)?.disposition).toBe("review");
  });

  test("the same round dated differently by two runs merges into one row within 45 days", async () => {
    const db = await testDb();
    const fromRelease = record({
      company_name: "HyImpulse",
      stage: "series_a",
      announced_date: "2026-09-02",
      amount: { value: 50, currency: "EUR", as_written: "€50 million", usd_millions: 58, fx_rate: 0.86, fx_date: "2026-09-02" },
      headquarters: "Germany",
    });
    await persistRecords(db, [fromRelease], "series-a-b", "run-1");
    await checkedPublication(db, fromRelease.id);
    const fromRoundup = record({
      company_name: "HyImpulse",
      stage: "series_a",
      announced_date: "2026-09-04",
      company_domain: "hyimpulse.com",
      company_website: "https://www.hyimpulse.com",
      headquarters: "Germany",
      sources: [{ url: "https://roundup.example/week", host: "roundup.example", title: "This week in funding" }],
    });
    const second = await persistRecords(db, [fromRoundup], "series-a-b", "run-2");
    expect(second.inserted).toBe(0);
    const { rows } = await listRounds(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(fromRelease.id);
    expect(rows[0].sources.map((s) => s.host).sort()).toEqual(["reuters.com", "roundup.example"]);
    expect(rows[0].company.website).toBe("https://www.hyimpulse.com");

    // A genuinely separate round of the same stage, months later and for another amount, stays separate.
    const later = record({
      company_name: "HyImpulse",
      stage: "series_a",
      announced_date: "2026-12-20",
      amount: { value: 35, currency: "USD", as_written: "$35M", usd_millions: 35, fx_rate: 1, fx_date: "2026-12-20" },
    });
    await persistRecords(db, [later], "series-a-b", "run-3");
    expect((await listRounds(db, { includeReview: true })).rows).toHaveLength(2);
  });

  test("mergeDuplicateRounds folds pre-existing duplicates into the earliest row", async () => {
    const db = await testDb();
    // Insert two rows directly with different ids, as a store built before the window rule would hold.
    const a = record({ company_name: "Conveo", stage: "series_a", announced_date: "2026-09-02", lead_investors: ["DST Global"] });
    const b = record({
      company_name: "Conveo",
      stage: "series_a",
      announced_date: "2026-09-04",
      lead_investors: ["Balderton"],
      sources: [{ url: "https://prnewswire.com/conveo", host: "prnewswire.com", title: "Conveo raises funding" }],
    });
    await persistRecords(db, [a], "series-a-b", "run-1");
    // Bypass the merge by persisting b under a company key variant, then restoring the key.
    await persistRecords(db, [{ ...b, company_key: "conveo-tmp", id: "conveo-tmp:series_a:2026-09-04" }], "series-a-b", "run-2");
    await checkedPublication(db, a.id, "conveo-tmp:series_a:2026-09-04");
    await db.execute(sql`update companies set name_key = 'conveo', hq = 'London' where id in ('conveo', 'conveo-tmp')`);
    expect((await listRounds(db)).rows).toHaveLength(2);
    const { merged } = await mergeDuplicateRounds(db);
    expect(merged).toBe(1);
    const { rows } = await listRounds(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].announced_on).toBe("2026-09-02");
    expect(rows[0].sources.map((s) => s.host).sort()).toEqual(["prnewswire.com", "reuters.com"]);
    expect(rows[0].lead_investors.sort()).toEqual(["Balderton", "DST Global"]);
  });

  test("duplicate-row merge keeps a later closing over an earlier expected report", async () => {
    const db = await testDb();
    const early = record({
      company_name: "Blue Origin",
      company_key: "blue-origin",
      stage: "growth",
      stage_as_written: "Growth",
      announced_date: "2026-09-24",
      certainty: "expected",
      amount: { value: 10000, currency: "USD", as_written: "$10 billion", usd_millions: 10000, fx_rate: 1, fx_date: "2026-09-24" },
      evidence_quotes: ["Blue Origin is working on a $10 billion funding round."],
      sources: [{ url: "https://www.wsj.com/blue-origin-seeks", host: "wsj.com", title: "Blue Origin Seeks $10 Billion" }],
    });
    await persistRecords(db, [early], "series-c-plus", "blue-early");
    const [stored] = await db.select().from(schema.fundingRounds);
    const closingQuote = "Blue Origin raises $10 billion in its first outside financing round.";
    await db.insert(schema.fundingRounds).values({
      ...stored,
      id: "blue-origin:growth:2026-09-26",
      announcedOn: "2026-09-26",
      certainty: "announced",
      evidenceQuotes: [closingQuote],
    });
    expect((await mergeDuplicateRounds(db)).merged).toBe(1);
    const { rows } = await listRounds(db, { includeReview: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ certainty: "announced", announced_on: "2026-09-26" });
    expect(rows[0].evidence_quotes).toEqual(expect.arrayContaining([...early.evidence_quotes, closingQuote]));
  });

  test("mergeDuplicateRounds keeps the surest row across a stage disagreement, and never bridges into debt", async () => {
    const db = await testDb();
    // A background mention mis-read as a Series B at 0.61, and the real Series C at 0.94, same day.
    const weak = record({
      company_name: "Wonderful",
      stage: "series_b",
      stage_as_written: "Series B",
      announced_date: "2026-09-04",
      confidence: 0.61,
    });
    const sure = record({
      company_name: "Wonderful",
      stage: "series_c",
      stage_as_written: "Series C",
      announced_date: "2026-09-04",
      confidence: 0.94,
    });
    const debt = record({
      company_name: "Wonderful",
      stage: "debt",
      stage_as_written: "credit facility",
      announced_date: "2026-09-04",
      confidence: 0.8,
    });
    await persistRecords(db, [weak], "series-a-b", "run-1");
    await persistRecords(db, [{ ...sure, company_key: "wonderful-tmp", id: "wonderful-tmp:series_c:2026-09-04" }], "growth", "run-2");
    await persistRecords(db, [{ ...debt, company_key: "wonderful-tmp2", id: "wonderful-tmp2:debt:2026-09-04" }], "growth", "run-3");
    await db.execute(sql`update companies set name_key = 'wonderful' where id in ('wonderful-tmp', 'wonderful-tmp2')`);
    const { merged } = await mergeDuplicateRounds(db);
    expect(merged).toBe(1);
    const rows = (await listRounds(db, { includeReview: true })).rows.filter((r) => r.company.name === "Wonderful");
    expect(rows.map((r) => r.stage).sort()).toEqual(["debt", "series_c"]);
    expect(isSameRound({ stage: "series_b", announcedOn: "2026-09-04" }, { stage: "debt", announcedOn: "2026-09-04" })).toBe(false);
  });

  test("rekeyInvestors folds spellings of one firm stored under old keys", async () => {
    const db = await testDb();
    const chipco = record({ company_name: "Chipco", lead_investors: ["Arm"], other_investors: ["M12"] });
    await persistRecords(db, [chipco], "series-a-b", "run-1");
    await checkedPublication(db, chipco.id);
    // Rows written before the investor key existed: id was the plain company key of the long spelling.
    await db.execute(
      sql`insert into investors (id, name) values ('arm holdings', 'Arm Holdings'), ('m12 microsoft s venture fund', 'M12 – Microsoft''s Venture Fund')`,
    );
    const [{ id }] = (await listRounds(db)).rows;
    await db.execute(
      sql`insert into round_investors (round_id, investor_id, role) values (${id}, 'arm holdings', 'participant'), (${id}, 'm12 microsoft s venture fund', 'participant')`,
    );
    expect((await listRounds(db)).rows[0].other_investors).toHaveLength(3);

    const { merged } = await rekeyInvestors(db);
    expect(merged).toBe(2);
    const [after] = (await listRounds(db)).rows;
    expect(after.lead_investors).toEqual(["Arm Holdings"]);
    expect(after.other_investors).toEqual(["M12 – Microsoft's Venture Fund"]);
    const names = await db.execute(sql`select id, name from investors order by id`);
    expect(names.rows).toEqual([
      { id: "arm", name: "Arm Holdings" },
      { id: "m12", name: "M12 – Microsoft's Venture Fund" },
    ]);
  });

  test("mergeDuplicateSources folds a tracked URL into its canonical page; orphan companies go after a merge", async () => {
    const db = await testDb();
    const tracked = record({
      company_name: "Tracked",
      sources: [
        { url: "https://www.reuters.com/story/tracked-raises-b64c1b60?mod=markets", host: "reuters.com" },
        { url: "https://www.reuters.com/story/tracked-raises-b64c1b60", host: "reuters.com" },
      ],
    });
    await persistRecords(db, [tracked], "series-a-b", "run-1");
    await checkedPublication(db, tracked.id);
    // Written before canonicalUrl stripped ?mod=, the tracked URL got its own source row.
    await db.execute(
      sql`insert into sources (id, url, host) values ('https://www.reuters.com/story/tracked-raises-b64c1b60?mod=markets', 'https://www.reuters.com/story/tracked-raises-b64c1b60?mod=markets', 'reuters.com') on conflict do nothing`,
    );
    const [{ id }] = (await listRounds(db)).rows;
    await db.execute(
      sql`insert into round_sources (round_id, source_id) values (${id}, 'https://www.reuters.com/story/tracked-raises-b64c1b60?mod=markets') on conflict do nothing`,
    );
    const before = (await listRounds(db)).rows[0].sources.length;
    const { merged } = await mergeDuplicateSources(db);
    expect(merged).toBe(before - 1);
    expect((await listRounds(db)).rows[0].sources.map((s) => s.url)).toEqual(["https://www.reuters.com/story/tracked-raises-b64c1b60"]);

    await db.execute(sql`insert into companies (id, name, name_key) values ('ghost', 'Ghost', 'ghost')`);
    await db.execute(sql`insert into enrichments (company_id, kind, data) values ('ghost', 'profile', '{}'::jsonb)`);
    expect(await removeOrphanCompanies(db)).toEqual({ removed: 1 });
    expect((await db.execute(sql`select count(*)::int n from companies`)).rows[0].n).toBe(1);
  });

  test("isSameRound: same stage within 45 days, any stage within a week, undated only on a stage match", () => {
    expect(isSameRound({ stage: "seed", announcedOn: "2026-09-01" }, { stage: "seed", announcedOn: "2026-10-10" })).toBe(true);
    expect(isSameRound({ stage: "seed", announcedOn: "2026-09-01" }, { stage: "seed", announcedOn: "2026-10-20" })).toBe(false);
    expect(isSameRound({ stage: "seed", announcedOn: "2026-09-04" }, { stage: "pre_seed", announcedOn: "2026-09-04" })).toBe(true);
    expect(isSameRound({ stage: "seed", announcedOn: "2026-09-01" }, { stage: "series_a", announcedOn: "2026-09-07" })).toBe(true);
    expect(isSameRound({ stage: "seed", announcedOn: "2026-09-01" }, { stage: "series_a", announcedOn: "2026-09-09" })).toBe(false);
    expect(isSameRound({ stage: "seed", announcedOn: null }, { stage: "seed", announcedOn: "2026-09-09" })).toBe(true);
    expect(isSameRound({ stage: "seed", announcedOn: null }, { stage: "pre_seed", announcedOn: "2026-09-09" })).toBe(false);
  });

  test("isSameRound: two equity rounds at the same amount inside the stage window are one round whatever the labels", () => {
    // A company does not close two equal rounds a month apart; the labels disagree, the money agrees.
    expect(
      isSameRound(
        { stage: "series_a", announcedOn: "2026-07-07", amountUsdMillions: 468 },
        { stage: "series_b", announcedOn: "2026-07-31", amountUsdMillions: 468 },
      ),
    ).toBe(true);
    // Amounts more than 10 percent of the larger apart stay two rounds.
    expect(
      isSameRound(
        { stage: "series_a", announcedOn: "2026-07-07", amountUsdMillions: 468 },
        { stage: "series_b", announcedOn: "2026-07-31", amountUsdMillions: 400 },
      ),
    ).toBe(false);
    // Outside the stage window the amount does not bridge.
    expect(
      isSameRound(
        { stage: "series_a", announcedOn: "2026-07-07", amountUsdMillions: 468 },
        { stage: "series_b", announcedOn: "2026-08-26", amountUsdMillions: 468 },
      ),
    ).toBe(false);
    // A debt or grant label is its own round at any amount.
    expect(
      isSameRound(
        { stage: "series_b", announcedOn: "2026-07-07", amountUsdMillions: 468 },
        { stage: "debt", announcedOn: "2026-07-31", amountUsdMillions: 468 },
      ),
    ).toBe(false);
    // No amount on either side: the old answer stands.
    expect(isSameRound({ stage: "series_a", announcedOn: "2026-07-07" }, { stage: "series_b", announcedOn: "2026-07-31" })).toBe(false);
    expect(
      isSameRound(
        { stage: "series_a", announcedOn: "2026-07-07", amountUsdMillions: 468 },
        { stage: "series_b", announcedOn: "2026-07-31", amountUsdMillions: null },
      ),
    ).toBe(false);
  });

  test("a second reading at the same amount and a different stage merges into the one round", async () => {
    const db = await testDb();
    const money = { value: 468, currency: "USD", as_written: "$468M", usd_millions: 468, fx_rate: 1, fx_date: "2026-07-07" };
    await persistRecords(
      db,
      [record({ company_name: "Proxima", stage: "series_a", stage_as_written: "Series A", announced_date: "2026-07-07", amount: money })],
      "series-a-b",
      "run-1",
    );
    const second = await persistRecords(
      db,
      [
        record({
          company_name: "Proxima",
          stage: "series_b",
          stage_as_written: "Series B",
          announced_date: "2026-07-31",
          amount: { ...money, fx_date: "2026-07-31" },
        }),
      ],
      "series-a-b",
      "run-2",
    );
    expect(second.inserted).toBe(0);
    const rows = (await listRounds(db, { includeReview: true })).rows.filter((r) => r.company.name === "Proxima");
    expect(rows).toHaveLength(1);
  });

  test("one company, one week, two stage labels is one round, and the surer label names it", async () => {
    const db = await testDb();
    // A roundup calls it seed at 0.61; the press release says pre-Series A (pre_seed) at 0.86.
    const roundup = record({
      company_name: "Zenergize",
      stage: "seed",
      stage_as_written: "seed",
      announced_date: "2026-09-04",
      confidence: 0.61,
    });
    await persistRecords(db, [roundup], "seed", "run-1");
    const press = record({
      company_name: "Zenergize",
      stage: "pre_seed",
      stage_as_written: "pre-Series A",
      announced_date: "2026-09-04",
      confidence: 0.86,
    });
    const second = await persistRecords(db, [press], "seed", "run-2");
    expect(second.inserted).toBe(0);
    const rows = (await listRounds(db, { includeReview: true })).rows.filter((r) => r.company.name === "Zenergize");
    expect(rows).toHaveLength(1);
    expect(rows[0].stage).toBe("pre_seed");
    expect(rows[0].stage_as_written).toBe("pre-Series A");
    // The reverse order keeps the surer label too: a weaker later reading does not rename the round.
    const weaker = record({
      company_name: "Zenergize",
      stage: "seed",
      stage_as_written: "seed",
      announced_date: "2026-09-05",
      confidence: 0.5,
    });
    await persistRecords(db, [weaker], "seed", "run-3");
    const after = (await listRounds(db, { includeReview: true })).rows.filter((r) => r.company.name === "Zenergize");
    expect(after).toHaveLength(1);
    expect(after[0].stage).toBe("pre_seed");
  });

  test("a company seen by name and then by domain is one row, and a learned domain another row owns folds the two together", async () => {
    const db = await testDb();
    // A roundup names the company; the press release knows its site. Two ids until they meet.
    await persistRecords(db, [record({ company_name: "Zenergize", stage: "seed", announced_date: "2026-08-01" })], "seed", "run-1");
    await persistRecords(
      db,
      [
        record({
          company_name: "Zenergize Technologies",
          company_key: "zenergize technologies",
          company_domain: "zenergize.in",
          company_website: "https://zenergize.in",
          sources: [{ url: "https://zenergize.in/news/series-a", host: "zenergize.in", title: "Zenergize Series A" }],
          stage: "series_a",
          announced_date: "2026-05-01",
        }),
      ],
      "series-a-b",
      "run-2",
    );
    const before = await db.select({ id: companies.id }).from(companies);
    expect(before.map((c) => c.id).sort()).toEqual(["zenergize", "zenergize.in"]);
    // Enrichment learns the name-keyed row's domain: it belongs to the other row, so the two merge.
    expect(await claimDomain(db, "zenergize", "zenergize.in")).toBe("zenergize.in");
    const after = await db.select({ id: companies.id, name: companies.name }).from(companies);
    expect(after).toEqual([{ id: "zenergize.in", name: "Zenergize Technologies" }]);
    const rounds = (await listRounds(db, { includeReview: true })).rows.filter((r) => r.company.id === "zenergize.in");
    expect(rounds.map((r) => r.stage).sort()).toEqual(["seed", "series_a"]);
    // A domain nobody owns stays with the candidate.
    expect(await claimDomain(db, "zenergize.in", "zenergize.in")).toBe("zenergize.in");
    expect(await claimDomain(db, "acme", null)).toBe("acme");
  });

  test("a later reading never degrades a fact to nothing, and disposition respects the evidence", async () => {
    const db = await testDb();
    const full = record({ company_name: "Keepco", announced_date: "2026-09-02", confidence: 0.9 });
    await persistRecords(db, [full], "series-a-b", "run-1");
    await checkedPublication(db, full.id);
    // The same round read again from a thinner page, unjudged: no date, no amount, lower confidence.
    const thin = {
      ...full,
      announced_date: null,
      undated: true,
      confidence: 0.55,
      amount: { ...full.amount, value: null, as_written: null, usd_millions: null },
      verification: undefined,
    };
    await persistRecords(db, [thin], "series-a-b", "run-2");
    const [row] = (await listRounds(db, { includeReview: true })).rows.filter((r) => r.company.name === "Keepco");
    expect(row.announced_on).toBe("2026-09-02");
    expect(row.amount.as_written).toBe("$20M");
    expect(row.disposition).toBe("publish");
    // Disposition: no amount means flagged at best; no date means review.
    expect(dispositionFor({ undated: false, confidence: 0.9, amount: { as_written: null } })).toBe("flagged");
    // Publish means the page confirmed the record; an unjudged record is flagged, a contradicted one is review.
    const ok = { status: "confirmed" as const, notes: [], url: null };
    expect(dispositionFor({ undated: false, confidence: 0.9, amount: { as_written: "$5M" }, verification: ok })).toBe("publish");
    expect(dispositionFor({ undated: false, confidence: 0.9, amount: { as_written: "$5M" } })).toBe("flagged");
    expect(
      dispositionFor({ undated: false, confidence: 0.9, amount: { as_written: "$5M" }, verification: { ...ok, status: "corrected" } }),
    ).toBe("publish");
    expect(
      dispositionFor({ undated: false, confidence: 0.9, amount: { as_written: "$5M" }, verification: { ...ok, status: "contradicted" } }),
    ).toBe("review");
    expect(
      dispositionFor({ undated: false, confidence: 0.9, amount: { as_written: "$5M" }, verification: { ...ok, status: "skipped" } }),
    ).toBe("flagged");
    expect(dispositionFor({ undated: true, confidence: 0.9, amount: { as_written: "$5M" } })).toBe("review");
  });

  test("resetData removes what the pipeline wrote and keeps what the operator configured", async () => {
    const db = await testDb();
    await persistRecords(db, [record({ company_name: "Gone Co", lead_investors: ["Fund One"] })], "series-a-b", "run-1");
    await db.execute(sql`insert into settings (key, value) values ('coverage', '{"tier":"standard","overrides":{}}'::jsonb)`);
    await db.execute(sql`insert into feed_tokens (token_hash, label, preset_slug) values ('tok', 'Slack', 'series-a-b')`);
    const gone = await resetData(db);
    expect(gone).toEqual({ rounds: 1, companies: 1, sources: 1 });
    expect((await listRounds(db, { includeReview: true })).rows).toEqual([]);
    expect((await db.execute(sql`select count(*)::int n from investors`)).rows[0].n).toBe(0);
    expect((await db.execute(sql`select count(*)::int n from settings`)).rows[0].n).toBe(1);
    expect((await db.execute(sql`select count(*)::int n from feed_tokens`)).rows[0].n).toBe(1);
  });

  test("a surer date replaces a rougher one across runs, and a rougher one never replaces a surer", async () => {
    const db = await testDb();
    // A weekly roundup dates the round to its own Friday; the press release two days earlier is the day.
    const fromRoundup = record({ company_name: "Datey", announced_date: "2026-09-04", date_precision: "week", confidence: 0.8 });
    await persistRecords(db, [fromRoundup], "series-a-b", "run-1");
    const fromRelease = { ...fromRoundup, id: fromRoundup.id, announced_date: "2026-09-02", date_precision: "day" as const };
    await persistRecords(db, [fromRelease], "series-a-b", "run-2");
    await checkedPublication(db, fromRoundup.id);
    let [row] = (await listRounds(db)).rows.filter((r) => r.company.name === "Datey");
    expect(row.announced_on).toBe("2026-09-02");
    expect(row.date_precision).toBe("day");
    // A later roundup reading with its Friday does not move the day.
    await persistRecords(db, [{ ...fromRoundup, id: row.id, announced_date: "2026-09-11" }], "series-a-b", "run-3");
    [row] = (await listRounds(db)).rows.filter((r) => r.company.name === "Datey");
    expect(row.announced_on).toBe("2026-09-02");
    expect(row.date_precision).toBe("day");
  });

  test("settleStoredDates moves a borrowed day to a surer sibling in the row, sharpens a rough one, and leaves a stated day", async () => {
    const db = await testDb();
    const sib = {
      url: "https://siliconangle.com/2026/09/04/gimlet-raises/",
      host: "siliconangle.com",
      title: "Gimlet raises",
      published: "2026-09-04",
    };
    const borrowed = record({
      id: "gimlet:series_a:2026-09-05",
      company_name: "Gimlet",
      company_key: "gimlet",
      announced_date: "2026-09-05",
      date_precision: "day",
      date_basis: "page",
      sources: [{ url: "https://wowtale.example/gimlet", host: "wowtale.example", title: "Gimlet raises", published: "2026-09-05" }, sib],
    });
    const stated = record({
      id: "acme:series_a:2026-09-05",
      company_name: "Acme",
      company_key: "acme",
      announced_date: "2026-09-05",
      date_precision: "day",
      date_basis: "stated",
      sources: [
        { url: "https://wowtale.example/acme", host: "wowtale.example", title: "Acme raises", published: "2026-09-05" },
        { ...sib, url: "https://siliconangle.com/2026/09/04/acme-raises/" },
      ],
    });
    const rough = record({
      id: "beta:series_a:2026-09-06",
      company_name: "Beta",
      company_key: "beta",
      announced_date: "2026-09-06",
      date_precision: "week",
      date_basis: "page",
      sources: [
        { url: "https://newsletter.example/issue-12", host: "newsletter.example", title: "Deals of the week", published: "2026-09-06" },
        {
          url: "https://www.prnewswire.com/news-releases/beta-raises-20m-302400000.html",
          host: "www.prnewswire.com",
          title: "Beta Raises $20M",
          published: "2026-09-03",
        },
      ],
    });
    await persistRecords(db, [borrowed, stated, rough], "series-a-b", "run-1");
    const r = await settleStoredDates(db);
    expect(r).toEqual({ moved: 2, sharpened: 0 });
    const rows = (await listRounds(db, { includeReview: true })).rows;
    const byName = (n: string) => rows.find((x) => x.company.name === n);
    expect(byName("Gimlet")?.announced_on).toBe("2026-09-04");
    expect(byName("Acme")?.announced_on).toBe("2026-09-05");
    expect(byName("Beta")?.announced_on).toBe("2026-09-03");
    expect(byName("Beta")?.date_precision).toBe("day");
    // Idempotent.
    expect(await settleStoredDates(db)).toEqual({ moved: 0, sharpened: 0 });
  });

  test("reportRound sends a row back to review with the reader's reason appended to the verifier's notes", async () => {
    const db = await testDb();
    const judged = record({
      company_name: "Reported Co",
      confidence: 0.9,
      verification: { status: "confirmed", notes: ["leads: Fund One (news.example)"], url: "https://news.example/acme", verifier: "judge" },
    });
    await persistRecords(db, [judged], "series-a-b", "run-1");
    await checkedPublication(db, judged.id);
    expect((await listRounds(db)).rows[0].disposition).toBe("publish");
    await reportRound(db, judged.id, "  amount is the valuation ");
    const [row] = (await listRounds(db, { reviewOnly: true })).rows;
    expect(row.id).toBe(judged.id);
    expect(row.verification).toEqual({
      status: "confirmed",
      notes: ["leads: Fund One (news.example)", "held for review: earliest-report search pending", "reported: amount is the valuation"],
      url: "https://news.example/acme",
      verifier: "judge",
    });
    // A row never verified gets a verification that holds only the report.
    const bare = record({ company_name: "Bare Co", confidence: 0.9, verification: undefined });
    await persistRecords(db, [bare], "series-a-b", "run-2");
    await reportRound(db, bare.id, "wrong company");
    const bareRow = (await listRounds(db, { reviewOnly: true })).rows.find((x) => x.company.name === "Bare Co");
    expect(bareRow?.verification).toEqual({
      status: "unverified",
      notes: ["held for review: earliest-report search pending", "reported: wrong company"],
      url: null,
    });
    // An id nothing owns is a no-op.
    await reportRound(db, "nope", "x");
    expect((await listRounds(db, { reviewOnly: true })).rows).toHaveLength(2);
  });

  test("rejectDirectoryRounds rejects rows whose only sources are directory pages or whose evidence is a table row, and leaves articles", async () => {
    const db = await testDb();
    const portfolio = record({
      id: "thinkingdata:series_c:2026-09-05",
      company_name: "ThinkingData",
      company_key: "thinkingdata",
      evidence_quotes: ["$93M raised · Series C1 · Seoul, South Korea"],
      sources: [
        {
          url: "https://startupfundraising.com/companies/backed-by/blue-lake-capital",
          host: "startupfundraising.com",
          title: "Companies Backed by Blue Lake Capital: Funding Raised",
        },
      ],
    });
    const article = record({
      id: "acme:series_a:2026-09-02",
      company_name: "Acme",
      company_key: "acme",
      evidence_quotes: ["Acme raised $20M in a Series A led by Sequoia."],
      sources: [{ url: "https://techcrunch.com/2026/09/02/acme-raises-20m/", host: "techcrunch.com", title: "Acme raises $20M" }],
    });
    // A weekly roundup lists this week's rounds as table rows: news, not a directory.
    const weekly = record({
      id: "volve:seed:2026-08-31",
      company_name: "Volve",
      company_key: "volve",
      evidence_quotes: ["Volve · Seed · NOK 20M · Oslo"],
      sources: [
        {
          url: "https://trysignalbase.com/news/funding/funding-rounds-norway-week-of-2026-08-31",
          host: "trysignalbase.com",
          title: "Funding rounds Norway: week of 2026-08-31",
        },
      ],
    });
    await persistRecords(db, [portfolio, article, weekly], "series-a-b", "run-1");
    expect(await rejectDirectoryRounds(db)).toEqual({ rejected: 1 });
    expect((await listRounds(db, { includeReview: true })).rows.find((x) => x.company.name === "Volve")?.disposition).not.toBe("rejected");
    const rows = (await listRounds(db, { includeReview: true })).rows;
    const t = rows.find((x) => x.company.name === "ThinkingData");
    expect(t?.disposition).toBe("rejected");
    expect(t?.verification?.status).toBe("not_news");
    expect(t?.verification?.notes.join(" | ")).toContain("directory page");
    expect(rows.find((x) => x.company.name === "Acme")?.disposition).not.toBe("rejected");
    expect(await rejectDirectoryRounds(db)).toEqual({ rejected: 0 });
  });

  test("ungroundAmounts clears an amount the evidence never stated and drops a published row to flagged", async () => {
    const db = await testDb();
    const volta = record({
      company_name: "Volta",
      amount: { value: 10000, currency: "USD", as_written: "$10 billion", usd_millions: 10000, fx_rate: 1, fx_date: "2026-08-04" },
      evidence_quotes: ["a16z is excited to co-lead its Series A."],
      confidence: 0.9,
    });
    const fine = record({ company_name: "Fine Co", evidence_quotes: ["Fine Co raised $20M in Series A funding."], confidence: 0.9 });
    await persistRecords(db, [volta, fine], "series-a-b", "run-1");
    await checkedPublication(db, volta.id, fine.id);
    const r = await ungroundAmounts(db);
    expect(r.cleared).toBe(1);
    const rows = (await listRounds(db, { includeReview: true })).rows;
    const v = rows.find((x) => x.company.name === "Volta");
    const f = rows.find((x) => x.company.name === "Fine Co");
    expect(v?.amount.as_written).toBeNull();
    expect(v?.amount.usd_millions).toBeNull();
    expect(v?.disposition).toBe("flagged");
    expect(f?.amount.as_written).toBe("$20M");
    expect(f?.disposition).toBe("publish");
  });

  test("a round's investors are one set across runs: a second spelling of a linked firm folds into it, a placeholder never lands", async () => {
    const db = await testDb();
    const first = record({
      company_name: "Gimlet Labs",
      lead_investors: ["Andreessen Horowitz"],
      other_investors: ["M12 – Microsoft's Venture Fund", "Arm Holdings"],
    });
    await persistRecords(db, [first], "series-a-b", "run-1");
    await checkedPublication(db, first.id);
    // Corroboration brings the same firms under other spellings, plus a placeholder.
    const second = {
      ...first,
      lead_investors: ["a16z"],
      other_investors: ["Microsoft Corp.'s M12 fund", "Arm", "more than a dozen others"],
    };
    await persistRecords(db, [second], "series-a-b", "run-2");
    const [row] = (await listRounds(db, { includeReview: true })).rows.filter((r) => r.company.name === "Gimlet Labs");
    expect(row.lead_investors).toEqual(["Andreessen Horowitz"]);
    expect(row.other_investors.sort()).toEqual(["Arm Holdings", "M12 – Microsoft's Venture Fund"]);
    const n = (await db.execute(sql`select count(*)::int n from round_investors where round_id = ${row.id}`)).rows[0].n;
    expect(n).toBe(3);
  });

  test("reconcileRoundInvestors folds spellings already linked to a round and removes the investor rows nothing links to", async () => {
    const db = await testDb();
    const r = record({ company_name: "Old Rows", lead_investors: ["Carlyle Group"], other_investors: ["Sequoia Capital"] });
    await persistRecords(db, [r], "series-a-b", "run-1");
    await checkedPublication(db, r.id);
    // Links written before reconciliation: a second spelling of the lead as a participant, and a placeholder.
    await db.execute(
      sql`insert into investors (id, name) values ('carlyle managed funds', 'Carlyle-managed funds'), ('undisclosed investors', 'undisclosed investors')`,
    );
    await db.execute(
      sql`insert into round_investors (round_id, investor_id, role) values (${r.id}, 'carlyle managed funds', 'participant'), (${r.id}, 'undisclosed investors', 'participant')`,
    );
    const out = await reconcileRoundInvestors(db);
    expect(out.folded).toBe(2);
    expect(out.orphans).toBe(2);
    const [row] = (await listRounds(db, { includeReview: true })).rows.filter((x) => x.company.name === "Old Rows");
    expect(row.lead_investors).toEqual(["Carlyle Group"]);
    expect(row.other_investors).toEqual(["Sequoia Capital"]);
  });

  test("an unsearched judged or unjudged record waits in Review; a checked judged record keeps its verdict on an unjudged re-read", async () => {
    const db = await testDb();
    await persistRecords(db, [record({ company_name: "Judged Co", confidence: 0.9 })], "series-a-b", "run-1");
    await persistRecords(db, [record({ company_name: "Unjudged Co", confidence: 0.9, verification: undefined })], "series-a-b", "run-1");
    let rows = (await listRounds(db, { includeReview: true })).rows;
    expect(rows.find((r) => r.company.name === "Judged Co")?.disposition).toBe("review");
    expect(rows.find((r) => r.company.name === "Unjudged Co")?.disposition).toBe("review");
    await checkedPublication(db, "judged-co:series_a:2026-09-02", "unjudged-co:series_a:2026-09-02");
    rows = (await listRounds(db)).rows;
    expect(rows.find((r) => r.company.name === "Judged Co")?.disposition).toBe("publish");
    expect(rows.find((r) => r.company.name === "Judged Co")?.verification?.status).toBe("confirmed");
    expect(rows.find((r) => r.company.name === "Unjudged Co")?.disposition).toBe("flagged");
    expect(rows.find((r) => r.company.name === "Unjudged Co")?.verification).toMatchObject({
      status: "unverified",
      notes: ["held for review: earliest-report search pending"],
    });
    // A filing that matches the judged round carries no verdict; the row keeps its own.
    const judged = record({ company_name: "Judged Co", confidence: 0.9 });
    await persistRecords(
      db,
      [{ ...judged, verification: undefined, stage: "other", stage_as_written: "Form D (equity)" }],
      "form-d",
      "run-2",
      { startIn: "review" },
    );
    rows = (await listRounds(db, { includeReview: true })).rows;
    expect(rows.find((r) => r.company.name === "Judged Co")?.verification?.status).toBe("confirmed");
    expect(rows.find((r) => r.company.name === "Judged Co")?.disposition).toBe("publish");
  });

  test("a checked flagged row follows read-back evidence, a filing never demotes it, and store repair catches stale dispositions", async () => {
    const db = await testDb();
    // Persisted before any read-back: flagged for a reader.
    await persistRecords(db, [record({ company_name: "Late Read", confidence: 0.9, verification: undefined })], "series-a-b", "run-1");
    expect((await listRounds(db, { reviewOnly: true })).rows.map((r) => r.company.name)).toEqual(["Late Read"]);
    await checkedPublication(db, "late-read:series_a:2026-09-02");
    expect((await listRounds(db)).rows.find((r) => r.company.name === "Late Read")?.disposition).toBe("flagged");
    // A Form D that matches it starts its own rows in review and leaves this one where it is.
    const same = record({ company_name: "Late Read", confidence: 0.9, verification: undefined });
    await persistRecords(db, [{ ...same, stage: "other", stage_as_written: "Form D (equity)" }], "form-d", "run-2", { startIn: "review" });
    expect((await listRounds(db)).rows.find((r) => r.company.name === "Late Read")?.disposition).toBe("flagged");
    // The read-back confirms it: it publishes.
    await persistRecords(db, [record({ company_name: "Late Read", confidence: 0.9 })], "series-a-b", "reconcile:2026-09-07");
    expect((await listRounds(db)).rows.find((r) => r.company.name === "Late Read")?.disposition).toBe("publish");
    // A reviewer's publish stands against a later reading that lowered the score.
    await persistRecords(db, [record({ company_name: "Late Read", confidence: 0.6 })], "series-a-b", "run-3");
    expect((await listRounds(db)).rows.find((r) => r.company.name === "Late Read")?.disposition).toBe("publish");

    // A store built before the rule: confirmed rows left on flagged, and a contradicted one left off review.
    await persistRecords(db, [record({ company_name: "Stuck Co", confidence: 0.9 })], "series-a-b", "run-4");
    await checkedPublication(db, "stuck-co:series_a:2026-09-02");
    const stuck = (await listRounds(db)).rows.find((r) => r.company.name === "Stuck Co");
    if (!stuck) throw new Error("missing");
    await setDisposition(db, stuck.id, "flagged");
    await persistRecords(
      db,
      [record({ company_name: "Denied Co", confidence: 0.9, verification: { status: "contradicted", notes: [], url: null } })],
      "series-a-b",
      "run-4",
    );
    const denied = (await listRounds(db, { includeReview: true })).rows.find((r) => r.company.name === "Denied Co");
    if (!denied) throw new Error("missing");
    await setDisposition(db, denied.id, "flagged");
    const moved = await settleDispositions(db);
    expect(moved).toEqual({ published: 1, reviewed: 1, flagged: 0 });
    const after = (await listRounds(db, { includeReview: true })).rows;
    expect(after.find((r) => r.company.name === "Stuck Co")?.disposition).toBe("publish");
    expect(after.find((r) => r.company.name === "Denied Co")?.disposition).toBe("review");
  });

  test("a judged record's investor lists are the page's whole word: a firm the judge did not name leaves the row, a fuller spelling on the row still shows", async () => {
    const db = await testDb();
    const first = record({
      company_name: "Lyte",
      lead_investors: ["Andreessen Horowitz"],
      other_investors: ["Exor Ventures", "Fidelity Management & Research"],
      verification: undefined,
    });
    await persistRecords(db, [first], "growth", "run-1");
    // The judge read the page: a16z leads, Exor participates, Fidelity is not named for this round.
    const judged = {
      ...first,
      lead_investors: ["a16z"],
      other_investors: ["Exor"],
      verification: { status: "confirmed" as const, notes: [], url: "https://news.example/lyte" },
    };
    await persistRecords(db, [judged], "growth", "run-2");
    const [row] = (await listRounds(db, { includeReview: true })).rows.filter((r) => r.company.name === "Lyte");
    expect(row.lead_investors).toEqual(["Andreessen Horowitz"]);
    expect(row.other_investors).toEqual(["Exor Ventures"]);
  });

  test("a lead the verifier demotes stays demoted: the row's old lead link does not come back as a lead", async () => {
    const db = await testDb();
    // Production's Easy Aerial row: its verdict said "not leads: Insight Partners, Entrée Capital" and the row still showed both leading.
    const first = record({ company_name: "Easy Aerial", lead_investors: ["Insight Partners", "Entrée Capital"], other_investors: [] });
    await persistRecords(db, [first], "series-a-b", "run-1");
    const demoted = {
      ...first,
      lead_investors: [],
      other_investors: ["Insight Partners", "Entrée Capital"],
      verification: { status: "corrected" as const, notes: ["not leads: Insight Partners, Entrée Capital"], url: null },
    };
    await persistRecords(db, [demoted], "series-a-b", "reconcile:2026-09-01");
    const [row] = (await listRounds(db, { includeReview: true })).rows.filter((r) => r.company.name === "Easy Aerial");
    expect(row.lead_investors).toEqual([]);
    expect(row.other_investors.sort()).toEqual(["Entrée Capital", "Insight Partners"]);
    // A later verdict that names a lead again is honoured the same way.
    await persistRecords(
      db,
      [{ ...demoted, lead_investors: ["Insight Partners"], other_investors: ["Entrée Capital"] }],
      "series-a-b",
      "run-3",
    );
    const [again] = (await listRounds(db, { includeReview: true })).rows.filter((r) => r.company.name === "Easy Aerial");
    expect(again.lead_investors).toEqual(["Insight Partners"]);
    expect(again.other_investors).toEqual(["Entrée Capital"]);
  });

  test("an unjudged reading adds no investors to a verified row, only its sources; an unverified row still accumulates", async () => {
    const db = await testDb();
    const verified = record({
      company_name: "Ultraviolette",
      headquarters: "India",
      lead_investors: ["Yali Capital", "TDK Ventures"],
      other_investors: ["Lip-Bu Tan"],
    });
    await persistRecords(db, [verified], "growth", "run-1");
    const unread = {
      ...verified,
      lead_investors: [],
      other_investors: ["Lingotto", "Qualcomm Ventures"],
      sources: [
        { url: "https://entrackr.com/news/ultraviolette-raises-85-mn", host: "entrackr.com", title: "Ultraviolette raises $85 Mn" },
      ],
      verification: { status: "skipped" as const, notes: ["model error: timeout"], url: null },
    };
    await persistRecords(db, [unread], "growth", "run-2");
    const [row] = (await listRounds(db, { includeReview: true })).rows.filter((r) => r.company.name === "Ultraviolette");
    expect(row.lead_investors.sort()).toEqual(["TDK Ventures", "Yali Capital"]);
    expect(row.other_investors).toEqual(["Lip-Bu Tan"]);
    expect(row.sources).toHaveLength(2);

    const open = record({ company_name: "Open Co", other_investors: ["Fund Two"], verification: undefined });
    await persistRecords(db, [open], "growth", "run-1");
    await persistRecords(db, [{ ...open, other_investors: ["Fund Three"] }], "growth", "run-2");
    const [openRow] = (await listRounds(db, { includeReview: true })).rows.filter((r) => r.company.name === "Open Co");
    expect(openRow.other_investors.sort()).toEqual(["Fund Three", "Fund Two"]);
  });

  test("a judged null amount is the page's word and lands; an unjudged null still keeps what the row knows", async () => {
    const db = await testDb();
    const socure = record({
      company_name: "Socure",
      amount: { value: 5200, currency: "USD", as_written: "$5.2 billion", usd_millions: 5200, fx_rate: 1, fx_date: "2026-09-02" },
      verification: undefined,
    });
    await persistRecords(db, [socure], "growth", "run-1");
    await checkedPublication(db, socure.id);
    // The judge read the release: the $5.2B is the valuation, no amount is stated.
    const judged = {
      ...socure,
      amount: { value: null, currency: null, as_written: null, usd_millions: null, fx_rate: null, fx_date: null },
      verification: { status: "corrected" as const, notes: ["amount $5.2 billion not stated by the page"], url: "u" },
    };
    await persistRecords(db, [judged], "growth", "run-2");
    let [row] = (await listRounds(db, { includeReview: true })).rows.filter((r) => r.company.name === "Socure");
    expect(row.amount.as_written).toBeNull();
    expect(row.disposition).toBe("flagged");
    // An unjudged reading with no amount (a filing) does not erase a judged amount elsewhere.
    const other = record({ company_name: "Keeper", verification: { status: "confirmed", notes: [], url: "u" } });
    await persistRecords(db, [other], "growth", "run-3");
    await checkedPublication(db, other.id);
    await persistRecords(
      db,
      [{ ...other, amount: { ...other.amount, value: null, as_written: null, usd_millions: null }, verification: undefined }],
      "growth",
      "run-4",
    );
    [row] = (await listRounds(db, { includeReview: true })).rows.filter((r) => r.company.name === "Keeper");
    expect(row.amount.as_written).toBe("$20M");
  });

  test("excludePreset reads the queue without one preset, so filings and news are separable", async () => {
    const db = await testDb();
    await persistRecords(db, [record({ company_name: "Filed Co", confidence: 0.9 })], "form-d", "run-1", { startIn: "review" });
    await persistRecords(db, [record({ company_name: "Newsy", confidence: 0.3 })], "seed", "run-2");
    const news = (await listRounds(db, { reviewOnly: true, excludePreset: "form-d" })).rows.map((r) => r.company.name);
    const filings = (await listRounds(db, { reviewOnly: true, preset: "form-d" })).rows.map((r) => r.company.name);
    expect(news).toEqual(["Newsy"]);
    expect(filings).toEqual(["Filed Co"]);
    const o = await overview(db);
    expect(o.review_count).toBe(2);
    expect(o.review_filings).toBe(1);
  });

  test("startIn review puts a well-scored record in the queue and keeps it there on re-runs", async () => {
    const db = await testDb();
    const filing = record({ company_name: "Filed Co", confidence: 0.9 });
    await persistRecords(db, [filing], "form-d", "run-1", { startIn: "review" });
    let [row] = (await listRounds(db, { reviewOnly: true })).rows;
    expect(row.company.name).toBe("Filed Co");
    expect(row.disposition).toBe("review");
    await persistRecords(db, [filing], "form-d", "run-2", { startIn: "review" });
    [row] = (await listRounds(db, { reviewOnly: true })).rows;
    expect(row.disposition).toBe("review");
    // A reviewer publishing it is the way out, as for any other row.
    await setDisposition(db, row.id, "publish");
    expect((await listRounds(db)).rows.map((r) => r.company.name)).toEqual(["Filed Co"]);
  });

  test("a reviewer's disposition survives re-runs; review rows take the recomputed one", async () => {
    const db = await testDb();
    const undated = record({ company_name: "Thin", announced_date: null, confidence: 0.3 });
    await persistRecords(db, [undated], "series-a-b", "run-1");
    let review = await listRounds(db, { reviewOnly: true });
    expect(review.rows.map((r) => r.company.name)).toEqual(["Thin"]);

    await setDisposition(db, undated.id, "publish");
    await persistRecords(db, [undated], "series-a-b", "run-2");
    const visible = await listRounds(db);
    expect(visible.rows.map((r) => r.company.name)).toEqual(["Thin"]);

    // Dated but weak stays in Review until the earliest-report search completes, even after its score improves.
    const stillThin = record({ company_name: "Other", company_key: "other", confidence: 0.3 });
    await persistRecords(db, [stillThin], "series-a-b", "run-3");
    expect((await listRounds(db, { reviewOnly: true })).rows.map((r) => r.company.name)).toEqual(["Other"]);
    const improved = { ...stillThin, confidence: 0.9 };
    await persistRecords(db, [improved], "series-a-b", "run-4");
    review = await listRounds(db, { reviewOnly: true });
    expect(review.rows.map((r) => r.company.name)).toEqual(["Other"]);
    await checkedPublication(db, stillThin.id);
    review = await listRounds(db, { reviewOnly: true });
    expect(review.rows).toHaveLength(0);
  });

  test("filters: stage, status, sector, free text, min amount, cursor", async () => {
    const db = await testDb();
    await persistRecords(
      db,
      [
        record({ company_name: "Alpha", stage: "series_a", sector: "fintech", announced_date: "2026-09-03" }),
        record({
          company_name: "Beta",
          stage: "series_b",
          sector: "energy",
          company_domain: "beta.io",
          company_website: "https://beta.io",
          lead_investors: ["Big Fund"],
          amount: { value: 60, currency: "USD", as_written: "$60M", usd_millions: 60, fx_rate: 1, fx_date: "2026-09-02" },
          announced_date: "2026-09-02",
        }),
        record({ company_name: "Gamma", stage: "series_a", sector: "energy", announced_date: "2026-09-01" }),
      ],
      "series-a-b",
      "run-1",
    );
    await checkedPublication(db, "alpha:series_a:2026-09-03", "beta:series_b:2026-09-02", "gamma:series_a:2026-09-01");
    expect((await listRounds(db, { stages: ["series_b"] })).rows.map((r) => r.company.name)).toEqual(["Beta"]);
    expect((await listRounds(db, { sector: "energy" })).rows.map((r) => r.company.name)).toEqual(["Beta", "Gamma"]);
    expect((await listRounds(db, { q: "big fund" })).rows.map((r) => r.company.name)).toEqual(["Beta"]);
    expect((await listRounds(db, { minUsdMillions: 50 })).rows.map((r) => r.company.name)).toEqual(["Beta"]);
    // One company by domain (any URL shape) or by name, exact and case-insensitive; a description hit is not a match.
    for (const company of ["beta.io", "https://www.beta.io/pricing", "BETA", "beta"]) {
      expect(
        (await listRounds(db, { company })).rows.map((r) => r.company.name),
        company,
      ).toEqual(["Beta"]);
    }
    expect((await listRounds(db, { company: "big fund" })).rows).toEqual([]);
    const page1 = await listRounds(db, { limit: 2 });
    expect(page1.rows.map((r) => r.company.name)).toEqual(["Alpha", "Beta"]);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await listRounds(db, { limit: 2, cursor: page1.nextCursor ?? undefined });
    expect(page2.rows.map((r) => r.company.name)).toEqual(["Gamma"]);
    expect(page2.nextCursor).toBeNull();

    await setStatus(db, [page1.rows[0].id], "seen");
    expect((await listRounds(db, { status: ["new"] })).rows.map((r) => r.company.name)).toEqual(["Beta", "Gamma"]);
    expect(await listSectors(db)).toEqual(["energy", "fintech"]);
  });

  test("a company first filed under other takes the sector a later reading names, and keeps it", async () => {
    const db = await testDb();
    const sectorOf = async () =>
      (await db.select({ sector: companies.sector }).from(companies).where(sql`${companies.name} = 'ChipMango'`))[0]?.sector;
    await persistRecords(
      db,
      [record({ company_name: "ChipMango", stage: "seed", announced_date: "2026-06-01", sector: "other" })],
      "seed",
      "run-1",
    );
    expect(await sectorOf()).toBe("other");
    await persistRecords(
      db,
      [record({ company_name: "ChipMango", stage: "series_a", announced_date: "2026-09-01", sector: "semiconductors" })],
      "series-a-b",
      "run-2",
    );
    expect(await sectorOf()).toBe("semiconductors");
    await persistRecords(
      db,
      [record({ company_name: "ChipMango", stage: "series_b", announced_date: "2026-09-20", sector: "hardware" })],
      "series-a-b",
      "run-3",
    );
    expect(await sectorOf()).toBe("semiconductors");
  });

  test("the cursor walks dated rows into the undated tail, every row exactly once", async () => {
    const db = await testDb();
    await persistRecords(
      db,
      [
        record({ company_name: "D1", announced_date: "2026-09-03" }),
        record({ company_name: "D2", announced_date: "2026-09-02" }),
        record({ company_name: "D3", announced_date: "2026-09-01" }),
        record({ company_name: "U1", announced_date: null, confidence: 0.3, sources: [] }),
        record({ company_name: "U2", announced_date: null, confidence: 0.3, sources: [] }),
        record({ company_name: "U3", announced_date: null, confidence: 0.3, sources: [] }),
      ],
      "series-a-b",
      "run-1",
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      // Undated records land in review, so the walk reads them back too.
      const page = await listRounds(db, { limit: 2, includeReview: true, cursor });
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    // Table order: dated newest first, then the undated tail by id desc.
    expect(seen.map((id) => id.split(":")[0])).toEqual(["d1", "d2", "d3", "u3", "u2", "u1"]);
  });

  test("rows carry the preset that wrote them, and the preset filter and overview narrow to it", async () => {
    const db = await testDb();
    await persistRecords(
      db,
      [
        record({ company_name: "Alpha", stage: "series_a", sector: "fintech", announced_date: isoDaysAgo(2), lead_investors: ["Fund A"] }),
        record({ company_name: "Beta", stage: "series_b", sector: "energy", announced_date: isoDaysAgo(3), lead_investors: ["Fund A"] }),
      ],
      "series-a-b",
      "run-ab",
    );
    await checkedPublication(db, `alpha:series_a:${isoDaysAgo(2)}`, `beta:series_b:${isoDaysAgo(3)}`);
    await persistRecords(
      db,
      [
        record({
          company_name: "Sprout",
          stage: "seed",
          stage_as_written: "Seed",
          sector: "climate",
          announced_date: isoDaysAgo(1),
          lead_investors: ["Angel Fund"],
          amount: { value: 3, currency: "USD", as_written: "$3M", usd_millions: 3, fx_rate: 1, fx_date: isoDaysAgo(1) },
          sources: [{ url: "https://prnewswire.com/sprout", host: "prnewswire.com", title: "Sprout raises $3M seed" }],
        }),
        record({ company_name: "Thin Seed", stage: "seed", announced_date: null, confidence: 0.3, sources: [] }),
      ],
      "seed",
      "run-seed",
    );
    await checkedPublication(db, `sprout:seed:${isoDaysAgo(1)}`);
    await persistRecords(db, [record({ company_name: "Big", stage: "series_c", announced_date: isoDaysAgo(4) })], "growth", "run-growth");
    await checkedPublication(db, `big:series_c:${isoDaysAgo(4)}`);

    const all = await listRounds(db);
    expect(all.rows.map((r) => [r.company.name, r.preset_slug])).toEqual([
      ["Sprout", "seed"],
      ["Alpha", "series-a-b"],
      ["Beta", "series-a-b"],
      ["Big", "growth"],
    ]);
    expect((await listRounds(db, { preset: "seed" })).rows.map((r) => r.company.name)).toEqual(["Sprout"]);

    const seed = await overview(db, 30, "seed");
    expect(seed.preset).toBe("seed");
    expect(seed.rounds).toBe(1);
    expect(seed.new_rounds).toBe(1);
    expect(seed.total_usd_millions).toBe(3);
    expect(seed.review_count).toBe(1);
    expect(seed.by_stage).toEqual([{ stage: "seed", count: 1, usd_millions: 3 }]);
    expect(seed.by_week.reduce((n, w) => n + w.count, 0)).toBe(1);
    expect(seed.top_sectors).toEqual([{ sector: "climate", count: 1 }]);
    expect(seed.top_investors.map((i) => i.name)).toEqual(["Angel Fund"]);
    expect(seed.top_sources).toEqual([{ host: "prnewswire.com", count: 1 }]);

    // No preset: everything, with the stage ladder in STAGES order rather than by count.
    const every = await overview(db, 30);
    expect(every.preset).toBeNull();
    expect(every.rounds).toBe(4);
    expect(every.by_stage.map((s) => s.stage)).toEqual(["seed", "series_a", "series_b", "series_c"]);
    expect(every.top_sources.map((s) => s.host).sort()).toEqual(["prnewswire.com", "reuters.com"]);
  });
});

test("the preset that found a round owns the row: a Form D reading of a news round attaches without taking it over", async () => {
  const db = await testDb();
  const news = record({
    company_name: "Venice.ai",
    company_domain: "venice.ai",
    stage_as_written: "Series A",
    stage: "series_a",
    announced_date: "2026-09-02",
    confidence: 0.9,
  });
  await persistRecords(db, [news], "series-a-b", "run-1");
  await checkedPublication(db, news.id);
  const filing = {
    ...news,
    id: news.id,
    stage: "other" as const,
    stage_as_written: "Form D (equity)",
    sources: [{ url: "https://www.sec.gov/Archives/edgar/data/1/000/x-index.htm", host: "www.sec.gov", title: "Form D: Venice.ai" }],
  };
  await persistRecords(db, [filing], "form-d", "run-2", { startIn: "review" });
  const [row] = (await listRounds(db, { includeReview: true })).rows.filter((r) => r.company.name === "Venice.ai");
  expect(row.preset_slug).toBe("series-a-b");
  expect(row.disposition).toBe("publish");
  expect(row.sources.map((s) => s.host).sort()).toEqual(["reuters.com", "www.sec.gov"]);
});

test("countRounds counts the same filters listRounds lists, ignoring paging", async () => {
  const db = await testDb();
  await persistRecords(
    db,
    [
      record({ company_name: "Alpha Co", stage: "series_a" }),
      record({ company_name: "Beta Co", stage: "series_b" }),
      record({ company_name: "Gamma Co", stage: "series_b" }),
    ],
    "series-a-b",
    "run-1",
  );
  await checkedPublication(db, "alpha-co:series_a:2026-09-02", "beta-co:series_b:2026-09-02", "gamma-co:series_b:2026-09-02");
  expect(await countRounds(db)).toBe(3);
  expect(await countRounds(db, { stages: ["series_b"] })).toBe(2);
  expect((await listRounds(db, { stages: ["series_b"] })).rows).toHaveLength(2);
  expect(await countRounds(db, { q: "alpha" })).toBe(1);
  // A cursor and a limit narrow the page, never the count.
  expect(await countRounds(db, { stages: ["series_b"], cursor: "2026-09-02|zzz", limit: 1 })).toBe(2);
});

test("toFeedRow keeps what the feed renders and drops what it does not for a Review row", async () => {
  const db = await testDb();
  await persistRecords(
    db,
    [
      record({
        company_name: "RowCo",
        evidence_quotes: ["RowCo raised $20M.", "Fund One led the round.", "A third quote the detail never reads."],
        sources: [
          { url: "https://a.example/rowco", host: "a.example", title: "RowCo raises", published: "2026-09-02", query: "rowco raises" },
          { url: "https://b.example/rowco", host: "b.example", title: "RowCo $20M" },
        ],
      }),
    ],
    "series-a-b",
    "run-1",
  );
  const [row] = (await listRounds(db, { includeReview: true })).rows;
  const feed = toFeedRow(row);
  expect(feed.id).toBe(row.id);
  expect(feed.company.name).toBe("RowCo");
  expect(feed.amount.usd_millions).toBe(20);
  expect(feed.stage).toBe("series_a");
  expect(feed.lead_investors).toEqual(["Fund One"]);
  expect(feed.other_investors).toEqual([]);
  expect(feed.announced_on).toBe("2026-09-02");
  expect(feed.confidence).toBe(0.8);
  expect(feed.verification?.status).toBe("confirmed");
  expect(feed.sources).toEqual([
    // The search text stays behind; the lane it names does not.
    { url: "https://a.example/rowco", title: "RowCo raises", host: "a.example", query: "search" },
    { url: "https://b.example/rowco", title: "RowCo $20M", host: "b.example", query: null },
  ]);
  expect(feed.evidence_quotes).toEqual(["RowCo raised $20M."]);
  expect(feed.first_seen_at).toBe(row.first_seen_at);
  expect(feed.preset_slug).toBe("series-a-b");
  expect(feed.status).toBe("new");
  expect(feed.disposition).toBe("review");
  expect(JSON.stringify(feed).length).toBeLessThan(JSON.stringify(row).length);

  // The two labels the stored profile still carries never reach a read surface.
  await db.execute(
    sql`insert into enrichments (company_id, kind, data) values ('rowco', 'profile', ${JSON.stringify({
      website_source: "record",
      company_website: "https://rowco.com",
      profile: { what_they_sell: "Robots", customer_type: "SMB", sells_software_subscription: true, same_company: true },
    })}::jsonb)`,
  );
  const [enriched] = (await listRounds(db, { includeReview: true })).rows;
  const enrichedFeed = toFeedRow(enriched);
  expect(enriched.enrichment?.what_they_sell).toBe("Robots");
  expect(enriched.enrichment).not.toHaveProperty("customer_type");
  expect(enrichedFeed.enrichment).not.toHaveProperty("customer_type");
  expect(enrichedFeed.enrichment).not.toHaveProperty("sells_software_subscription");
});

describe("valuations and source dates on the live feed", () => {
  const FORBES = "https://www.forbes.com/sites/corgi-worth-5-billion/";
  const corgi = (p: Partial<FeedRecord> = {}) =>
    record({
      company_name: "Corgi",
      company_key: "corgi",
      stage: "series_b",
      stage_as_written: "Series B extension",
      is_extension: true,
      announced_date: "2026-09-25",
      amount: { value: 64, currency: "USD", as_written: "$64 million", usd_millions: 64, fx_rate: 1, fx_date: null },
      evidence_quotes: [
        "Corgi has raised $64 million in a Series B extension.",
        "The startup announced it was a unicorn in May with a $160 million Series B at a $1.3 billion valuation.",
      ],
      sources: [{ url: FORBES, host: "forbes.com", title: "Corgi Is Now Worth $5 Billion Thanks To Four Funding Rounds In Five Months" }],
      verification: { status: "confirmed", notes: [], url: FORBES },
      confidence: 0.9,
      ...p,
    });

  test("a valuation borrowed from another round's sentence is dropped, clears the stored one, and flags the row", async () => {
    const handle = await testDb();
    await persistRecords(
      handle,
      [corgi({ valuation_as_written: "$5 billion", evidence_quotes: ["Corgi raised $64 million at a $5 billion valuation."] })],
      "series-a-b",
      "run-1",
    );
    await checkedPublication(handle, corgi().id);
    await handle.execute(sql`update funding_rounds set valuation_as_written = '$1.3 billion'`);
    await persistRecords(handle, [corgi({ valuation_as_written: "$1.3 billion" })], "series-a-b", "run-2");
    const [row] = await handle.select().from(schema.fundingRounds);
    expect(row).toMatchObject({ valuationAsWritten: null, disposition: "flagged" });
    expect((row.verification as { notes: string[] }).notes).toContain(
      "valuation $1.3 billion dropped: it is stated for another round ($160 million)",
    );
    expect(
      dispositionFor({
        undated: false,
        confidence: 0.9,
        valuation_ruled_out: "x",
        verification: { status: "confirmed", notes: [], url: null },
      }),
    ).toBe("flagged");
  });

  test("a source stored without a date takes the day a later reading gives it, and never loses one it has", async () => {
    const handle = await testDb();
    await persistRecords(handle, [corgi()], "series-a-b", "run-1");
    await persistRecords(
      handle,
      [corgi({ sources: [{ url: FORBES, host: "forbes.com", title: "Corgi", published: "2026-09-26" }] })],
      "series-a-b",
      "run-2",
    );
    await persistRecords(
      handle,
      [corgi({ sources: [{ url: FORBES, host: "forbes.com", title: "Corgi", published: "2026-01-01" }] })],
      "series-a-b",
      "run-3",
    );
    const [source] = await handle.select().from(schema.sources);
    expect(source.publishedAt).toBe("2026-09-26");
  });
});

describe("money provenance, merges, and the visibility gate", () => {
  const REUTERS =
    "https://www.reuters.com/legal/transactional/data-security-firm-cyera-raises-600-million-12-billion-valuation-2026-06-10/";
  const cyera = (p: Partial<FeedRecord> = {}) =>
    record({
      company_name: "Cyera",
      company_key: "cyera",
      stage: "growth",
      stage_as_written: "funding round",
      announced_date: "2026-06-10",
      amount: { value: 600, currency: "USD", as_written: "$600 million", usd_millions: 600, fx_rate: 1, fx_date: null },
      sources: [{ url: REUTERS, host: "reuters.com", title: "Data security firm Cyera raises $600 million at $12 billion valuation" }],
      evidence_quotes: ["Data security firm Cyera said on Wednesday it has raised $600 million at a $12 billion valuation."],
      verification: { status: "confirmed", notes: [], url: REUTERS },
      confidence: 0.9,
      ...p,
    });
  const claim = {
    value: "$12 billion",
    quote: "Cyera said it has raised $600 million at a $12 billion valuation.",
    url: REUTERS,
    tier: 0.9,
  };

  test("Cyera: a checked claim replaces a longer stored valuation; a later reading without one keeps it; a pin wins", async () => {
    const handle = await testDb();
    await persistRecords(handle, [cyera()], "late", "run-1");
    await handle.execute(sql`update funding_rounds set valuation_as_written = '$2.7 billion'`);
    await persistRecords(handle, [cyera({ valuation_as_written: "$12 billion", valuation_claims: [claim] })], "late", "run-2");
    let [row] = await handle.select().from(schema.fundingRounds);
    expect(row).toMatchObject({ valuationAsWritten: "$12 billion", valuationClaims: [claim] });
    await persistRecords(handle, [cyera()], "late", "run-3");
    [row] = await handle.select().from(schema.fundingRounds);
    expect(row.valuationAsWritten).toBe("$12 billion");
    await handle.execute(sql`update funding_rounds set pinned = '{"valuation": null}'::jsonb`);
    await persistRecords(handle, [cyera({ valuation_as_written: "$12 billion", valuation_claims: [claim] })], "late", "run-4");
    [row] = await handle.select().from(schema.fundingRounds);
    expect(row.valuationAsWritten).toBeNull();
  });

  test("a read-back that finds no valuation for this round retracts the stored one", async () => {
    const handle = await testDb();
    await persistRecords(handle, [cyera({ valuation_as_written: "$12 billion", valuation_claims: [claim] })], "late", "run-1");
    await checkedPublication(handle, cyera().id);
    await persistRecords(
      handle,
      [cyera({ valuation_as_written: null, valuation_ruled_out: "no source states it for this round" })],
      "late",
      "run-2",
    );
    const [row] = await handle.select().from(schema.fundingRounds);
    expect(row).toMatchObject({ valuationAsWritten: null, valuationClaims: null, disposition: "flagged" });
  });

  test("Factory: a round a Reddit post alone reports goes to Review, and joins the feed once a publication states it", async () => {
    const handle = await testDb();
    const REDDIT = "https://www.reddit.com/r/singularity/comments/1abc/factory_raises_200m_at_5b/";
    const factory = (sources: FeedRecord["sources"]) =>
      record({
        company_name: "Factory",
        company_key: "factory",
        company_domain: "factory.com",
        stage: "growth",
        stage_as_written: "funding round",
        announced_date: "2026-09-15",
        amount: { value: 200, currency: "USD", as_written: "$200M", usd_millions: 200, fx_rate: 1, fx_date: null },
        sources,
        verification: { status: "confirmed", notes: [], url: sources[0].url },
        confidence: 0.9,
      });
    await persistRecords(handle, [factory([{ url: REDDIT, host: "reddit.com", title: "Factory raises $200M at $5B" }])], "late", "run-1");
    let [row] = await handle.select().from(schema.fundingRounds);
    expect(row.disposition).toBe("review");
    expect((row.verification as { notes: string[] }).notes).toContain(
      "held for review: only funding databases, profile pages, or forums state it",
    );
    await persistRecords(
      handle,
      [
        {
          ...factory([
            { url: "https://factory.com/news/5-billion-valuation", host: "factory.com", title: "Factory raises $200M at a $5B valuation" },
          ]),
          verification: { status: "confirmed", notes: [], url: "https://factory.com/news/5-billion-valuation", sources_seen: 2 },
        },
      ],
      "late",
      "run-2",
    );
    expect((await handle.select().from(schema.fundingRounds))[0].disposition).toBe("review");
    await checkedPublication(handle, "factory:growth:2026-09-15");
    [row] = await handle.select().from(schema.fundingRounds);
    expect(row.disposition).not.toBe("review");
  });

  test("Corgi's Series B1 three weeks after its Series B is its own round; an unlinked second Series B within 60 days goes to Review", async () => {
    const handle = await testDb();
    const corgi = (p: Partial<FeedRecord>) =>
      record({
        company_name: "Corgi",
        company_key: "corgi",
        headquarters: "New York",
        stage: "series_b",
        confidence: 0.9,
        verification: { status: "confirmed", notes: [], url: null },
        ...p,
      });
    await persistRecords(
      handle,
      [
        corgi({
          stage_as_written: "Series B",
          announced_date: "2026-05-07",
          amount: { value: 160, currency: "USD", as_written: "$160 million", usd_millions: 160, fx_rate: 1, fx_date: null },
          sources: [
            { url: "https://techcrunch.com/2026/05/07/corgi-series-b/", host: "techcrunch.com", title: "Corgi raises $160M Series B" },
          ],
        }),
      ],
      "series-a-b",
      "run-1",
    );
    await checkedPublication(handle, "corgi:series_b:2026-05-07");
    await persistRecords(
      handle,
      [
        corgi({
          stage_as_written: "Series B1",
          announced_date: "2026-05-28",
          amount: { value: 106, currency: "USD", as_written: "$106 million", usd_millions: 106, fx_rate: 1, fx_date: null },
          sources: [{ url: "https://techcrunch.com/2026/05/28/corgi-b1/", host: "techcrunch.com", title: "Corgi raises $106M Series B1" }],
        }),
      ],
      "series-a-b",
      "run-2",
    );
    await checkedPublication(handle, "corgi:series_b:2026-05-28");
    let rows = await handle.select().from(schema.fundingRounds).orderBy(schema.fundingRounds.announcedOn);
    expect(rows.map((r) => [r.stageAsWritten, r.disposition])).toEqual([
      ["Series B", "publish"],
      ["Series B1", "publish"],
    ]);
    await persistRecords(
      handle,
      [
        corgi({
          stage_as_written: "Series B",
          announced_date: "2026-07-01",
          amount: { value: 40, currency: "USD", as_written: "$40 million", usd_millions: 40, fx_rate: 1, fx_date: null },
          sources: [
            { url: "https://example-news.com/2026/07/01/corgi-series-b/", host: "example-news.com", title: "Corgi raises $40M Series B" },
          ],
        }),
      ],
      "series-a-b",
      "run-3",
    );
    rows = await handle.select().from(schema.fundingRounds).orderBy(schema.fundingRounds.announcedOn);
    const last = rows[rows.length - 1];
    expect(last.disposition).toBe("review");
    expect((last.verification as { notes: string[] }).notes[0]).toMatch(/^held for review: another Series B/);
  });
});

import { readFile } from "node:fs/promises";

describe("a stale namesake hold", () => {
  const HOLD = "held for review: same-name company identity is unverified";
  const acme = (sources: FeedRecord["sources"]) =>
    record({ company_name: "Acme", company_domain: "acme.com", announced_date: "2026-09-02", sources });
  const held = async (db: Db, id: string) => {
    await db
      .update(schema.fundingRounds)
      .set({ disposition: "review", freshnessCheckedOn: "2026-09-02", verification: { status: "confirmed", notes: [HOLD], url: null } })
      .where(eq(schema.fundingRounds.id, id));
  };
  const reuters = { url: "https://reuters.com/acme", host: "reuters.com", title: "Acme raises $20M" };

  test("lifts once the company's own site states the round", async () => {
    const db = await testDb();
    const r = acme([reuters]);
    await persistRecords(db, [r], "series-a-b", "feed");
    await held(db, r.id);
    await persistRecords(
      db,
      [acme([reuters, { url: "https://acme.com/blog/series-a", host: "acme.com", title: "Acme raises $20M" }])],
      "series-a-b",
      "feed",
    );
    const [row] = await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, r.id));
    expect(row.disposition).toBe("publish");
    expect((row.verification as { notes: string[] }).notes).not.toContain(HOLD);
  });

  test("stays without a page on the company's own site", async () => {
    const db = await testDb();
    const r = acme([reuters]);
    await persistRecords(db, [r], "series-a-b", "feed");
    await held(db, r.id);
    await persistRecords(
      db,
      [acme([reuters, { url: "https://techcrunch.com/acme", host: "techcrunch.com", title: "Acme raises $20M" }])],
      "series-a-b",
      "feed",
    );
    const [row] = await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, r.id));
    expect(row.disposition).toBe("review");
  });
});

describe("folding one company into another", () => {
  test("carries its newsrooms and visitor requests, so the fold is not refused", async () => {
    const db = await testDb();
    await db.insert(schema.companies).values([
      { id: "acme-old", name: "Acme", nameKey: "acme" },
      { id: "acme.com", name: "Acme", nameKey: "acme", domain: "acme.com" },
    ]);
    await db.insert(schema.companyNewsrooms).values({ companyId: "acme-old", url: "https://acme.com/blog", discoveredAt: new Date() });
    await db.insert(schema.companyNewsroomScans).values({ companyId: "acme-old", discoveredAt: new Date() });
    await mergeCompanies(db, "acme-old", "acme.com");
    expect(await db.select().from(schema.companies)).toHaveLength(1);
    expect((await db.select().from(schema.companyNewsrooms)).map((n) => n.companyId)).toEqual(["acme.com"]);
    expect((await db.select().from(schema.companyNewsroomScans)).map((n) => n.companyId)).toEqual(["acme.com"]);
  });
});
