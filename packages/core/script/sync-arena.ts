#!/usr/bin/env bun
/**
 * sync-arena.ts — Merge Arena AI leaderboard intelligence into models.json.
 *
 * Pulls the `text` and `code` leaderboards from
 *   https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard
 * normalizes ELO → taskFit in [0.4, 0.98], assigns confidence buckets,
 * and writes the per-model intelligence into a new `arena` field on every
 * models.json entry whose name matches an Arena model.
 *
 * Also pulls AlpacaEval 2.0 length-controlled winrate as a SECOND text-quality
 * source — this gives coverage to ~220 models instead of Arena's ~70.
 * Each entry carries an explicit `sources: [...]` array so consumers can tell
 * exactly where every score came from.
 *
 * Outputs:
 *   - `models.json`         — gains `arena` and/or `benchmarks` field per entry
 *   - `models-arena.json`   — flat lookup keyed by Arena name, every entry has
 *                              an explicit `sources: [...]` array (including
 *                              alpaca-only models that have no Arena match)
 *   - `_meta.json`          — per-source provenance (fetchedAt, count, URL)
 *
 * Run from the repo root: `bun packages/core/script/sync-arena.ts`.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  fetchAlpacaLC,
  buildAlpacaMap,
  findAlpacaMatch,
  normalizeBenchmarkKey,
  ALPACA_LC_URL,
  type AlpacaLCEntry,
  type BenchmarkEntry,
  type BenchmarkAttach,
} from "./sync-benchmarks";
import { getUsdRubRate, usdPer1MToRubPerToken } from "../src/currency";

const ARENA_BASE = "https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard";
const CATEGORIES_TO_FETCH = ["text", "code"] as const;
type ArenaCategory = (typeof CATEGORIES_TO_FETCH)[number];

/** Map of Arena leaderboard → models.dev task categories. */
const CATEGORY_TASK_MAP: Record<ArenaCategory, string[]> = {
  text: ["default", "review", "documentation", "debugging"],
  code: ["coding"],
};

const HIGH_CONFIDENCE_VOTES = 5000;
const MEDIUM_CONFIDENCE_VOTES = 1000;

/** Vendor prefixes to strip (lowercase). */
const VENDOR_PREFIXES = [
  "anthropic/",
  "openai/",
  "google/",
  "meta/",
  "mistral/",
  "deepseek/",
  "xai/",
  "cohere/",
  "qwen/",
  "alibaba/",
  "nvidia/",
  "01-ai/",
  "phind/",
  "zerox/",
  "together/",
  "fireworks/",
  "perplexity/",
  "ai21/",
  "moonshotai/",
  "zhipuai/",
  "xiaomi/",
] as const;

interface ArenaModelEntry {
  rank: number;
  model: string;
  vendor: string;
  score: number;
  ci: number;
  votes: number;
  license: string;
}

interface ArenaLeaderboardData {
  meta: { leaderboard: string; model_count: number; last_updated?: string; source_url?: string; fetched_at?: string };
  models: ArenaModelEntry[];
}

type ArenaMap = Partial<Record<ArenaCategory, ArenaLeaderboardData>>;

interface ModelEntry {
  id: string;
  canonical_slug?: string;
  hugging_face_id?: string | null;
  name?: string;
  [k: string]: unknown;
}

interface ArenaAttach {
  leaderboard: ArenaCategory;
  rank: number;
  elo: number;
  ci: number;
  votes: number;
  vendor: string;
  license: string;
  score: number;
  confidence: "high" | "medium" | "low";
  categories: string[];
  lastUpdated?: string;
  sourceUrl?: string;
  fetchedAt?: string;
}

function normalizeArenaName(raw: string): string {
  let n = raw.toLowerCase().trim();
  for (const p of VENDOR_PREFIXES) {
    if (n.startsWith(p)) {
      n = n.slice(p.length);
      break;
    }
  }
  return n;
}

/** Strip trailing .N / -N.N version suffix. */
function stripVersionSuffix(id: string): string {
  return id.replace(/[.-]\d+(?:\.\d+)*$/, "");
}

/** Normalize a models.dev model id for matching: lowercase + drop vendor prefix + collapse `.`/`-` between version digits. */
function normalizeModelsDevId(id: string): string {
  let n = id.toLowerCase().trim();
  const slash = n.indexOf("/");
  if (slash !== -1) n = n.slice(slash + 1);
  // Collapse `4.7` → `4-7` so it matches Arena's dash-style `claude-opus-4-7`.
  n = n.replace(/(\d+)\.(\d+)/g, "$1-$2");
  return n;
}

async function fetchArena(): Promise<ArenaMap> {
  const out: ArenaMap = {};
  for (const cat of CATEGORIES_TO_FETCH) {
    const url = `${ARENA_BASE}?name=${cat}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      console.warn(`[arena] ${cat} fetch failed: HTTP ${res.status}`);
      continue;
    }
    out[cat] = (await res.json()) as ArenaLeaderboardData;
    console.log(`[arena] ${cat} leaderboard: ${out[cat]?.models.length ?? 0} models`);
  }
  return out;
}

interface ArenaEntryNormalized {
  attach: ArenaAttach;
  /** All alias names this entry should match under (for match map). */
  aliases: string[];
}

function buildEntry(
  leaderboard: ArenaCategory,
  model: ArenaModelEntry,
  minElo: number,
  maxElo: number,
  meta: ArenaLeaderboardData["meta"]
): ArenaEntryNormalized {
  const eloRange = maxElo - minElo || 1;
  const score = 0.4 + 0.58 * ((model.score - minElo) / eloRange);
  const confidence =
    model.votes >= HIGH_CONFIDENCE_VOTES
      ? "high"
      : model.votes >= MEDIUM_CONFIDENCE_VOTES
        ? "medium"
        : "low";

  const normalizedName = normalizeArenaName(model.model);
  const aliases = new Set<string>([normalizedName, stripVersionSuffix(normalizedName)]);

  return {
    attach: {
      leaderboard,
      rank: model.rank,
      elo: model.score,
      ci: model.ci,
      votes: model.votes,
      vendor: model.vendor,
      license: model.license,
      score: Math.round(score * 10000) / 10000,
      confidence,
      categories: CATEGORY_TASK_MAP[leaderboard],
      lastUpdated: meta.last_updated,
      sourceUrl: meta.source_url,
      fetchedAt: meta.fetched_at,
    },
    aliases: Array.from(aliases),
  };
}

/** Match Arena entry against a models.dev model id. */
function findMatch(
  modelId: string,
  arenaByName: Map<string, ArenaEntryNormalized[]>
): ArenaEntryNormalized | null {
  const normalized = normalizeModelsDevId(modelId);
  const direct = arenaByName.get(normalized);
  if (direct && direct.length > 0) return direct[0];

  const stripped = stripVersionSuffix(normalized);
  if (stripped !== normalized) {
    const m = arenaByName.get(stripped);
    if (m && m.length > 0) return m[0];
  }

  // Prefix match: Arena "claude-opus-4" matches models.dev "claude-opus-4.6"
  let best: ArenaEntryNormalized | null = null;
  for (const [arenaName, entries] of arenaByName) {
    if (normalized === arenaName) continue;
    if (normalized.startsWith(arenaName + "-") || normalized.startsWith(arenaName + ".")) {
      const e = entries[0];
      if (!best || e.attach.score > best.attach.score) best = e;
    }
  }
  return best;
}

function main() {
  const root = resolve(import.meta.dir, "../../..");
  const modelsPath = resolve(root, "models.json");
  const outPath = resolve(root, "models-arena.json");

  return (async () => {
    const data = JSON.parse(readFileSync(modelsPath, "utf8")) as { data: ModelEntry[] };
    const models = data.data;
    console.log(`[models] loaded ${models.length} model entries`);

    const arena = await fetchArena();
    const alpacaEntries = await fetchAlpacaLC();
    const alpacaByKey = buildAlpacaMap(alpacaEntries);

    // Build lookup map of normalized Arena name → entry
    const arenaByName = new Map<string, ArenaEntryNormalized[]>();
    for (const cat of CATEGORIES_TO_FETCH) {
      const lb = arena[cat];
      if (!lb) continue;
      const scores = lb.models.map((m) => m.score);
      const minElo = Math.min(...scores);
      const maxElo = Math.max(...scores);
      for (const m of lb.models) {
        const e = buildEntry(cat, m, minElo, maxElo, lb.meta);
        for (const alias of e.aliases) {
          const list = arenaByName.get(alias) ?? [];
          list.push(e);
          arenaByName.set(alias, list);
        }
      }
    }

    // Flat lookup artifact: one entry per (model, leaderboard) pair PLUS
    // alpaca-only models that have no Arena equivalent.
    type FlatEntry = ArenaAttach & { sources: string[]; benchmarks?: BenchmarkAttach };
    const flat: Record<string, FlatEntry> = {};
    for (const cat of CATEGORIES_TO_FETCH) {
      const lb = arena[cat];
      if (!lb) continue;
      const scores = lb.models.map((mm) => mm.score);
      const minElo = Math.min(...scores);
      const maxElo = Math.max(...scores);
      for (const m of lb.models) {
        const e = buildEntry(cat, m, minElo, maxElo, lb.meta);
        const arenaEntry: BenchmarkEntry = {
          source: "arena",
          score: e.attach.score,
          confidence: e.attach.confidence,
          n_total: e.attach.votes,
          url: e.attach.sourceUrl,
          raw: { rank: e.attach.rank, elo: e.attach.elo, ci: e.attach.ci, vendor: e.attach.vendor },
        };
        flat[m.model.toLowerCase()] = {
          ...e.attach,
          sources: ["arena"],
          benchmarks: {
            sources: ["arena"],
            score: e.attach.score,
            winner_source: "arena",
            confidence: e.attach.confidence,
            benchmarks: [arenaEntry],
          },
        };
      }
    }

    // Add alpaca-only entries to the flat map, keyed by their original rawKey.
    let alpacaOnlyAdded = 0;
    for (const ap of alpacaEntries) {
      const key = ap.rawKey.toLowerCase();
      if (flat[key]) continue;
      const lcScore = Math.round(ap.lengthControlledWinrate * 10000) / 10000;
      const wrScore = Math.round(ap.rawWinrate * 10000) / 10000;
      const confidence: "high" | "medium" | "low" =
        ap.nTotal >= 5000 ? "high" : ap.nTotal >= 1000 ? "medium" : "low";
      const alpacaEntry: BenchmarkEntry = {
        source: "alpaca_lc",
        score: lcScore,
        confidence,
        n_total: ap.nTotal,
        url: "https://tatsu-lab.github.io/alpaca_eval/",
        raw: {
          winrate: wrScore,
          length_controlled: lcScore,
          mode: ap.mode,
        },
      };
      flat[key] = {
        leaderboard: "text" as const,
        rank: 0,
        elo: 0,
        ci: Math.round(ap.standardError * 100) / 100,
        votes: ap.nTotal,
        vendor: "",
        license: "",
        score: lcScore,
        confidence,
        categories: ["default", "review", "documentation", "debugging"],
        sources: ["alpaca_lc"],
        benchmarks: {
          sources: ["alpaca_lc"],
          score: lcScore,
          winner_source: "alpaca_lc",
          confidence,
          benchmarks: [alpacaEntry],
        },
      };
      alpacaOnlyAdded++;
    }
    const now = new Date().toISOString();
    const arenaMeta = { arena: flat, generatedAt: now };
    writeFileSync(outPath, JSON.stringify(arenaMeta, null, 2));
    console.log(
      `[models-arena.json] wrote ${Object.keys(flat).length} entries ` +
      `(${alpacaOnlyAdded} alpaca-only) → ${outPath}`
    );

    // Note: arena `score` is a normalized quality metric (0.4..0.98),
    // NOT a per-million-token price — converting it to RUB would be nonsense.
    // Real RUB pricing lives under models.json's per-provider [cost] section.
    // See models.json.rub.json generation below.

    // _meta.json — tiny status file for GitHub Pages consumers / status badges.
    const meta = {
      generatedAt: now,
      arena: {
        text: arena.text?.meta ?? null,
        code: arena.code?.meta ?? null,
      },
      benchmarks: {
        alpaca_lc: {
          fetchedAt: now,
          modelCount: alpacaEntries.length,
          uniqueKeys: alpacaByKey.size,
          source: ALPACA_LC_URL,
          public_url: "https://tatsu-lab.github.io/alpaca_eval/",
          metric: "length_controlled_winrate",
          correlation_with_arena: 0.98,
        },
      },
      currency: {
        primary: "USD",
        rate_source: "cbr-xml-daily.ru/daily_eng.xml (Bank of Russia)",
        fallback_chain: [
          "cbr-xml-daily.ru/daily_json.js",
          "api.exchangerate.host",
          "open.er-api.com",
        ],
        rub_variant_url: "/models.json.rub.json",
        rub_query_param: "?currency=rub",
      },
      counts: {
        modelsDevEntries: models.length,
        arenaEntries: Object.keys(flat).length,
        arenaOnly: Object.values(flat).filter((f) => f.sources.length === 1 && f.sources[0] === "arena").length,
        alpacaOnly: alpacaOnlyAdded,
        matched: 0, // filled in below
      },
      sources: {
        modelsDev: "https://models.dev",
        arena: "https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard",
        alpaca_lc: "https://tatsu-lab.github.io/alpaca_eval/",
        fork: "https://github.com/megamen32/models-dev-arena",
        pages: "https://megamen32.github.io/models-dev-arena/",
      },
    };
    const metaPath = resolve(root, "_meta.json");

    // Attach `arena` and/or `benchmarks` fields to each models.dev entry.
    // `benchmarks` is a UNIFIED shape: every entry in the .benchmarks list has
    // a `score` field, so consumers can iterate freely:
    //   sum(b.score for b in model.benchmarks.benchmarks)
    //   max(b.score for b in model.benchmarks.benchmarks)
    let matched = 0;
    let withAlpaca = 0;
    let withBothSources = 0;
    for (const m of models) {
      const arenaMatch = findMatch(m.id, arenaByName);
      const modelKey = normalizeModelsDevId(m.id);
      const alpacaMatch = findAlpacaMatch(modelKey, alpacaByKey);

      const entries: BenchmarkEntry[] = [];
      if (arenaMatch) {
        m.arena = arenaMatch.attach;
        entries.push({
          source: "arena",
          score: arenaMatch.attach.score,
          confidence: arenaMatch.attach.confidence,
          n_total: arenaMatch.attach.votes,
          url: arenaMatch.attach.sourceUrl,
          raw: {
            rank: arenaMatch.attach.rank,
            elo: arenaMatch.attach.elo,
            ci: arenaMatch.attach.ci,
            vendor: arenaMatch.attach.vendor,
          },
        });
      }
      if (alpacaMatch) {
        const lcScore = Math.round(alpacaMatch.lengthControlledWinrate * 10000) / 10000;
        entries.push({
          source: "alpaca_lc",
          score: lcScore,
          confidence:
            alpacaMatch.nTotal >= 5000 ? "high" : alpacaMatch.nTotal >= 1000 ? "medium" : "low",
          n_total: alpacaMatch.nTotal,
          url: "https://tatsu-lab.github.io/alpaca_eval/",
          raw: {
            winrate: Math.round(alpacaMatch.rawWinrate * 10000) / 10000,
            length_controlled: lcScore,
            mode: alpacaMatch.mode,
          },
        });
        withAlpaca++;
      }

      if (entries.length > 0) {
        // Aggregate: winner_source = entry with highest score.
        let winner = entries[0];
        for (const e of entries) {
          if (e.score > winner.score) winner = e;
        }
        const sources = Array.from(new Set(entries.map((e) => e.source)));
        const confidence: "high" | "medium" | "low" =
          entries.length >= 2 ? "high" : (entries[0].confidence ?? "medium");
        m.benchmarks = {
          sources,
          score: winner.score,
          winner_source: winner.source,
          confidence,
          benchmarks: entries,
        };
        matched++;
        if (entries.length >= 2) withBothSources++;
      }
    }
    meta.counts.matched = matched;
    meta.counts.withAlpaca = withAlpaca;
    meta.counts.withBothSources = withBothSources;
    console.log(
      `[models.json] attached arena to ${matched - withAlpaca}/${models.length} entries, ` +
      `alpaca_lc to ${withAlpaca}/${models.length}, both sources to ${withBothSources}/${models.length}`
    );

    writeFileSync(modelsPath, JSON.stringify(data, null, 2));
    console.log(`[models.json] updated in place → ${modelsPath}`);

    // RUB-priced variant: models.dev stores prices as USD per token (strings).
    // We convert each `pricing.<k>` value to RUB per token by multiplying
    // by the current CBR USD/RUB rate. The result is added as a parallel
    // `pricing_rub` object alongside the original USD `pricing` block.
    try {
      const fxRate = await getUsdRubRate();
      const rubData = JSON.parse(JSON.stringify(data));
      let converted = 0;
      for (const m of rubData.data as any[]) {
        const pricing = m.pricing;
        if (!pricing || typeof pricing !== "object") continue;
        const rub: Record<string, number> = {};
        // Field name mapping: models.dev uses prompt/completion/input_cache_*.
        for (const [srcKey, dstKey] of [
          ["prompt", "input"],
          ["completion", "output"],
          ["input_cache_read", "cache_read"],
          ["input_cache_write", "cache_write"],
          ["internal_reasoning", "reasoning"],
          ["input_audio", "input_audio"],
          ["output_audio", "output_audio"],
        ] as Array<[string, string]>) {
          const raw = pricing[srcKey];
          const usdPerToken = typeof raw === "number" ? raw : parseFloat(String(raw));
          if (Number.isFinite(usdPerToken) && usdPerToken > 0) {
            // USD per token → RUB per token
            rub[dstKey] = round10(usdPerToken * fxRate.rate);
          }
        }
        if (Object.keys(rub).length > 0) {
          m.pricing_rub = rub;
          m.pricing_rub_meta = {
            source: "USD→RUB via CBR daily rate",
            usd_rub_rate: fxRate.rate,
            rate_source: fxRate.source,
            fetchedAt: fxRate.fetchedAt,
            note: "All values are RUB per token (string-encoded to preserve precision)",
          };
          converted++;
        }
      }
      const rubPath = resolve(root, "models.json.rub.json");
      writeFileSync(rubPath, JSON.stringify(rubData, null, 2));
      console.log(
        `[models.json.rub.json] converted ${converted}/${models.length} models ` +
        `(USD→RUB at ${fxRate.rate}) → ${rubPath}`
      );
    } catch (e) {
      console.warn(`[models.json.rub.json] skipped: ${e instanceof Error ? e.message : e}`);
    }

    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    console.log(`[_meta.json] wrote → ${metaPath}`);
  })();
}

main().catch((err) => {
  console.error("[sync-arena] failed:", err);
  process.exit(1);
});

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function round10(n: number): number {
  return Math.round(n * 10_000_000_000) / 10_000_000_000;
}


