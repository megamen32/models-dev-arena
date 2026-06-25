#!/usr/bin/env bun
/**
 * sync-currency.ts — Refresh currency.json with current CBR rates.
 *
 * Pulls USD/RUB (and other currencies if added later) from the Bank of
 * Russia daily rate feed and writes a small `currency.json` file at the
 * repo root. The file is intended to be served via GitHub Pages so clients
 * can see the current rate without a separate HTTP call.
 *
 * File shape:
 *   {
 *     "version": 1,
 *     "rates": {
 *       "USD": { "RUB": 74.7738, ... },
 *       "RUB": { "USD": 0.01337, ... }
 *     },
 *     "fetchedAt": "2026-06-25T11:30:00Z",
 *     "source": "CBR XML (cbr-xml-daily.ru/daily_eng.xml)",
 *     "inverse_rates": { "RUB_per_USD": 74.7738 }
 *   }
 *
 * Run from the repo root: `bun packages/core/script/sync-currency.ts`.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getUsdRubRate } from "../src/currency";

interface CurrencyFile {
  version: 1;
  rates: {
    USD: Record<string, number>;
    RUB: Record<string, number>;
  };
  fetchedAt: string;
  source: string;
  inverse_rates: {
    RUB_per_USD: number;
  };
}

async function main() {
  const root = resolve(import.meta.dir, "../../..");
  const outPath = resolve(root, "currency.json");

  const rate = await getUsdRubRate();
  const rubPerUsd = rate.rate;
  const usdPerRub = 1 / rubPerUsd;

  const file: CurrencyFile = {
    version: 1,
    rates: {
      USD: { RUB: round(rubPerUsd, 6) },
      RUB: { USD: round(usdPerRub, 8) },
    },
    fetchedAt: rate.fetchedAt,
    source: rate.source,
    inverse_rates: {
      RUB_per_USD: round(rubPerUsd, 6),
    },
  };

  writeFileSync(outPath, JSON.stringify(file, null, 2));
  console.log(
    `[currency] wrote ${outPath} — 1 USD = ${rubPerUsd} RUB (source: ${rate.source})`
  );
}

function round(n: number, places: number): number {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

main().catch((err) => {
  console.error("[sync-currency] failed:", err);
  process.exit(1);
});
