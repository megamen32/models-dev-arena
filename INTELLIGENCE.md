# Arena Intelligence

This fork augments the [models.dev](https://models.dev) dataset with
**multi-source text-quality intelligence scores** for LLM models.
Each score is accompanied by an explicit `sources` array so consumers
can tell exactly where every data point came from.

Currently two independent sources are merged:

| Source       | What it measures                              | Coverage | Fetched from |
| ------------ | --------------------------------------------- | -------- | ------------ |
| `arena`      | LMSYS Arena ELO (pairwise human preferences)  | ~70 models | [api.wulong.dev](https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard) |
| `alpaca_lc`  | AlpacaEval 2.0 length-controlled winrate (GPT-4-Turbo judge) | ~220 models | [AlpacaEval leaderboard](https://tatsu-lab.github.io/alpaca_eval/) |

Why both? Arena's pairwise votes are the gold standard but limited to
the top-50 of each leaderboard — many real models (older generations,
niche open-source, local-only) never accumulate enough votes to enter.
AlpacaEval's LC winrate correlates 0.98 with Arena per the official
paper and covers ~3× as many models. Merging gives us coverage of
**~290 models** while keeping provenance crystal clear.

## What gets added

### `models.json` — per-provider entry

Every matched `models.dev` entry gains a `benchmarks` field whose
`sources` array lists every source that supplied a score:

```jsonc
{
  "id": "google/gemini-3-flash-preview",
  // ... existing models.dev fields ...
  "arena": {                              // legacy single-source attachment
    "leaderboard": "text",
    "elo": 1473,
    "score": 0.6417,
    "confidence": "high",
    "categories": ["default", "review", "documentation", "debugging"],
    "lastUpdated": "Jun 16, 2026",
    "sourceUrl": "https://arena.ai/leaderboard/text",
    "fetchedAt": "2026-06-25T07:48:22Z"
  },
  "benchmarks": {                         // multi-source attachment
    "sources": ["arena", "alpaca_lc"],    // ← EXPLICIT provenance
    "alpaca_lc": {
      "winrate": 0.42,
      "length_controlled": 0.50,
      "n_total": 805,
      "mode": "minimal",
      "source": "https://tatsu-lab.github.io/alpaca_eval/"
    }
  }
}
```

If a model is in only one source, `sources` will list that one source.
If it's in neither, neither field is attached — we never invent scores.

### `models-arena.json` — flat lookup keyed by leaderboard name

```jsonc
{
  "arena": {
    "claude-opus-4-5-20251101": {
      "leaderboard": "code",
      "elo": 1490,
      "score": 0.4658,
      "sources": ["arena"],               // ← explicit provenance
      "confidence": "high",
      // ...
    },
    "NullModel": {
      "leaderboard": "text",
      "score": 0.8646,                    // length_controlled winrate
      "sources": ["alpaca_lc"],           // ← not in Arena, has alpaca
      "benchmarks": {
        "alpaca_lc": {
          "winrate": 0.7692,
          "length_controlled": 0.8646,
          "n_total": 805,
          "mode": "community",
          "source": "https://tatsu-lab.github.io/alpaca_eval/"
        }
      }
    }
  },
  "generatedAt": "2026-06-25T07:48:22Z"
}
```

### `_meta.json` — per-source provenance

```jsonc
{
  "generatedAt": "2026-06-25T07:48:22Z",
  "arena": {
    "text": { "leaderboard": "text", "model_count": 50, "last_updated": "Jun 16, 2026" },
    "code": { "leaderboard": "code", "model_count": 50, "last_updated": null }
  },
  "benchmarks": {
    "alpaca_lc": {
      "fetchedAt": "2026-06-25T07:48:22Z",
      "modelCount": 223,
      "uniqueKeys": 219,
      "source": "https://raw.githubusercontent.com/tatsu-lab/alpaca_eval/main/src/alpaca_eval/leaderboards/data_AlpacaEval_2/weighted_alpaca_eval_gpt4_turbo_leaderboard.csv",
      "public_url": "https://tatsu-lab.github.io/alpaca_eval/",
      "metric": "length_controlled_winrate",
      "correlation_with_arena": 0.98
    }
  },
  "counts": {
    "modelsDevEntries": 364,
    "arenaEntries": 293,
    "arenaOnly": 70,
    "alpacaOnly": 223,
    "matched": 136,
    "withAlpaca": 24
  },
  "sources": {
    "modelsDev": "https://models.dev",
    "arena": "https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard",
    "alpaca_lc": "https://tatsu-lab.github.io/alpaca_eval/",
    "fork": "https://github.com/megamen32/models-dev-arena",
    "pages": "https://megamen32.github.io/models-dev-arena/"
  }
}
```

The `benchmarks` section in `_meta.json` is the canonical record of
where each non-arena source was fetched from and when.

## Public feed (GitHub Pages)

A static copy of the merge is published by GitHub Pages at:

```
https://megamen32.github.io/models-dev-arena/
```

Endpoints (all served as `application/json` from the `dev` branch):

| File                     | What's in it                                                            |
| ------------------------ | ----------------------------------------------------------------------- |
| `/`                      | Status page (last sync time, counts, source links)                     |
| `/_meta.json`            | Last-refresh timestamp, per-source `fetchedAt`, counts, source URLs    |
| `/models-arena.json`     | Flat lookup keyed by leaderboard name; every entry has `sources: [...]` |
| `/models.json`           | Full models.dev catalog with `arena` and/or `benchmarks` field          |
| `/INTELLIGENCE.md`       | This document                                                           |

The index page fetches `/_meta.json` and renders a live "last refresh"
card. The page is regenerated on every push to `dev`; `arena:sync` is
also scheduled to run daily at 06:00 UTC (see
`.github/workflows/arena-sync.yml`).

## How `score` is calculated

### Arena

The raw Arena score is an ELO rating from pairwise human preference
votes. Two leaderboards are consumed:

| Arena leaderboard | models.dev task categories            |
| ----------------- | ------------------------------------- |
| `text`            | `default`, `review`, `documentation`, `debugging` |
| `code`            | `coding`                              |

For each leaderboard, ELO is min/max-normalized into a `taskFit` in
the range **`[0.4, 0.98]`**:

```ts
taskFit = 0.4 + 0.58 * ((elo - minElo) / (maxElo - minElo || 1))
```

The endpoints are deliberately *not* `0` and `1` — that headroom lets
a consumer layer its own overrides (`user_override` in the OmniRoute
`model_intelligence` table, for instance) on top of the Arena score
without re-mapping.

### AlpacaEval 2.0 LC

The raw `length_controlled_winrate` from the AlpacaEval CSV is a
percentage (0..100). We normalize to `[0, 1]` and round to 4 decimal
places. The `n_total` field in each entry is the number of
head-to-head comparisons underpinning the winrate (used for
confidence bucketing below).

### Confidence buckets (shared)

Confidence is a function of how many underlying comparisons underpin
the score:

| n_total / votes | confidence |
| --------------- | ---------- |
| `>= 5000`       | `high`     |
| `>= 1000`       | `medium`   |
| `< 1000`        | `low`      |

## Name matching

Arena model names use dashes between version digits
(`claude-opus-4-6`), while models.dev uses dots
(`anthropic/claude-opus-4.6`). Matching is three-tier:

1. **Exact match** on the lowercased, vendor-prefix-stripped id
   (with `4.6` ↔ `4-6` collapsed).
2. **Version-stripped match** — trailing `.N` / `-N` removed
   (`claude-opus-4.6` → `claude-opus-4`).
3. **Prefix match** — Arena `claude-opus-4` matches any models.dev
   id that starts with `claude-opus-4-` or `claude-opus-4.`.

AlpacaEval uses a mix of dashes and dots, plus dates like
`claude-3-5-sonnet-20240620`. We strip:
- Compact dates (`20240620`) and hyphenated dates (`2024-06-20`)
- Variant suffixes (`-high`, `-low`, `-mini`, `-thinking`,
  `-preview`, `-instruct`, etc.)
- Vendor prefixes (`meta-llama/`, `NousResearch/`, `HuggingFaceH4/`, …)

Then we try progressive suffix trimming
(`gpt-5.4-mini-high` → `gpt-5.4-mini` → `gpt-5.4` → `gpt-5`) until
either a match is found or the key is empty.

Vendor prefixes stripped from Arena names include `anthropic/`,
`openai/`, `google/`, `meta/`, `mistral/`, `deepseek/`, `xai/`,
`cohere/`, `qwen/`, `alibaba/`, `nvidia/`, `01-ai/`, `phind/`,
`zerox/`, `together/`, `fireworks/`, `perplexity/`, `ai21/`,
`moonshotai/`, `zhipuai/`, `xiaomi/`.

## Refresh cadence

- Arena updates the leaderboard roughly daily.
- AlpacaEval's CSV in `tatsu-lab/alpaca_eval@main` is updated as new
  models are evaluated.
- The bundled `arena:sync` script (which now also runs the benchmark
  aggregator) pulls fresh snapshots on demand:

  ```bash
  bun packages/core/script/sync-arena.ts
  ```

  It writes `models-arena.json`, `_meta.json`, and rewrites
  `models.json` in place. The aggregator is also exposed standalone as
  `bun packages/core/script/sync-benchmarks.ts`.

- The script is idempotent — re-running overwrites the `arena` and
  `benchmarks` fields and leaves all other models.dev fields
  untouched.

## Data sources

```
GET https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=code
GET https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=text
GET https://raw.githubusercontent.com/tatsu-lab/alpaca_eval/main/src/alpaca_eval/leaderboards/data_AlpacaEval_2/weighted_alpaca_eval_gpt4_turbo_leaderboard.csv
```

Arena response shape:

```json
{
  "meta": {
    "leaderboard": "code",
    "source_url": "https://arena.ai/leaderboard/code",
    "last_updated": "Jun 15, 2026",
    "model_count": 20
  },
  "models": [
    { "rank": 1, "model": "claude-fable-5", "vendor": "Anthropic",
      "score": 1654, "ci": 6, "votes": 2085, "license": "proprietary" }
  ]
}
```

AlpacaEval response shape (CSV):

```
,win_rate,standard_error,n_wins,n_wins_base,n_draws,n_total,discrete_win_rate,mode,avg_length,length_controlled_winrate,lc_standard_error
gpt4_turbo,50.0,0.0,0,0,805,805,50.0,minimal,2049,...
```

The first column is the model key (no header in upstream).
