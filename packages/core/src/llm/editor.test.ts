// The editor's grounding and decisions against scripted verdicts: no network, no key needed.

import { describe, expect, test } from "vitest";
import { type EditorInput, type EditorVerdict, finalizeEdit, grounded } from "./editor.ts";

const release = "https://www.businesswire.com/news/acme";
const outlet = "https://techcrunch.com/acme";
const input: EditorInput = {
  company: "Acme Robotics",
  firstSeen: "2026-10-02T09:00:00Z",
  pages: [
    {
      url: release,
      host: "businesswire.com",
      published: "2026-10-01",
      markdown:
        "SAN FRANCISCO -- **Acme Robotics** today announced it has raised $40 million in Series B funding led by [Northwind Capital](https://northwind.vc), with participation from Contoso Ventures. The round brings total funding to $65 million.",
    },
    {
      url: outlet,
      host: "techcrunch.com",
      markdown: "Acme Robotics, which makes warehouse robots, is in talks to raise more, sources say.",
    },
  ],
  sites: [
    { url: "https://acmerobotics.com", title: "Acme Robotics | Warehouse robots", description: null, text: null },
    { url: "https://acme.com", title: "Acme Corporation", description: "Anvils", text: null },
  ],
};
const sentence =
  "Acme Robotics today announced it has raised $40 million in Series B funding led by Northwind Capital, with participation from Contoso Ventures.";

const verdict = (over: Partial<EditorVerdict> = {}): EditorVerdict => ({
  kind: "private_company_round",
  kind_quote: sentence,
  kind_source: release,
  announcement: "new_announcement",
  source_quality: "company_or_wire",
  company: {
    name: "Acme Robotics",
    website: "https://acmerobotics.com",
    description: "Warehouse robots.",
    quote: sentence,
    source: release,
  },
  stage: { label: "Series B", quote: sentence, source: release },
  amount: { as_written: "$40 million", quote: sentence, source: release },
  announced_on: { date: "2026-10-01", quote: null, source: null },
  certainty: { value: "announced", quote: sentence, source: release },
  is_extension: false,
  leads: { names: ["Northwind Capital"], quote: sentence, source: release },
  participants: ["Contoso Ventures"],
  summary: "Acme Robotics raised a $40M Series B.",
  ...over,
});

describe("grounded", () => {
  test("a quote is found through markdown links, emphasis, and spacing", () => {
    expect(grounded(input.pages, sentence, release)).toBe(true);
  });
  test("bold links and spaced punctuation in the markdown do not break a match", () => {
    const pages = [
      { url: release, host: "x", markdown: '[**Ekai**](https://t.co/x "") **,** a platform for AI, today announced a $1.7 million round.' },
    ];
    expect(grounded(pages, "Ekai, a platform for AI, today announced a $1.7 million round.", release)).toBe(true);
  });
  test("a quote on another page, an invented sentence, or a fragment does not count", () => {
    expect(grounded(input.pages, sentence, outlet)).toBe(false);
    expect(grounded(input.pages, "Acme Robotics raised $40 million from Northwind.", release)).toBe(false);
    expect(grounded(input.pages, "$40 million", release)).toBe(false);
  });
});

describe("finalizeEdit", () => {
  test("a supported round is published with its evidence, the candidate website, and USD", () => {
    const out = finalizeEdit(input, verdict(), null);
    expect(out.action).toBe("publish");
    if (out.action !== "publish") return;
    expect(out.round).toMatchObject({
      company: { name: "Acme Robotics", website: "https://acmerobotics.com", domain: "acmerobotics.com" },
      stage: "series_b",
      amount_as_written: "$40 million",
      amount_usd_millions: 40,
      announced_on: "2026-10-01",
      certainty: "announced",
      lead_investors: ["Northwind Capital"],
      other_investors: ["Contoso Ventures"],
    });
    expect(out.round.evidence.map((e) => e.field)).toEqual(expect.arrayContaining(["company", "amount", "certainty", "stage", "leads"]));
  });

  test("money that is not a private company's round is not shown", () => {
    expect(finalizeEdit(input, verdict({ kind: "debt_or_project_finance" }), null)).toMatchObject({ action: "drop" });
  });

  test("a round only mentioned in passing, or reported only by unverifiable pages, is not shown", () => {
    expect(finalizeEdit(input, verdict({ announcement: "roundup_or_data_report" }), null)).toMatchObject({ action: "drop" });
    expect(finalizeEdit(input, verdict({ announcement: "mention_of_earlier_round" }), null)).toMatchObject({ action: "drop" });
    expect(finalizeEdit(input, verdict({ source_quality: "unverifiable" }), null)).toMatchObject({ action: "drop" });
  });

  test("a round no page sentence states is not shown", () => {
    const company = { ...verdict().company, quote: "Acme Robotics raised a big round this week from great investors." };
    expect(finalizeEdit(input, verdict({ company }), null)).toMatchObject({ action: "drop", reason: "no page sentence states the round" });
  });

  test("a round announced more than two weeks before it was seen is old news, unless it is history", () => {
    const old = verdict({ announced_on: { date: "2026-09-01", quote: null, source: null } });
    const withDay = { ...input, pages: [{ ...input.pages[0], published: "2026-09-01" }, input.pages[1]] };
    expect(finalizeEdit(withDay, old, null)).toMatchObject({ action: "drop" });
    expect(finalizeEdit(withDay, old, null, { history: true })).toMatchObject({ action: "publish" });
  });

  test("an amount, a lead, or a website the evidence does not bear out is left off", () => {
    const out = finalizeEdit(
      input,
      verdict({
        amount: { as_written: "$65 million", quote: sentence, source: release },
        leads: { names: ["Northwind Capital", "Contoso Ventures", "Initech"], quote: sentence, source: release },
        company: { ...verdict().company, website: "https://acme-robotics.io" },
      }),
      null,
    );
    expect(out.action).toBe("publish");
    if (out.action !== "publish") return;
    expect(out.round.amount_as_written).toBeNull();
    expect(out.round.lead_investors).toEqual(["Northwind Capital", "Contoso Ventures"]);
    expect(out.round.company.website).toBeNull();
    expect(out.notes.join(" ")).toMatch(/Initech/);
  });

  test("a certainty no sentence states is not shown", () => {
    expect(finalizeEdit(input, verdict({ certainty: { value: "announced", quote: null, source: null } }), null)).toMatchObject({
      action: "drop",
    });
  });
});
