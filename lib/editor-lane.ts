// The editor lane's app side: which pages the editor reads for a round, which websites it may choose
// from, and one call that runs it (packages/core/src/llm/editor.ts holds the pass itself). It reads
// the same discovered pages the feed does and writes nothing: scripts/shadow-editor.ts records what
// it would show beside what the feed shows, so the two can be compared before either replaces the other.

import {
  DEFAULT_TIERS,
  type EditorOutcome,
  type EditorVerdict,
  editorPrompt,
  finalizeEdit,
  generateEditorVerdict,
  NON_ARTICLE_HOSTS,
  namesCompany,
  type RateTable,
  type ReadPages,
  type ReconcileModel,
  registrableDomain,
  type SiteCandidate,
  SOCIAL_AND_DIRECTORY_HOSTS,
  type SourceText,
} from "@fireround/core";
import type { Firecrawl } from "firecrawl";
import type { RoundRow } from "./persist.ts";

const WIRES = /(?:^|\.)(?:prnewswire|businesswire|globenewswire|accesswire|newswire|einpresswire|prweb)\.com$/;
const PAGES = 6;
const SITES = 5;
const LINK = /\[([^\]]{0,160})\]\((https?:\/\/[^)\s]+)\)/g;

/** The pages worth reading, best first: a wire, an established outlet, then the rest. The company's own site is not known yet. */
export function editorPages(row: RoundRow, tiers: Record<string, number> = DEFAULT_TIERS): RoundRow["sources"] {
  const rank = (s: RoundRow["sources"][number]) => {
    const domain = registrableDomain(s.url) ?? s.host;
    if (WIRES.test(domain)) return 0;
    return 1 - (tiers[s.host] ?? tiers[domain] ?? 0);
  };
  return [...row.sources].sort((a, b) => rank(a) - rank(b)).slice(0, PAGES);
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Websites that could be the company's: links on its pages whose domain or anchor names it, then a
 * search. Each is read once so the editor judges it from its own text, not its name.
 */
export async function siteCandidates(
  client: Firecrawl,
  company: string,
  pages: SourceText[],
  tiers: Record<string, number> = DEFAULT_TIERS,
): Promise<SiteCandidate[]> {
  const key = compact(company);
  const found = new Map<string, string>();
  const consider = (url: string, label: string) => {
    const domain = registrableDomain(url);
    if (!domain || found.has(domain) || WIRES.test(domain)) return;
    if (SOCIAL_AND_DIRECTORY_HOSTS.has(domain) || NON_ARTICLE_HOSTS.has(domain) || (tiers[domain] ?? 0) > 0) return;
    if ((key.length >= 3 && compact(domain).includes(key.slice(0, 12))) || namesCompany(label, company))
      found.set(domain, new URL(url).origin);
  };
  for (const page of pages) for (const m of page.markdown.matchAll(LINK)) consider(m[2], m[1]);
  try {
    const result = await client.search(`${company} company website`, { limit: 6 });
    for (const item of (result.web ?? []) as Array<{ url?: string; title?: string; description?: string }>)
      if (item.url) consider(item.url, `${item.title ?? ""} ${item.description ?? ""}`);
  } catch {
    // Without a search the candidates are the pages' own links.
  }
  const out: SiteCandidate[] = [];
  await Promise.all(
    [...found.values()].slice(0, SITES).map(async (url) => {
      try {
        const doc = await client.scrape(url, { formats: ["markdown"], onlyMainContent: true, timeout: 30_000, maxAge: 30 * 86_400_000 });
        out.push({ url, title: doc.metadata?.title ?? null, description: doc.metadata?.description ?? null, text: doc.markdown ?? null });
      } catch {
        out.push({ url, title: null, description: null, text: null });
      }
    }),
  );
  return out;
}

export interface EditorRun {
  outcome: EditorOutcome;
  verdict: EditorVerdict;
  pages: number;
  sites: number;
  usage: { input: number; output: number };
}

/** Read the round's pages and candidate sites and run the editor. Null when no page could be read or the model gave no answer. */
export async function editRow(
  row: RoundRow,
  client: Firecrawl,
  read: ReadPages,
  model: ReconcileModel,
  rates: RateTable | null,
  tiers: Record<string, number> = DEFAULT_TIERS,
): Promise<EditorRun | null> {
  const chosen = editorPages(row, tiers);
  const pages = await read(
    chosen.map((s) => ({ url: s.url, host: s.host, title: s.title ?? undefined, published: s.published ?? undefined })),
  );
  if (pages.length === 0) return null;
  const sites = await siteCandidates(client, row.company.name, pages, tiers);
  const input = { company: row.company.name, firstSeen: row.first_seen_at, pages, sites };
  const { output, usage } = await generateEditorVerdict(model, editorPrompt(input));
  if (!output) return null;
  return {
    outcome: finalizeEdit(input, output, rates, { history: row.history }),
    verdict: output,
    pages: pages.length,
    sites: sites.length,
    usage,
  };
}
