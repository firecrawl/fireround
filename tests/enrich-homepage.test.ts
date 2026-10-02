// The homepage fallback for companies the accuracy check flagged with no verified domain. Each
// failure class that left a top company without a homepage has a case here (a host that spells only
// part of the name, a news-word filter that read "tech" in krakentechnology.com, dossier sources that
// already held the site, a homepage too big for the extraction, "Inc." in the search), beside the
// refusals that must still hold: a namesake, a parked domain, a parent's site, a news host.

import {
  aboutLink,
  brandDisownsHost,
  brandNamesOtherEntity,
  type CompanyProfile,
  enrichCompanies,
  homepageOf,
  hostFit,
  identityPrompt,
  listingNamesCompany,
  pressLinks,
  searchName,
  searchWebsites,
  siteCandidates,
  websiteQuery,
} from "@fireround/core";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { describe, expect, test } from "vitest";
import { clearUnverifiedProfiles, enrichBatch, isPending, isVerified } from "../lib/enrich";
import { persistRecords } from "../lib/persist";
import { record, testDb } from "./helpers";

interface Page {
  json?: unknown;
  links?: string[];
  markdown?: string;
  metadata?: { title?: string };
  branding?: { brandName?: string };
}

interface Hit {
  url: string;
  title?: string;
  description?: string;
}

/**
 * A client whose search answers per query and whose scrape answers per page: a fixture keyed
 * "host/path" wins over one keyed by host. Every query, read, and identity prompt is recorded.
 */
function fakeClient(search: (query: string) => Hit[], pages: Record<string, Page | Error>) {
  const calls = { search: [] as string[], scrape: [] as string[], prompts: new Map<string, string>() };
  const client = {
    async search(query: string) {
      calls.search.push(query);
      return { web: search(query).map((h) => ({ title: null, description: null, ...h })) };
    },
    async scrape(url: string, options: { formats: Array<string | { type: string; prompt?: string }> }) {
      calls.scrape.push(url);
      const json = options.formats.find((f): f is { type: string; prompt?: string } => typeof f === "object" && f.type === "json");
      if (json?.prompt) calls.prompts.set(url, json.prompt);
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "");
      const path = u.pathname.replace(/\/+$/, "");
      const page = pages[`${host}${path}`] ?? pages[host];
      if (!page) throw new Error(`no fixture for ${url}`);
      if (page instanceof Error) throw page;
      return { links: [], metadata: { title: host }, ...page };
    },
  };
  return { client: client as unknown as Firecrawl, calls };
}

/** A verdict that the site is the record's company. */
const same = (what_they_sell: string): CompanyProfile => ({
  same_company: true,
  identity_reason: `${what_they_sell} Compatible with the record.`,
  different_business: null,
  what_they_sell,
  customer_type: "B2B software",
  sells_software_subscription: false,
});

/** A verdict that names the different business the site is in. */
const namesake = (different_business: string): CompanyProfile => ({
  same_company: false,
  identity_reason: `The site is ${different_business}, not the record's company.`,
  different_business,
  what_they_sell: `A ${different_business}.`,
  customer_type: "other",
  sells_software_subscription: false,
});

const UPWIND = {
  company_key: "upwind security",
  company_name: "Upwind Security Inc.",
  company_website: "https://upwindsecurity.com",
  company_description: "an automated cloud security platform",
  headquarters: "San Francisco, USA",
  sector: "cybersecurity",
};

describe("how a host spells the company's name", () => {
  test("a host that drops the descriptor words fits loosely, where the old rule dropped it", () => {
    expect(hostFit("www.cornelis.com", "Cornelis Networks")).toBe("loose");
    expect(hostFit("www.upwind.io", "Upwind Security Inc.")).toBe("loose");
    expect(hostFit("krakentechnology.com", "Kraken Technology Group")).toBe("loose");
    expect(hostFit("www.regentcraft.com", "REGENT")).toBe("loose");
    // The name running on into the suffix is the whole name.
    expect(hostFit("penelope.health", "Penelope Health")).toBe("exact");
    expect(hostFit("upwindsecurity.com", "Upwind Security Inc.")).toBe("exact");
  });

  test("the label is the registrable domain's, not the first host segment", () => {
    expect(hostFit("about.wonder.com", "Wonder")).toBe("exact");
    expect(homepageOf("https://about.wonder.com/news/details/2026/series-d/default.aspx")).toBe("https://wonder.com");
    expect(homepageOf("https://www.upwind.io/about")).toBe("https://upwind.io");
  });

  test("hosts that do not spell the name, or spell a short name with an affix, do not fit", () => {
    // An affix around a four-letter name spells too many other things.
    expect(hostFit("thehive.ai", "Hive")).toBeNull();
    expect(hostFit("hive.com", "Hive")).toBe("exact");
    expect(hostFit("nilohealth.com", "Nilo")).toBeNull();
    expect(hostFit("saintpatrickscathedral.org", "Cathedral")).toBeNull();
    expect(hostFit("oceannews.com", "Kraken Technology Group")).toBeNull();
    // A parent's domain spells only part of its unit's name: a candidate at most, never exact.
    expect(hostFit("xpeng.com", "Xpeng Robotics")).toBe("loose");
  });

  test("the search writes the name without its legal suffix", () => {
    expect(searchName("Upwind Security Inc.")).toBe("Upwind Security");
    expect(searchName("Medical Microinstruments, S.p.A.")).toBe("Medical Microinstruments");
    expect(websiteQuery({ company_name: "Upwind Security Inc." })).toBe("Upwind Security official website");
    expect(websiteQuery(UPWIND)).not.toContain("Inc.");
  });
});

describe("the search keeps what the old match dropped, and only that", () => {
  test("the Upwind case: a parked record website is refused, and the loose host the search lists under the whole name verifies", async () => {
    const { client, calls } = fakeClient(
      () => [
        { url: "https://www.upwind.io/", title: "Upwind Security: Cloud & AI Security for the Realtime Era" },
        { url: "https://www.linkedin.com/company/upwindsecurity", title: "Upwind Security - LinkedIn" },
        { url: "https://www.upwind.io/about", title: "About - Upwind Security" },
      ],
      {
        "upwindsecurity.com": {
          metadata: { title: "upwindsecurity.com is for sale" },
          links: ["https://sedo.com/search/details/?domain=upwindsecurity.com"],
        },
        "upwind.io": { json: same("Upwind sells a cloud and AI security platform to security teams.") },
      },
    );
    const { enrichments } = await enrichCompanies(client, [UPWIND], { pricingPage: false });
    const [e] = enrichments;
    expect(calls.search[0]).toBe("Upwind Security automated cloud platform San Francisco cybersecurity");
    expect(calls.scrape).toEqual(["https://upwindsecurity.com", "https://upwind.io"]);
    expect(e?.company_website).toBe("https://upwind.io");
    expect(e?.website_source).toBe("search");
    expect(e?.identity_basis).toBe("homepage");
    expect(e?.refused_hosts).toEqual(["upwindsecurity.com"]);
    // A loose host is asked about a parent as well.
    expect(calls.prompts.get("https://upwind.io")).toContain('This site\'s domain spells only "upwind"');
    expect(calls.prompts.get("https://upwindsecurity.com")).not.toContain("spells only");
  });

  test("the Kraken case: krakentechnology.com is kept though it contains 'tech'; kraken.tech, listed under another name, is not read", async () => {
    const { client, calls } = fakeClient(
      () => [
        { url: "https://krakentechnology.com/", title: "Kraken Technology Group" },
        {
          url: "https://oceannews.com/news/milestones/kraken-technology-group-closes-series-b",
          title: "Kraken Technology Group Closes Series B",
        },
        { url: "https://www.kraken.tech/", title: "Kraken Tech" },
      ],
      { "krakentechnology.com": { json: same("Autonomous maritime platforms for defence.") } },
    );
    const { enrichments } = await enrichCompanies(
      client,
      [
        {
          company_key: "kraken technology group",
          company_name: "Kraken Technology Group",
          company_website: null,
          company_description: "a maker of autonomous maritime defence platforms",
          headquarters: "London, UK",
          sector: "defense",
        },
      ],
      { pricingPage: false },
    );
    expect(calls.scrape).toEqual(["https://krakentechnology.com"]);
    expect(enrichments[0]?.company_website).toBe("https://krakentechnology.com");
  });

  test("a loose host needs a description to judge it against, and its own front page listed under the whole name", async () => {
    const hits = [
      { url: "https://www.xpeng.com/news/01a03797", title: "XPENG Robotics Raises US$900M for Humanoid Robots" },
      { url: "https://www.xpeng.com/", title: "XPENG" },
    ];
    const { client } = fakeClient(() => hits, {});
    // A parent's news post about its unit is not the unit's front page.
    expect((await searchWebsites(client, { company_name: "Xpeng Robotics", company_description: "humanoid robots" })).homepages).toEqual(
      [],
    );
    const upwind = fakeClient(() => [{ url: "https://www.upwind.io/", title: "Upwind Security: Cloud & AI Security" }], {});
    expect((await searchWebsites(upwind.client, UPWIND)).homepages).toEqual(["https://upwind.io"]);
    expect((await searchWebsites(upwind.client, UPWIND, 3, { loose: false })).homepages).toEqual([]);
  });

  test("with only a funding sentence on the record, a loose host is never read", async () => {
    const { client, calls } = fakeClient(() => [{ url: "https://thehive.ai/", title: "Hive: AI content moderation" }], {
      "hive.com": new Error("timeout"),
    });
    const { enrichments } = await enrichCompanies(
      client,
      [{ company_key: "hive", company_name: "Hive", company_website: null, evidence: "HIVE raised $50M for its payroll software." }],
      { pricingPage: false },
    );
    // thehive.ai does not fit a four-letter name, and no invented .com is scraped.
    expect(calls.scrape).toEqual([]);
    expect(enrichments[0]?.company_website).toBeNull();
    expect(enrichments[0]?.website_source).toBe("none");
  });
});

describe("the store's own evidence names the site before any search", () => {
  test("a short brand's hello domain in its own dated announcement is a homepage candidate, never a guessed .com", () => {
    expect(siteCandidates("Sol", [{ url: "https://hellosol.app/here-comes-the-sun", title: "Sol emerges from stealth with $4M" }])).toEqual(
      ["https://hellosol.app"],
    );
  });
  const CORNELIS = {
    company_key: "cornelis networks",
    company_name: "Cornelis Networks",
    company_website: null,
    company_description: "high-speed networking for AI infrastructure",
    headquarters: "Chesterbrook, USA",
    sector: "semiconductors",
  };

  test("the Cornelis case: the dossier read cornelis.com, so it is read first and no search is made", async () => {
    const { client, calls } = fakeClient(() => [], { "cornelis.com": { json: same("High-performance networking for AI and HPC.") } });
    const { enrichments } = await enrichCompanies(
      client,
      [{ ...CORNELIS, dossier_sources: ["https://www.hpcwire.com/2026/cornelis-raises", "https://www.cornelis.com/company"] }],
      { pricingPage: false },
    );
    expect(calls.search).toEqual([]);
    expect(calls.scrape).toEqual(["https://cornelis.com"]);
    expect(enrichments[0]?.company_website).toBe("https://cornelis.com");
    expect(enrichments[0]?.website_source).toBe("sources");
  });

  test("a host that does not spell the name counts only with two dossier pages, one of them its own front or about page", () => {
    expect(
      siteCandidates("Medical Microinstruments", [], ["https://www.mmimicro.com/", "https://www.mmimicro.com/blog/2018/04/18/series-a"]),
    ).toEqual(["https://mmimicro.com"]);
    expect(siteCandidates("Medical Microinstruments", [], ["https://www.mmimicro.com/blog/a", "https://www.mmimicro.com/blog/b"])).toEqual(
      [],
    );
    expect(siteCandidates("Medical Microinstruments", [], ["https://www.mmimicro.com/"])).toEqual([]);
  });

  test("a portal the dossier quoted twice, a news host, a directory, or a wire is never the company's site", () => {
    expect(
      siteCandidates(
        "Jierendi Electronic Technology",
        [],
        ["https://finance.sina.com.cn/a/1.shtml", "https://finance.sina.com.cn/b/2.shtml"],
      ),
    ).toEqual([]);
    expect(siteCandidates("Acme Robotics", [], ["https://techcrunch.com/", "https://techcrunch.com/2026/09/01/acme"])).toEqual([]);
    expect(
      siteCandidates("Acme Robotics", [
        { url: "https://www.crunchbase.com/organization/acme-robotics", title: "Acme Robotics" },
        { url: "https://www.prnewswire.com/news-releases/acme-robotics-raises.html", title: "Acme Robotics raises $20M" },
      ]),
    ).toEqual([]);
  });

  test("a round source on a loose host counts only when its title names the company", () => {
    expect(
      siteCandidates("Upwind Security Inc.", [{ url: "https://www.upwind.io/blog/series-e", title: "Upwind Security raises $250M" }]),
    ).toEqual(["https://upwind.io"]);
    expect(siteCandidates("Xpeng Robotics", [{ url: "https://www.xpeng.com/news/01a0", title: "XPENG Q2 deliveries" }])).toEqual([]);
  });

  test("enrichBatch hands the dossier's sources to the check: the flagged company gets its site and domain", async () => {
    const db = await testDb();
    await persistRecords(
      db,
      [
        record({
          company_name: "Cornelis Networks",
          company_key: "cornelis networks",
          company_description: CORNELIS.company_description,
          sources: [{ url: "https://www.hpcwire.com/2026/cornelis-raises", host: "hpcwire.com", title: "Cornelis raises $80M" }],
        }),
      ],
      "seed",
      "run-1",
    );
    await db.insert(schema.enrichments).values({
      companyId: "cornelis networks",
      kind: "deep_dive",
      data: { sources: ["https://www.cornelis.com/company", "https://www.hpcwire.com/2026/cornelis-raises"] },
    });
    const { client, calls } = fakeClient(() => [], { "cornelis.com": { json: same("High-performance networking for AI and HPC.") } });
    const r = await enrichBatch(
      db,
      client,
      [
        {
          id: "cornelis networks",
          name: "Cornelis Networks",
          website: null,
          description: CORNELIS.company_description,
          hq: null,
          sector: null,
        },
      ],
      { pricingPage: false },
    );
    expect(r.resolved).toBe(1);
    expect(calls.search).toEqual([]);
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, "cornelis networks"));
    expect(company?.domain).toBe("cornelis.com");
  });
});

describe("a homepage too big for the extraction", () => {
  test("the Twelve Labs case: no JSON from the homepage, so its own about page answers the identity check", async () => {
    const { client, calls } = fakeClient(() => [], {
      "twelvelabs.io": { json: undefined, links: ["https://www.twelvelabs.io/pricing", "https://www.twelvelabs.io/about-us"] },
      "twelvelabs.io/about-us": { json: same("Video understanding models for developers.") },
    });
    const { enrichments } = await enrichCompanies(
      client,
      [
        {
          company_key: "twelve",
          company_name: "Twelve Labs",
          company_website: "https://twelvelabs.io",
          company_description: "an AI video understanding company",
        },
      ],
      { pricingPage: false },
    );
    const [e] = enrichments;
    expect(calls.scrape).toEqual(["https://twelvelabs.io", "https://www.twelvelabs.io/about-us"]);
    expect(e?.identity_basis).toBe("about_page");
    expect(e?.identity_evidence).toEqual(["https://www.twelvelabs.io/about-us"]);
    expect(e?.profile?.what_they_sell).toContain("Video understanding");
    expect(isVerified(e as NonNullable<typeof e>)).toBe(true);
  });

  test("the about link is the site's own about page, on the domain or its about subdomain", () => {
    expect(
      aboutLink(["https://other.com/about", "https://www.acme.com/about-us", "https://www.acme.com/company"], "https://acme.com"),
    ).toBe("https://www.acme.com/about-us");
    expect(aboutLink(["https://about.wonder.com/about-us"], "https://wonder.com")).toBe("https://about.wonder.com/about-us");
    expect(aboutLink(["https://acme.com/blog/about-our-seed"], "https://acme.com")).toBeNull();
  });

  const WONDER = {
    company_key: "wonder.com",
    company_name: "Wonder",
    company_website: "https://wonder.com",
    company_description: "an operator of kitchens and meal delivery services",
    headquarters: "New York, USA",
  };
  const OVERFLOW: Page = { json: undefined, links: [] };

  test("the Wonder case: unreadable, but the round's own page on the domain and a live listing naming the company confirm it", async () => {
    const own = "https://about.wonder.com/news/details/2026/Wonder-Announces-650-Million-Series-D/default.aspx";
    const { client } = fakeClient(() => [{ url: "https://www.wonder.com/", title: "Wonder | Food Delivery & Takeout" }], {
      "wonder.com": OVERFLOW,
    });
    const { enrichments } = await enrichCompanies(
      client,
      [{ ...WONDER, source_pages: [{ url: own, title: "Wonder Announces $650 Million Series D Round" }] }],
      { pricingPage: false },
    );
    const [e] = enrichments;
    expect(e?.company_website).toBe("https://wonder.com");
    expect(e?.identity_basis).toBe("linked");
    expect(e?.identity_evidence).toEqual([own, "https://www.wonder.com/"]);
    // Nothing was read off the site, so nothing is written from it.
    expect(e?.profile).toBeNull();
    expect(e?.logo_url).toBeNull();
    expect(isVerified(e as NonNullable<typeof e>)).toBe(true);
    expect(isPending(e as NonNullable<typeof e>)).toBe(false);
  });

  test("the Candid case: the round's wire release links the site, which confirms it with the listing", async () => {
    const wire = "https://www.prnewswire.com/news-releases/candid-health-raises-120m-series-d.html";
    const { client, calls } = fakeClient(
      () => [{ url: "https://candidhealth.com/", title: "Candid Health: Healthcare Revenue Cycle Automation" }],
      {
        "candidhealth.com": OVERFLOW,
        "prnewswire.com/news-releases/candid-health-raises-120m-series-d.html": {
          markdown: "[Candid Health](https://www.candidhealth.com/) today announced a $120M Series D. [Read more](https://techcrunch.com/)",
        },
      },
    );
    const { enrichments } = await enrichCompanies(
      client,
      [
        {
          company_key: "candidhealth.com",
          company_name: "Candid Health",
          company_website: "https://candidhealth.com",
          company_description: "healthcare revenue cycle software",
          source_pages: [{ url: wire, title: "Candid Health Raises $120M Series D" }],
        },
      ],
      { pricingPage: false },
    );
    expect(calls.scrape).toContain(wire);
    expect(enrichments[0]?.identity_basis).toBe("linked");
    expect(enrichments[0]?.identity_evidence).toEqual([wire, "https://candidhealth.com/"]);
  });

  test("a listing alone, or a round page beside a parked listing, confirms nothing: the site stays pending", async () => {
    const alone = fakeClient(() => [{ url: "https://www.wonder.com/", title: "Wonder | Food Delivery & Takeout" }], {
      "wonder.com": OVERFLOW,
    });
    const { enrichments: a } = await enrichCompanies(alone.client, [WONDER], { pricingPage: false });
    expect(a[0]?.identity_basis).toBeUndefined();
    expect(a[0]?.company_website).toBe("https://wonder.com");
    expect(isPending(a[0] as NonNullable<(typeof a)[0]>)).toBe(true);

    const parked = fakeClient(() => [{ url: "https://wonder.com/", title: "wonder.com is for sale" }], { "wonder.com": OVERFLOW });
    const { enrichments: p } = await enrichCompanies(
      parked.client,
      [{ ...WONDER, source_pages: [{ url: "https://wonder.com/news/series-d", title: "Wonder raises $650M" }] }],
      { pricingPage: false },
    );
    expect(p[0]?.identity_basis).toBeUndefined();
    expect(listingNamesCompany({ url: "https://wonder.com/", title: "Wonder - buy this domain", description: null }, "Wonder")).toBe(false);
  });

  test("a linked site lands its website and domain, no logo, and the reverify leaves it settled", async () => {
    const db = await testDb();
    await persistRecords(
      db,
      [
        record({
          company_name: "Wonder",
          company_key: "wonder",
          company_description: WONDER.company_description,
          sources: [
            { url: "https://about.wonder.com/news/series-d", host: "about.wonder.com", title: "Wonder Announces $650 Million Series D" },
          ],
        }),
      ],
      "seed",
      "run-1",
    );
    const { client } = fakeClient(() => [{ url: "https://www.wonder.com/", title: "Wonder | Food Delivery & Takeout" }], {
      "wonder.com": OVERFLOW,
    });
    const r = await enrichBatch(
      db,
      client,
      [{ id: "wonder", name: "Wonder", website: null, description: WONDER.company_description, hq: null, sector: null }],
      { pricingPage: false },
    );
    expect(r.resolved).toBe(1);
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, "wonder"));
    expect(company?.website).toBe("https://wonder.com");
    expect(company?.domain).toBe("wonder.com");
    expect(company?.logoUrl).toBeNull();
    expect(await clearUnverifiedProfiles(db)).toEqual({ cleared: 0 });
  });
});

describe("the refusals that must hold", () => {
  test("the Creem case: an exact-name namesake that names its business is refused and nothing is kept", async () => {
    const { client } = fakeClient(() => [], { "creem.com": { json: namesake("rock music magazine") } });
    const { enrichments } = await enrichCompanies(
      client,
      [
        {
          company_key: "creem.com",
          company_name: "Creem",
          company_website: "https://www.creem.com/",
          company_description: "a billing and monetisation platform for AI-native software companies",
          headquarters: "Tallinn, Estonia",
        },
      ],
      { pricingPage: false },
    );
    expect(enrichments[0]?.company_website).toBeNull();
    expect(enrichments[0]?.website_source).toBe("unverified");
    expect(enrichments[0]?.refused_hosts).toEqual(["creem.com"]);
  });

  test("the Cathedral case: the churches the bare name finds are each refused, and no website is written", async () => {
    const { client, calls } = fakeClient(
      (q) =>
        q.endsWith("official website")
          ? [
              { url: "https://cathedral.org/", title: "Home - Washington National Cathedral" },
              { url: "https://cathedralstl.org/", title: "Cathedral Basilica of St. Louis" },
              { url: "https://saintpatrickscathedral.org/", title: "St. Patrick's Cathedral" },
              { url: "https://olacathedral.org/", title: "Cathedral of Our Lady of the Angels" },
            ]
          : [
              {
                url: "https://www.reuters.com/technology/doge-alumni-launch-military-cyber-startup",
                title: "DOGE alumni launch military cyber startup",
              },
              { url: "https://www.executivebiz.com/articles/cathedral-raises-160m", title: "Cathedral Raises $160M" },
            ],
      {
        "cathedral.org": { json: namesake("worship services and community events") },
        "cathedralstl.org": { json: namesake("a cathedral for church services") },
        "olacathedral.org": { json: namesake("a religious institution") },
      },
    );
    const { enrichments } = await enrichCompanies(
      client,
      [
        {
          company_key: "cathedral",
          company_name: "Cathedral",
          company_website: null,
          company_description: "provides AI-driven cyber capabilities to the U.S. military",
          headquarters: "Washington, USA",
          sector: "defense",
        },
      ],
      { pricingPage: false },
    );
    expect(calls.scrape).toEqual(["https://cathedral.org", "https://cathedralstl.org", "https://olacathedral.org"]);
    expect(enrichments[0]?.company_website).toBeNull();
    expect(enrichments[0]?.website_source).toBe("unverified");
  });

  test("the Cathedral case in production: the model took the church for the company, and the site's own name refuses it", async () => {
    const { client } = fakeClient(
      (q) => (q.endsWith("official website") ? [{ url: "https://cathedral.org/", title: "Home - Washington National Cathedral" }] : []),
      {
        "cathedral.org": {
          json: same("Cathedral provides AI-driven cyber capabilities to the U.S. military."),
          branding: { brandName: "Washington National Cathedral" },
        },
      },
    );
    const { enrichments } = await enrichCompanies(
      client,
      [
        {
          company_key: "cathedral",
          company_name: "Cathedral",
          company_website: null,
          company_description: "provides AI-driven cyber capabilities to the U.S. military",
          headquarters: "Washington, D.C.",
          sector: "defense",
        },
      ],
      { pricingPage: false },
    );
    expect(enrichments[0]?.company_website).toBeNull();
    expect(enrichments[0]?.profile).toBeNull();
    expect(enrichments[0]?.refused_hosts).toContain("cathedral.org");
  });

  test("a site named for a trailing fragment of the name is that fragment's company, not this one", () => {
    expect(brandDisownsHost("scale.com", "Scale AI", "CScale")).toBe(true);
    // Read off every verified homepage on 2026-10-02: none of these is refused.
    expect(brandDisownsHost("clastix.io", "Clastix", "Italy’s Clastix")).toBe(false);
    expect(brandDisownsHost("mycomplianceoffice.com", "MyComplianceOffice", "MCO (MyComplianceOffice)")).toBe(false);
    expect(brandDisownsHost("breedr.com", "Breedr.com", "Breedr Impact")).toBe(false);
    expect(brandDisownsHost("helixdi.com", "Home", "Helix Digital Infrastructure")).toBe(false);
    expect(brandDisownsHost("cscale.ai", "CScale", "CScale")).toBe(false);
    expect(brandDisownsHost("scale.com", null, "CScale")).toBe(false);
  });

  test("a brand that is someone else holding the name is refused; the brands real companies wear pass", () => {
    expect(brandNamesOtherEntity("Washington National Cathedral", "Cathedral")).toBe(true);
    expect(brandNamesOtherEntity("Regent University", "REGENT")).toBe(true);
    expect(brandNamesOtherEntity("St. Patrick's Cathedral", "Patrick")).toBe(true);
    // Brands read off verified homepages on Sep 24: shorter, joined up, taglines, descriptors after the name.
    expect(brandNamesOtherEntity("TwelveLabs", "Twelve Labs")).toBe(false);
    expect(brandNamesOtherEntity("Kraken Technology", "Kraken Technology Group")).toBe(false);
    expect(brandNamesOtherEntity("Upwind | Cloud & AI Security for the Realtime Era", "Upwind Security Inc.")).toBe(false);
    expect(brandNamesOtherEntity("Spend, send, save and boss money around with Tabby", "Tabby")).toBe(false);
    expect(brandNamesOtherEntity("Axya Procurement Software", "Axya")).toBe(false);
    expect(brandNamesOtherEntity("Aqua Medical", "Aqua Medical, Inc.")).toBe(false);
    expect(brandNamesOtherEntity("MMI", "Medical Microinstruments")).toBe(false);
    expect(brandNamesOtherEntity("Get Ando", "Ando")).toBe(false);
    expect(brandNamesOtherEntity(null, "Cathedral")).toBe(false);
  });

  test("the Regent case: Regent University is refused, regentcraft.com verifies", async () => {
    const { client } = fakeClient(
      (q) =>
        q.endsWith("official website")
          ? [
              { url: "https://www.regent.edu/", title: "Regent University: Top Christian College in Virginia" },
              { url: "https://www.regentcraft.com/", title: "REGENT | The Future of Maritime Mobility" },
            ]
          : [
              {
                url: "https://www.flyingmag.com/regent-craft-electric-seaglider",
                title: "Regent Craft Finishes Seaglider Production Center",
              },
            ],
      {
        "regent.edu": { json: namesake("a Christian university") },
        "regentcraft.com": { json: same("Electric seagliders for coastal transport.") },
      },
    );
    const { enrichments } = await enrichCompanies(
      client,
      [
        {
          company_key: "regent",
          company_name: "REGENT",
          company_website: null,
          company_description: "an electric wing-in-ground-effect seaglider manufacturer",
          headquarters: "Boston, USA",
        },
      ],
      { pricingPage: false },
    );
    expect(enrichments[0]?.company_website).toBe("https://regentcraft.com");
    expect(enrichments[0]?.refused_hosts).toEqual(["regent.edu"]);
  });

  const XPENG = {
    company_key: "xpeng robotics",
    company_name: "Xpeng Robotics",
    company_website: "https://xpengrobotics.com",
    company_description: "a developer of AI-enabled humanoid robots",
    headquarters: "Guangzhou, China",
    sector: "robotics",
  };

  test("the Xpeng case: the parked guess is refused and the parent's site is never read", async () => {
    const { client, calls } = fakeClient(
      () => [
        { url: "https://www.xpeng.com/news/01a03797", title: "XPENG Robotics Raises US$900M for Humanoid Robots" },
        { url: "https://www.xpeng.com/", title: "XPENG" },
        { url: "https://ir.xiaopeng.com/", title: "Investor Relations | XPeng Inc." },
      ],
      { "xpengrobotics.com": { metadata: { title: "xpengrobotics.com is for sale" } } },
    );
    const { enrichments } = await enrichCompanies(client, [XPENG], { pricingPage: false });
    expect(calls.scrape).toEqual(["https://xpengrobotics.com"]);
    expect(enrichments[0]?.company_website).toBeNull();
    expect(enrichments[0]?.website_source).toBe("parked");
  });

  test("a parent's site that does get read is asked about a parent, and a false naming it is final", async () => {
    const { client, calls } = fakeClient(() => [{ url: "https://www.xpeng.com/", title: "XPENG Robotics and smart electric vehicles" }], {
      "xpengrobotics.com": { metadata: { title: "xpengrobotics.com is for sale" } },
      "xpeng.com": { json: namesake("a carmaker of smart electric vehicles, the parent of the robotics unit") },
    });
    const { enrichments } = await enrichCompanies(client, [XPENG], { pricingPage: false });
    expect(calls.prompts.get("https://xpeng.com")).toContain('spells only "xpeng", not the full name "Xpeng Robotics"');
    expect(identityPrompt(XPENG)).toContain("A parent company, group, or sibling business");
    expect(enrichments[0]?.company_website).toBeNull();
    expect(enrichments[0]?.refused_hosts).toEqual(["xpengrobotics.com", "xpeng.com"]);
  });

  test("the HIVE case: an unreadable host only the bare name's search offered is not kept, one the record's words found is", async () => {
    const HIVE = {
      company_key: "hive",
      company_name: "HIVE",
      company_website: null,
      evidence: "SuperSeed led HIVE's £11.2M.",
      headquarters: "London, UK",
    };
    const byName = fakeClient(
      (q) => (q.endsWith("official website") ? [{ url: "https://hive.com/", title: "Project Management Software | Hive" }] : []),
      {
        "hive.com": { json: undefined },
      },
    );
    const { enrichments: named } = await enrichCompanies(byName.client, [HIVE], { pricingPage: false });
    expect(byName.calls.scrape).toEqual(["https://hive.com"]);
    expect(named[0]?.company_website).toBeNull();
    expect(named[0]?.unreadable_hosts).toEqual(["hive.com"]);
    const grounded = fakeClient(() => [{ url: "https://hive.com/", title: "HIVE | London" }], { "hive.com": { json: undefined } });
    const { enrichments: kept } = await enrichCompanies(grounded.client, [HIVE], { pricingPage: false });
    expect(kept[0]?.company_website).toBe("https://hive.com");
    expect(kept[0]?.website_source).toBe("search");
  });

  test("a press page's links to news hosts and article paths are not the company's site", () => {
    const md = [
      "[Candid Health](https://www.candidhealth.com/) raised $120M.",
      "Coverage: [TechCrunch](https://techcrunch.com/2026/07/01/candid-health-raises/) and [the Journal](https://www.healthjournal.com/).",
      "[Sixth Street](https://sixthstreet.com/) led the round.",
    ].join("\n");
    expect(pressLinks(md, "https://www.prnewswire.com/news-releases/x.html", "Candid Health")).toEqual(["https://candidhealth.com"]);
  });
});
