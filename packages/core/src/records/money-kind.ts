import { parseAmount } from "./normalize.ts";

export const MONEY_KINDS = [
  "primary",
  "tranche",
  "combined",
  "mixed",
  "cumulative",
  "future_commitment",
  "secondary",
  "ipo_allocation",
  "debt",
  "grant",
  "internal_spending",
  "unknown",
] as const;
export type MoneyKind = (typeof MONEY_KINDS)[number];

/** Scope of a reported financing whose primary amount is not isolated. */
export function mixedFinancingScope(text: string): "includes_grants" | "includes_secondary" | null {
  // "entirely of primary equity, with no debt or secondary transactions" rules a secondary out, not in.
  const sentence = text.replace(/\b(?:no|without|excluding|nor)\b[^.;]{0,60}?\b(?:secondary|grants?|subsid(?:y|ies))\b/gi, " ");
  if (
    /\b(?:including|included|inclusive of|compris(?:es|ing)|combined with|combination of|both|funding and)\b.{0,100}\b(?:grants?|subsid(?:y|ies))\b|\b(?:grants?|subsid(?:y|ies))\s+(?:and|plus)\s+(?:equity|series|funding)\b/i.test(
      sentence,
    )
  )
    return "includes_grants";
  if (
    /\b(?:including|included|inclusive of|compris(?:es|ing)|combination of|both)\b.{0,120}\bsecondary\b|\b(?:primary|fresh equity)\b.{0,80}\bsecondary\b|\bsecondary\b.{0,80}\b(?:primary|fresh equity)\b/i.test(
      sentence,
    )
  )
    return "includes_secondary";
  return null;
}

export const ISSUER_TYPES = ["operating_company", "fund", "listed_company", "government_program", "unknown"] as const;
export type IssuerType = (typeof ISSUER_TYPES)[number];

/** A financing issuer is not necessarily a startup, even when its headline says it raised money. */
export function issuerTypeFromEvidence(company: string, companyLine: string | null, evidence: string, label = ""): IssuerType {
  const transaction = `${label} ${evidence}`;
  const issuer = `${company} ${companyLine ?? ""}`;
  if (
    /\b(?:qip|qualified institutions? placement|follow[ -]?on public offer(?:ing)?|fpo|rights (?:issue|offering)|preferential (?:issue|allotment)|ipo (?:allocation|anchor book|proceeds))\b|\b(?:via|through|in|from) (?:an? |the )?(?:ipo|initial public offering)\b/i.test(
      transaction,
    ) ||
    /\b(?:listed on|listed company|publicly traded|publicly listed|stock exchange|bse-listed|nse-listed)\b|\((?:nasdaq|nyse|bse|nse|lse|asx|tsx)\s*:/i.test(
      issuer,
    )
  )
    return "listed_company";
  if (
    /\b(?:government|ministry|department|municipal|state[- ]run|public[- ]sector)\b.{0,55}\b(?:program(?:me)?|scheme|fund|initiative)\b/i.test(
      issuer,
    ) ||
    /\b(?:government|ministry|department|municipality|authority)\b/i.test(company)
  )
    return "government_program";
  if (
    /\bfund[- ]?[ivx0-9]+\b/i.test(company) ||
    /\b(?:first|final|second|interim)\s+clos(?:e|ing)\s+of\b.{0,90}\b(?:fund|lp commitments?|limited partners?)\b/i.test(transaction) ||
    (/\b(?:fund[- ]?[ivx0-9]+|venture (?:capital )?fund|private equity fund)\b/i.test(company) &&
      /\b(?:first|final|interim)\s+clos(?:e|ing)\b|\b(?:limited partners?|lp commitments?)\b/i.test(transaction)) ||
    (/\b(?:venture capital|investment|asset management|private equity)\s+(?:firm|fund|manager)\b/i.test(companyLine ?? "") &&
      /\b(?:fund|limited partners?|lp commitments?)\b/i.test(transaction))
  )
    return "fund";
  if (/\b(?:startup|company|platform|maker|developer|manufacturer|provider|operator|business)\b/i.test(companyLine ?? ""))
    return "operating_company";
  return "unknown";
}

export function nonStartupIssuerReason(issuer: IssuerType): string | null {
  if (issuer === "fund") return "fund close, not an operating company's financing";
  if (issuer === "listed_company") return "public company securities offering";
  if (issuer === "government_program") return "government programme, not a startup round";
  return null;
}

const FIGURE =
  /(?:US|AU|NZ|CA|SG|HK|A|C|S)?\$\s*\d[\d,.]*(?:\s*(?:million|billion|m|bn))?|(?:€|£|₹|¥|₩|₦|₱|₺|₪|₫|฿|₴|₽|₵|৳|₸)\s*\d[\d,.]*(?:\s*(?:million|billion|crore|m|bn))?|\b(?:USD|EUR|GBP|INR|AUD|CAD|NZD|SGD|HKD|CNY|RMB|Rs|JPY|KRW|CHF|SEK|NOK|DKK|BRL|ILS|AED|SAR|TWD|MXN|ZAR|PLN|CZK|HUF|RON|TRY|IDR|MYR|PHP|THB|VND|PKR|BDT|NGN|KES|EGP|GHS|ARS|CLP|COP|PEN|UAH|KZT|QAR|KWD|MAD)\s*\d[\d,.]*(?:\s*(?:million|billion|crore|m|bn))?/gi;

/** Reads the clause containing this particular figure, not an unrelated number elsewhere on the page. */
export function moneyKindFromSentence(sentence: string, figure: string | null): MoneyKind {
  const money = [...sentence.matchAll(FIGURE)];
  const target = figure ? parseAmount(figure) : null;
  const match = money.find((m) => {
    const parsed = parseAmount(m[0]);
    return target?.value !== null && parsed.value === target?.value && parsed.currency === target?.currency;
  });
  if (figure && !match) return "unknown";
  const index = match ? money.indexOf(match) : -1;
  const start = index > 0 ? (money[index - 1].index ?? 0) + money[index - 1][0].length : 0;
  // A converted figure in parentheses right after this one ("PLN 500 million (CAD 185 million)") is the same money, not the next clause.
  const after = (i: number) => (money[i].index ?? 0) + money[i][0].length;
  const converted = (i: number) =>
    i + 1 < money.length && /^\s*\(\s*(?:about|approximately|around|roughly|~)?\s*$/i.test(sentence.slice(after(i), money[i + 1].index));
  const next = index >= 0 && converted(index) ? index + 2 : index + 1;
  const end = index >= 0 && next < money.length ? (money[next].index ?? sentence.length) : sentence.length;
  const context = sentence
    .slice(start, end)
    .replace(/^.*?\b(?:including|comprising)\s+(?:a|an)\s+(?=[$€£₹]|\d)/i, "")
    .replace(index === 0 ? /,?\s*(?:bringing|taking)\s+(?:the |its )?(?:total|cumulative)\b.*$/i : /(?!)x/, "");
  if (mixedFinancingScope(context) || (sentence.length < 500 && mixedFinancingScope(sentence))) return "mixed";
  if (/\b(?:ipo (?:anchor|allocation|shares?|book)|anchor (?:book|investors?|shares?|allocation))\b/i.test(sentence))
    return "ipo_allocation";
  if (
    /\b(?:secondary (?:sale|transaction|shares?|stake|purchase|investment)|existing shares?|shares? from existing (?:holders?|investors?|shareholders?)|bought (?:existing )?shares?)\b/i.test(
      context,
    )
  )
    return /\b(?:primary|fresh equity|new equity)\b/i.test(context) ? "combined" : "secondary";
  if (
    /\b(?:will|plans? to|planned|intends? to|expects? to|committ?ed to)\s+(?:invest|spend|allocate)\b|\b(?:is|are) investing\b.{0,65}\b(?:in|into) (?:its|their|the company's) (?:own )?(?:products?|platform|technology|research|r&d)\b|\b(?:product|r&d|research and development) (?:spend|investment|budget)\b/i.test(
      context,
    ) &&
    !/\b(?:round|financing|raised|funding)\b/i.test(context)
  )
    return "internal_spending";
  const beforeFigure = match ? context.slice(0, context.lastIndexOf(match[0])).slice(-60) : context;
  const afterFigure = match
    ? context.slice(context.lastIndexOf(match[0]) + match[0].length, context.lastIndexOf(match[0]) + match[0].length + 45)
    : "";
  if (
    (/\b(?:future (?:investment|commitment)|forthcoming|conditional|expected|pledged|committed|commitment|will invest|to be invested|subject to)\b/i.test(
      beforeFigure,
    ) &&
      !/\b(?:closed|already invested|initial closing)\b/i.test(beforeFigure)) ||
    /^\s*(?:future |conditional |additional )?commitment\b/i.test(afterFigure)
  )
    return "future_commitment";
  if (/\b(?:grant|award|subsidy)\b/i.test(context) && !/\b(?:equity|round|financing)\b/i.test(context)) return "grant";
  if (
    /\b(?:debt financing|venture debt|debt facility|debt proceeds|growth capital facility|multi[ -]year facility|(?:term |venture )?loan (?:financing|facility|proceeds)|credit facility|credit line|borrowed|project financing|project finance|warehouse (?:financing|facility|line)|tax (?:credit|equity) (?:financing|commitments?|investment)|asset[- ]backed (?:financing|facility))\b|\b(?:in|of|through|via)\s+debt\b|\bdebt\s+(?:of|worth|totaling)\b/i.test(
      context,
    ) &&
    !/\b(?:equity|round|convertible|SAFE)\b/i.test(context)
  )
    return "debt";
  // Only the words at this figure: "$23 million in Series A funding ... brings its total funding to $29 million" totals the next one.
  if (
    /\b(?:funding (?:to date|since inception)|total (?:funding|raised|financing|proceeds)|cumulative|in total|raised (?:to date|so far|since)|bringing (?:its |the )?total|across (?:all|several|multiple) rounds)\b/i.test(
      match ? `${beforeFigure} ${match[0]} ${afterFigure}` : context,
    )
  )
    return "cumulative";
  if (
    /\b(?:combined|aggregate|across both|together|pre[ -]?seed and seed)\b/i.test(context) &&
    /\b(?:pre[ -]?seed|seed|series [a-z])\b.{0,90}\b(?:and|plus|alongside|as well as)\b.{0,35}\b(?:pre[ -]?seed|seed|series [a-z])\b/i.test(
      sentence,
    )
  )
    return "combined";
  if (/\b(?:initial|first|second|final)\b.{0,25}\btranche\b|\btranche (?:at|upon) closing\b/i.test(context)) return "tranche";
  if (
    /\b(?:primary|new) (?:capital|equity|investment|funding)|\b(?:raised|raises|secured|closed|announced)\b.{0,80}\b(?:round|financing|funding|investment)|\b(?:series [a-z]|seed|convertible (?:loan|notes?))\b|\b(?:led an?\b|closed\b)/i.test(
      context,
    )
  )
    return "primary";
  return "unknown";
}

export function safeMoneyKind(sentence: string, figure: string | null, model: MoneyKind | null = null): MoneyKind {
  const rules = moneyKindFromSentence(sentence, figure);
  if (rules !== "unknown" && rules !== "primary") return rules;
  if (model && model !== "unknown" && model !== "primary") return model;
  return rules === "primary" || model === "primary" ? "primary" : "unknown";
}
