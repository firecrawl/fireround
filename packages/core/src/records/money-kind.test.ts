import { describe, expect, test } from "vitest";
import { pageItems } from "../firecrawl/extract.ts";
import { cleanInvestors } from "./investors.ts";
import { moneyKindFromSentence, safeMoneyKind } from "./money-kind.ts";
import { dollarFromEvidence, hostOf, parseAmount } from "./normalize.ts";
import { amountInEvidence, resolveRounds } from "./resolve.ts";
import type { ExtractedRound } from "./schema.ts";

describe("audited money sentences", () => {
  test.each([
    ["Ando", "Ando has raised $20 million across its pre-seed and seed rounds.", "$20 million", "combined"],
    [
      "Parallax total",
      "Parallax has raised $117 million in funding to date, including a $75 million Series A.",
      "$117 million",
      "cumulative",
    ],
    ["Parallax A", "Parallax has raised $117 million in funding to date, including a $75 million Series A.", "$75 million", "primary"],
    [
      "Northland project financing",
      "Northland announced the close of approximately PLN 500 million (CAD 185 million) in project financing for its battery energy storage projects in Poland.",
      "PLN 500 million",
      "debt",
    ],
    [
      "SolSource warehouse financing",
      "SolSource Solutions today announced the closing of $300 million of new tax credit and warehouse financing commitments.",
      "$300 million",
      "debt",
    ],
    [
      "Nscale commitment",
      "Nscale closed $2.36 billion initially and NVIDIA committed a further $1 billion expected in November.",
      "$1 billion",
      "future_commitment",
    ],
    [
      "Nscale closing",
      "Nscale closed $2.36 billion initially and NVIDIA committed a further $1 billion expected in November.",
      "$2.36 billion",
      "primary",
    ],
    ["Nscale pre-IPO", "Nscale raised $2.36 billion through pre-IPO convertible loan notes.", "$2.36 billion", "primary"],
    [
      "L-Nutra total",
      "L-Nutra announced a $36.5 million Series D investment, bringing total proceeds to $83.5 million.",
      "$83.5 million",
      "cumulative",
    ],
    [
      "L-Nutra tranche",
      "L-Nutra announced a $36.5 million Series D investment, bringing total proceeds to $83.5 million.",
      "$36.5 million",
      "primary",
    ],
    ["Noxtua", "Noxtua raised over €100 million including secondary share purchases and fresh equity.", "€100 million", "mixed"],
    ["Mazama", "Mazama Energy secured $135 million in Series B funding including grants.", "$135 million", "mixed"],
    ["Bird&Be", "Bird&Be raised $13 million in a Series A including a secondary portion.", "$13 million", "mixed"],
    ["Runwal", "Runwal Enterprises raised ₹149 crore from anchor investors ahead of its IPO.", "₹149 crore", "ipo_allocation"],
    [
      "Eapro private round",
      "Eapro Global Ltd has raised Rs 40 crore in a funding round as the company prepares for a proposed initial public offering in FY28.",
      "Rs 40 crore",
      "primary",
    ],
    [
      "Reapit",
      "Reapit will invest an additional £20 million in its own products over the next 18 months.",
      "£20 million",
      "internal_spending",
    ],
    [
      "Kastle lending platform",
      "Kastle, the AI workforce platform transforming consumer lending, today announced it has raised $24 million in Series A funding.",
      "$24 million",
      "primary",
    ],
    ["Micro1 run rate", "Micro1 is on track to reach $500 million in gross run rate.", "$500 million", "unknown"],
    ["Apate cumulative", "Apate.AI has now raised US$11.4 million in total.", "US$11.4 million", "cumulative"],
    [
      "Euno round beside its total",
      "Euno today announced $23 million in Series A funding led by N47. The round brings Euno's total funding to $29 million.",
      "$23 million",
      "primary",
    ],
    [
      "HiddenLayer round",
      "The startup has now raised $100 million in a Series B funding round led by Delta-v Capital.",
      "$100 million",
      "primary",
    ],
    [
      "Ema all primary",
      "Ema raised $77 million. The round consisted entirely of primary equity, with no debt or secondary transactions.",
      "$77 million",
      "primary",
    ],
    [
      "Darwinbox",
      "Teachers' Venture Growth bought $40 million of existing shares in Darwinbox from early investors.",
      "$40 million",
      "secondary",
    ],
    [
      "Félix equity",
      "A16z led an $87 million equity investment, with participation from QED. And General Catalyst committed $113 million in debt.",
      "$87 million",
      "primary",
    ],
    ["Reecall investor", "Reecall raised €3.5M in a round led by Founders Future, joined by Holnest.", "€3.5M", "primary"],
    [
      "Langxi tranche",
      "Langxi Technology raised nearly RMB200 million in a Pre-A+ round, taking cumulative financing to nearly RMB300 million.",
      "RMB200 million",
      "primary",
    ],
    [
      "Zeroth yuan tranche",
      "Zeroth completed nearly 500 million yuan in Pre-A financing, bringing total funding to 1 billion yuan.",
      "nearly 500 million yuan",
      "unknown",
    ],
  ] as const)("%s: %s", (_name, sentence, amount, expected) => {
    expect(moneyKindFromSentence(sentence, amount)).toBe(expected);
  });

  test("the independent check can veto a plausible primary reading, never undo a rule's non-round verdict", () => {
    expect(safeMoneyKind("Acme raised $20 million in a Series A.", "$20 million", "secondary")).toBe("secondary");
    expect(safeMoneyKind("Acme sold $20 million of existing shares.", "$20 million", "primary")).toBe("secondary");
  });

  test.each([
    ["A$6.75 million", "AUD"],
    ["AUD$2 million", "AUD"],
    ["C$7.5m", "CAD"],
    ["S$2m", "SGD"],
    ["NZ$2m", "NZD"],
    ["HK$3m", "HKD"],
  ])("explicit non-US dollars: %s", (figure, currency) => {
    expect(parseAmount(figure).currency).toBe(currency);
  });

  test("company geography never changes a bare dollar without an explicit marker on that figure", () => {
    for (const quote of [
      "Dtcpay, a Singapore-based stablecoin payment technology provider, has closed its Series A funding round at $25 million",
      "iPiD raised $16 million in a Series A led by Foundation Capital.",
      "Heidi Health secured a $340 million round led by General Catalyst in Australia.",
      "Amber Electric raised €49 million ($77 million) from investors in Melbourne.",
    ])
      expect(dollarFromEvidence("$25 million", parseAmount("$25 million"), quote).currency).toBe("USD");
    expect(dollarFromEvidence("$77 million", parseAmount("$77 million"), "Amber Electric raised €49 million ($77 million)").currency).toBe(
      "USD",
    );
    expect(dollarFromEvidence("$6.75 million", parseAmount("$6.75 million"), "Kinoxis raised A$6.75 million in equity.").currency).toBe(
      "AUD",
    );
    expect(
      dollarFromEvidence("$6.75 million", parseAmount("$6.75 million"), "Kinoxis raised 6.75 million Australian dollars in equity.")
        .currency,
    ).toBe("AUD");
    expect(dollarFromEvidence("$16 million", parseAmount("$16 million"), "iPiD raised S$16 million in Singapore.").currency).toBe("SGD");
  });
});

describe("resolution holds unsafe amounts", () => {
  function resolve(sentence: string, figure: string, stage: string, url: string) {
    const round: ExtractedRound = {
      company_name: "Example",
      company_website: null,
      company_description: null,
      round_type_as_written: stage,
      amount_as_written: figure,
      amount_kind: "round",
      valuation_as_written: null,
      lead_investors: [],
      other_investors: [],
      announced_date: "2026-09-25",
      headquarters: null,
      sector: null,
      evidence_quote: sentence,
      source_url: null,
      is_background: false,
      is_rumor: false,
    };
    return resolveRounds(
      [{ round, source: { url, host: hostOf(url), title: "Example financing" }, grounded: true, page_kind: "article" }],
      {
        stages: ["pre_seed", "seed", "series_a", "series_b", "series_c", "series_d_plus", "growth"],
        windowStart: new Date("2026-09-01"),
        now: new Date("2026-09-27"),
      },
    );
  }

  test("a round labelled debt is a debt round; debt under an equity label is no round", () => {
    const facility = "Vaulted Deep today announced a $35 million debt facility from Mediobanca to expand its national buildout.";
    const debt = resolveRounds(
      [
        {
          round: {
            company_name: "Vaulted Deep",
            company_website: null,
            company_description: null,
            round_type_as_written: "debt",
            amount_as_written: "$35 million",
            amount_kind: "round",
            valuation_as_written: null,
            lead_investors: [],
            other_investors: [],
            announced_date: "2026-09-21",
            headquarters: null,
            sector: null,
            evidence_quote: facility,
            source_url: null,
            is_background: false,
            is_rumor: false,
          },
          source: { url: "https://example.org/news/vaulted", host: "example.org", title: "Vaulted Deep secures debt financing" },
          grounded: true,
          page_kind: "article",
        },
      ],
      { stages: ["debt"], windowStart: new Date("2026-09-01"), now: new Date("2026-09-27") },
    );
    expect(debt.kept.map((r) => [r.stage, r.amount.value])).toEqual([["debt", null]]);
    expect(resolve(facility, "$35 million", "Series A", "https://example.org/news/vaulted-a").dropped.notARound).toBe(1);
  });

  test("combined seed and pre-seed keeps both stages and aggregate without a round amount", () => {
    const result = resolve(
      "Example raised $20 million across its pre-seed and seed rounds.",
      "$20 million",
      "pre-seed and seed",
      "https://example.org/news/raise",
    );
    expect(result.kept[0]).toMatchObject({
      amount: { value: null },
      financing_total_as_written: "$20 million",
      financing_stages: ["pre_seed", "seed"],
    });
  });

  test("the source's later sentence discloses a secondary portion of Bird&Be's total", () => {
    const evidence =
      "Toronto-based Bird&Be, which sells subscriptions to fertility and wellness supplements and test kits, announced the all-equity, $13-million USD ($18.3 million CAD) Series A round on Tuesday.";
    const markdown = `${evidence} The Business Development Bank of Canada's Thrive Fund co-led the round with BFG Partners. Supporting were BAM Ventures and HSR Ventures. Bird&Be CEO Samantha Diamond told BetaKit that the round closed in August and included a small amount of secondary issuances.`;
    const extracted: ExtractedRound = {
      company_name: "Bird&Be",
      company_website: null,
      company_description: "fertility wellness startup",
      round_type_as_written: "Series A",
      amount_as_written: "$13-million USD",
      amount_kind: "round",
      valuation_as_written: null,
      lead_investors: [],
      other_investors: [],
      announced_date: "2026-09-22",
      headquarters: null,
      sector: null,
      evidence_quote: evidence,
      source_url: null,
      is_background: false,
      is_rumor: false,
    };
    const [item] = pageItems(
      [extracted],
      { url: "https://betakit.com/birdbe-raises-13-million-usd-series-a-for-fertility-support-platform/", host: "betakit.com" },
      markdown,
    );
    expect(item.round.money_kind).toBe("mixed");
    const result = resolveRounds([item], { stages: ["series_a"], windowStart: new Date("2026-09-01"), now: new Date("2026-09-27") });
    expect(result.kept[0]).toMatchObject({
      amount: { value: null },
      financing_total_as_written: "$13-million USD",
      amount_scope: "includes_secondary",
    });
  });

  test.each([
    ["Mazama Energy secured $135 million in Series B funding including grants.", "$135 million", "Series B", "includes_grants"],
    ["Bird&Be raised $13 million in a Series A including a secondary portion.", "$13 million", "Series A", "includes_secondary"],
    [
      "Example has raised $85 million in total funding to date, including the latest seed extension.",
      "$85 million",
      "Seed extension",
      "cumulative",
    ],
  ])("mixed or cumulative financing stays a scoped total: %s", (quote, figure, stage, scope) => {
    const result = resolve(quote.replace(/Mazama Energy|Bird&Be/g, "Example"), figure, stage, "https://example.org/news/financing");
    expect(result.kept[0]).toMatchObject({
      amount: { as_written: null, value: null },
      financing_total_as_written: figure,
      financing_total_quote: quote.replace(/Mazama Energy|Bird&Be/g, "Example"),
      amount_scope: scope,
    });
  });

  test("an IPO allocation cannot survive under a growth label", () => {
    const result = resolve(
      "Example raised ₹149 crore from anchor investors ahead of its IPO.",
      "₹149 crore",
      "growth",
      "https://example.org/news/ipo",
    );
    expect(result.kept).toHaveLength(0);
    expect(result.dropped.notARound).toBe(1);
  });

  test("ingest keeps a bare dollar in USD even on a Singaporean source", () => {
    const result = resolve(
      "Example, a Singapore-based payments provider, raised $25 million in a Series A funding round.",
      "$25 million",
      "Series A",
      "https://news.example.sg/2026/09/25/example-series-a",
    );
    expect(result.kept[0]?.amount.currency).toBe("USD");
  });
});

describe("audited lead roles", () => {
  test("equivalent numeric spellings identify the same round without matching another figure", () => {
    expect(amountInEvidence("$6.0M", "The $6 million seed was led by Storm Ventures.")).toBe(true);
    expect(amountInEvidence("$6.0M", "The $60 million growth round was led by Storm Ventures.")).toBe(false);
  });
  test.each([
    ["Aron", "Storm Ventures led the round, with participation from Menlo Ventures.", ["Storm Ventures"], ["Menlo Ventures"]],
    ["Bonbon", "The pre-seed round was led by Tasco, with GenAI Fund co-investing.", ["Tasco"], ["GenAI Fund"]],
    [
      "Parallax",
      "Greylock and General Catalyst co-led the Series A, with Eclipse participating.",
      ["Greylock", "General Catalyst"],
      ["Eclipse"],
    ],
    [
      "Raindrop",
      "Lightspeed Venture Partners led, joined by other investors including Beta Ventures.",
      ["Lightspeed Venture Partners"],
      ["Beta Ventures"],
    ],
    [
      "EUCLYD",
      "Innovation Industries, Samsung Catalyst Fund, Scaleup Europe Fund and Somerset Capital Partners co-led the round, with EQT Ventures participating.",
      ["Innovation Industries", "Samsung Catalyst Fund", "Scaleup Europe Fund", "Somerset Capital Partners"],
      ["EQT Ventures"],
    ],
  ] as const)("%s: lead language outranks participant lists", (_name, evidence, leads, participants) => {
    const actual = cleanInvestors({ lead_investors: [...leads, ...participants], other_investors: [], evidence, amount_as_written: null });
    expect(actual.lead_investors).toEqual(leads);
    expect(actual.other_investors).toEqual(participants);
  });

  test("a company's own release replaces a roundup's mistaken lead for the same round", () => {
    const make = (url: string, lead: string): Parameters<typeof resolveRounds>[0][number] => ({
      round: {
        company_name: "Atlas",
        company_website: "https://atlas.example",
        company_description: null,
        round_type_as_written: "Series A",
        amount_as_written: "$15 million",
        amount_kind: "round",
        valuation_as_written: null,
        lead_investors: [lead],
        other_investors: [],
        announced_date: "2026-09-24",
        headquarters: null,
        sector: null,
        evidence_quote: `Atlas raised a $15 million Series A led by ${lead}.`,
        source_url: null,
        is_background: false,
        is_rumor: false,
      },
      source: { url, host: hostOf(url), title: "Atlas raises Series A" },
      grounded: true,
      page_kind: "article",
    });
    const result = resolveRounds(
      [make("https://weekly.example/news/atlas-roundup", "Wrong Capital"), make("https://atlas.example/news/series-a", "True Ventures")],
      { stages: ["series_a"], windowStart: new Date("2026-09-01"), now: new Date("2026-09-27") },
    );
    expect(result.kept[0].lead_investors).toEqual(["True Ventures"]);
  });
});
