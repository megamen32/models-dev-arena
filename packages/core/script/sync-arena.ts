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
 * A side artifact `models-arena.json` is also written: a flat lookup of
 * every Arena entry keyed by `id` (model.dev style), with the same
 * normalized data — handy for clients that want the leaderboard without
 * walking the full models.json.
 *
 * Run from the repo root: `bun packages/core/script/sync-arena.ts`.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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

    // Flat lookup artifact: one entry per (model, leaderboard) pair.
    const flat: Record<string, ArenaAttach> = {};
    for (const cat of CATEGORIES_TO_FETCH) {
      const lb = arena[cat];
      if (!lb) continue;
      const scores = lb.models.map((mm) => mm.score);
      const minElo = Math.min(...scores);
      const maxElo = Math.max(...scores);
      for (const m of lb.models) {
        const e = buildEntry(cat, m, minElo, maxElo, lb.meta);
        flat[m.model.toLowerCase()] = e.attach;
      }
    }
    const now = new Date().toISOString();
    const arenaMeta = { arena: flat, generatedAt: now };
    writeFileSync(outPath, JSON.stringify(arenaMeta, null, 2));
    console.log(`[models-arena.json] wrote ${Object.keys(flat).length} entries → ${outPath}`);

    // _meta.json — tiny status file for GitHub Pages consumers / status badges.
    const meta = {
      generatedAt: now,
      arena: {
        text: arena.text?.meta ?? null,
        code: arena.code?.meta ?? null,
      },
      counts: {
        modelsDevEntries: models.length,
        arenaEntries: Object.keys(flat).length,
        matched: 0, // filled in below
      },
      sources: {
        modelsDev: "https://models.dev",
        arena: "https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard",
        fork: "https://github.com/megamen32/models-dev-arena",
        pages: "https://megamen32.github.io/models-dev-arena/",
      },
    };
    const metaPath = resolve(root, "_meta.json");

    // Attach `arena` field to each models.dev entry.
    let matched = 0;
    for (const m of models) {
      const match = findMatch(m.id, arenaByName);
      if (match) {
        m.arena = match.attach;
        matched++;
      }
    }
    meta.counts.matched = matched;
    console.log(`[models.json] attached arena to ${matched}/${models.length} entries`);

    writeFileSync(modelsPath, JSON.stringify(data, null, 2));
    console.log(`[models.json] updated in place → ${modelsPath}`);

    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    console.log(`[_meta.json] wrote → ${metaPath}`);
  })();
}

main().catch((err) => {
  console.error("[sync-arena] failed:", err);
  process.exit(1);
});


