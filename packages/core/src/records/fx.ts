// Currency conversion with a reproducible, dated rate.
// Source: Frankfurter (ECB and other central banks, no API key). https://frankfurter.dev
// The pure `convertToUsd` is what the pipeline and the tests use; `fetchRates` is the only network call.

export interface RateTable {
  /** ISO date the rates are for. */
  date: string;
  /** Units of currency per 1 USD, keyed by ISO 4217 code. */
  perUsd: Record<string, number>;
}

export interface UsdConversion {
  usd_millions: number | null;
  fx_rate: number | null;
  fx_date: string | null;
}

/**
 * The publisher's own dollar figure in parentheses, "₦1.4 billion ($1 million)", for a currency the
 * rate table does not carry (the naira, the shilling). Null when the text states none.
 */
export function statedUsdMillions(asWritten: string | null | undefined): number | null {
  const m =
    /\(\s*(?:about|approximately|around|roughly|nearly|over|~)?\s*(?:US\$|USD\s?|\$)\s*(\d[\d,]*(?:\.\d+)?)\s*(billion|bn|b|million|mn|mm|m|thousand|k)?\b/i.exec(
      asWritten ?? "",
    );
  if (!m) return null;
  let value = Number(m[1].replace(/,/g, ""));
  const unit = (m[2] ?? "").toLowerCase();
  if (["billion", "bn", "b"].includes(unit)) value *= 1000;
  else if (["thousand", "k"].includes(unit)) value /= 1000;
  else if (unit === "") value /= 1_000_000;
  return value > 0 ? Math.round(value * 1000) / 1000 : null;
}

/** Currencies pegged to the dollar that the ECB table does not carry: the peg is the rate. */
const PEGGED_PER_USD: Record<string, number> = { AED: 3.6725, SAR: 3.75, QAR: 3.64, BHD: 0.376, OMR: 0.3845, JOD: 0.709 };

export function convertToUsd(
  valueMillions: number | null,
  currency: string | null,
  rates: RateTable | null,
  asWritten?: string | null,
): UsdConversion {
  if (valueMillions === null || !currency) return { usd_millions: null, fx_rate: null, fx_date: null };
  if (currency === "USD") return { usd_millions: valueMillions, fx_rate: 1, fx_date: rates?.date ?? null };
  const rate = rates?.perUsd[currency] ?? (rates ? PEGGED_PER_USD[currency] : undefined);
  if (!rate || !rates) {
    const stated = statedUsdMillions(asWritten);
    return stated === null
      ? { usd_millions: null, fx_rate: null, fx_date: null }
      : { usd_millions: stated, fx_rate: Math.round((valueMillions / stated) * 1000) / 1000, fx_date: null };
  }
  return { usd_millions: Math.round((valueMillions / rate) * 1000) / 1000, fx_rate: rate, fx_date: rates.date };
}

/** Rates for a given day (falls back to the nearest earlier business day server-side). */
export async function fetchRates(date: string | "latest" = "latest", fetchImpl: typeof fetch = fetch): Promise<RateTable> {
  const res = await fetchImpl(`https://api.frankfurter.dev/v1/${date}?base=USD`);
  if (!res.ok) throw new Error(`Frankfurter ${res.status} for ${date}`);
  const body = (await res.json()) as { date: string; rates: Record<string, number> };
  return { date: body.date, perUsd: body.rates };
}
