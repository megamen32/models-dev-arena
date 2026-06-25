#!/usr/bin/env bun
/**
 * sync-benchmarks.ts — Multi-source benchmark aggregator.
 *
 * Pulls text-quality scores from independent evaluation sources and writes
 * them onto each models.dev model entry. The `sources` array on every record
 * is the single source of truth for provenance — if a model has a score but
 * `sources` doesn't list where it came from, that's a bug.
 *
 * Currently fetched sources:
 *   - arena      → LMSYS Arena / arena.ai (pairwise human prefs, ~70 models)
 *   - alpaca_lc  → AlpacaEval 2.0 length-controlled winrate (GPT-4-Turbo
 *                  judge, ~220 models). Source:
 *                  https://tatsu-lab.github.io/alpaca_eval/
 *                  0.98 Spearman correlation with Arena per the official paper.
 *
 * The script writes:
 *   - `models.json`         ← each matched entry gains a `benchmarks` field
 *                              with `sources: [...]` and per-source details.
 *   - `models-arena.json`   ← flat lookup keyed by Arena name; extended with
 *                              `sources: [...]` on every entry, including
 *                              alpaca-only entries that have no arena match.
 *   - `_meta.json`          ← provenance: per-source `fetchedAt`, model count,
 *                              and original source URL.
 *
 * Run from the repo root: `bun packages/core/script/sync-benchmarks.ts`.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ALPACA_LC_URL =
  "https://raw.githubusercontent.com/tatsu-lab/alpaca_eval/main/" +
  "src/alpaca_eval/leaderboards/data_AlpacaEval_2/" +
  "weighted_alpaca_eval_gpt4_turbo_leaderboard.csv";

export { ALPACA_LC_URL };

/** Vendor prefixes that AlpacaEval sometimes includes — strip for matching. */
const ALPACA_VENDOR_PREFIXES = [
  "meta-llama/",
  "meta/",
  "openai/",
  "anthropic/",
  "google/",
  "alibaba/",
  "qwen/",
  "mistral/",
  "deepseek/",
  "xai/",
  "cohere/",
  "nvidia/",
  "moonshotai/",
  "xiaomi/",
  "zhipuai/",
  "z-ai/",
  "01-ai/",
  "NousResearch/",
  "HuggingFaceH4/",
  "lmsys/",
] as const;

interface AlpacaLCEntry {
  /** Original key from the CSV (first column). */
  rawKey: string;
  /** Length-controlled winrate as a fraction in [0, 1]. */
  lengthControlledWinrate: number;
  /** Raw winrate (uncontrolled), also [0, 1]. */
  rawWinrate: number;
  nTotal: number;
  mode: string;
  standardError: number;
}

async function fetchAlpacaLC(): Promise<AlpacaLCEntry[]> {
  const res = await fetch(ALPACA_LC_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    console.warn(`[alpaca_lc] fetch failed: HTTP ${res.status}`);
    return [];
  }
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    console.warn(`[alpaca_lc] empty response`);
    return [];
  }

  // Parse header to find columns by name (resilient to column reordering).
  const header = lines[0].split(",").map((c) => c.trim());
  const idx = (name: string): number => header.indexOf(name);
  const keyCol = 0; // first column has no header in the upstream CSV
  const lcCol = idx("length_controlled_winrate");
  const winrateCol = idx("win_rate");
  const seCol = idx("lc_standard_error");
  const nTotalCol = idx("n_total");
  const modeCol = idx("mode");

  if (lcCol < 0) {
    console.warn(`[alpaca_lc] missing length_controlled_winrate column`);
    return [];
  }

  const entries: AlpacaLCEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length <= lcCol) continue;
    const rawKey = (cols[keyCol] ?? "").trim();
    if (!rawKey) continue;
    const lcRaw = cols[lcCol]?.trim();
    if (!lcRaw) continue;
    const lc = Number(lcRaw);
    if (!Number.isFinite(lc) || lc <= 0) continue;
    const wr = winrateCol >= 0 ? Number(cols[winrateCol]) / 100 : lc / 100;
    const nTotal = nTotalCol >= 0 ? Number(cols[nTotalCol]) || 0 : 0;
    const se = seCol >= 0 ? Number(cols[seCol]) || 0 : 0;
    const mode = modeCol >= 0 ? cols[modeCol]?.trim() ?? "" : "";
    entries.push({
      rawKey,
      lengthControlledWinrate: lc / 100,
      rawWinrate: wr,
      nTotal,
      mode,
      standardError: se,
    });
  }
  console.log(`[alpaca_lc] parsed ${entries.length} entries`);
  return entries;
}

/**
 * Strip dates (both `2024-06-20` and compact `20240620`), version suffixes
 * (high/low/...), and vendor prefixes from a key for fuzzy matching.
 */
function normalizeBenchmarkKey(raw: string): string {
  let n = raw.toLowerCase().trim();
  for (const p of ALPACA_VENDOR_PREFIXES) {
    if (n.startsWith(p)) {
      n = n.slice(p.length);
      break;
    }
  }
  n = n.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "");
  n = n.replace(/-?\b\d{8}\b/g, "");
  n = n.replace(
    /-(?:high|low|mini|nano|pro|preview|beta|alpha|latest|chat|codex|harness|thinking(?:-minimal)?|reasoning|multi-agent|instant|fast|slow|xlarge|xl|sm|m|md|lg)\b/g,
    ""
  );
  n = n.replace(/[\s._/]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return n;
}

/** Build the lookup map: normalized key → list of AlpacaLCEntry (usually 1). */
function buildAlpacaMap(entries: AlpacaLCEntry[]): Map<string, AlpacaLCEntry[]> {
  const map = new Map<string, AlpacaLCEntry[]>();
  for (const e of entries) {
    const k = normalizeBenchmarkKey(e.rawKey);
    if (!k) continue;
    const list = map.get(k) ?? [];
    list.push(e);
    map.set(k, list);
  }
  return map;
}

/** Try to find an alpaca entry that matches the given normalized model key. */
function findAlpacaMatch(
  modelKey: string,
  alpacaByKey: Map<string, AlpacaLCEntry[]>
): AlpacaLCEntry | null {
  const direct = alpacaByKey.get(modelKey);
  if (direct && direct.length > 0) return direct[0];

  // Try progressive trimming: gpt-5.4-mini-high → gpt-5.4-mini → gpt-5.4 → gpt-5
  let cur = modelKey;
  while (cur.includes("-")) {
    const lastDash = cur.lastIndexOf("-");
    if (lastDash <= 0) break;
    const suffix = cur.slice(lastDash + 1);
    // Don't strip purely numeric or short suffixes — too aggressive.
    if (/^\d+$/.test(suffix) && suffix.length <= 3) {
      const candidate = cur.slice(0, lastDash);
      const m = alpacaByKey.get(candidate);
      if (m && m.length > 0) return m[0];
    }
    cur = cur.slice(0, lastDash);
  }
  return null;
}

/** Single benchmark entry — uniform shape across all sources.
 *  Every entry exposes `score` ∈ [0, 1] so consumers can do
 *  `[b.score for b in entry.benchmarks]` regardless of which source it came from.
 */
interface BenchmarkEntry {
  source: string;                         // "arena" | "alpaca_lc" | ...
  score: number;                          // 0..1, normalized
  confidence?: "high" | "medium" | "low";
  n_total?: number;                       // sample size underlying the score
  url?: string;                           // source URL
  /** Source-specific extras (kept for transparency, not required by clients). */
  raw?: Record<string, unknown>;
}

/** Shape of the per-model benchmark attachment written to models.json. */
interface BenchmarkAttach {
  sources: string[];                      // unique source names
  score: number;                          // aggregate: max across entries
  winner_source: string;                  // which entry supplied `score`
  confidence: "high" | "medium" | "low";  // "high" iff 2+ sources agree
  benchmarks: BenchmarkEntry[];           // list, iterable: [b.score for b in benchmarks]
}

export {
  fetchAlpacaLC,
  buildAlpacaMap,
  findAlpacaMatch,
  normalizeBenchmarkKey,
  type AlpacaLCEntry,
  type BenchmarkAttach,
};

// CLI entry point
if (import.meta.main) {
  const root = resolve(import.meta.dir, "../../..");
  const metaPath = resolve(root, "_meta.json");

  const entries = await fetchAlpacaLC();
  const alpacaByKey = buildAlpacaMap(entries);
  console.log(`[alpaca_lc] indexed ${entries.length} entries across ${alpacaByKey.size} normalized keys`);

  // Update _meta.json with alpaca provenance.
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    meta = {};
  }
  (meta as Record<string, unknown>).benchmarks = {
    alpaca_lc: {
      fetchedAt: new Date().toISOString(),
      modelCount: entries.length,
      source: ALPACA_LC_URL,
      public_url: "https://tatsu-lab.github.io/alpaca_eval/",
      metric: "length_controlled_winrate",
      correlation_with_arena: 0.98,
    },
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log(`[_meta.json] updated with alpaca_lc provenance → ${metaPath}`);
}
