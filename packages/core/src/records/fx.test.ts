import { describe, expect, test } from "vitest";
import { convertToUsd, statedUsdMillions } from "./fx.ts";
import { parseAmount } from "./normalize.ts";

const RATES = { date: "2026-09-30", perUsd: { EUR: 0.92, PLN: 3.9, PHP: 57 } };

describe("currencies beyond the dollar, euro, pound, yen, rupee and won", () => {
  // Ororo Waste, 2026-10-02: the naira figure was read as $1.4 billion because only the "$" in "($1 million)" was a known sign.
  test("₦1.4 billion ($1 million) is naira, worth the stated $1 million", () => {
    const parsed = parseAmount("₦1.4 billion ($1 million)");
    expect(parsed).toEqual({ value: 1400, currency: "NGN" });
    expect(convertToUsd(parsed.value, parsed.currency, RATES, "₦1.4 billion ($1 million)")).toEqual({
      usd_millions: 1,
      fx_rate: 1400,
      fx_date: null,
    });
  });

  test("other currency signs and codes name their currency", () => {
    expect(parseAmount("₱500 million").currency).toBe("PHP");
    expect(parseAmount("₺20 million").currency).toBe("TRY");
    expect(parseAmount("PLN 500 million (CAD 185 million)")).toEqual({ value: 500, currency: "PLN" });
    expect(parseAmount("KES 650 million").currency).toBe("KES");
  });

  test("a currency the rate table lacks and no stated dollar figure stays unpriced", () => {
    expect(convertToUsd(650, "KES", RATES, "KES 650 million")).toEqual({ usd_millions: null, fx_rate: null, fx_date: null });
  });

  test("a priced currency uses the day's rate, not the stated figure", () => {
    expect(convertToUsd(500, "PLN", RATES, "PLN 500 million ($130 million)").usd_millions).toBeCloseTo(128.205, 3);
  });

  test("stated dollar figures read their unit", () => {
    expect(statedUsdMillions("€3m (US$3.5m)")).toBe(3.5);
    expect(statedUsdMillions("₦2.5 billion (about $1.7 million)")).toBe(1.7);
    expect(statedUsdMillions("KSh 130 million (USD 1,000,000)")).toBe(1);
    expect(statedUsdMillions("₦1.4 billion")).toBeNull();
  });
});
