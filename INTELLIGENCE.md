# Arena Intelligence

This fork augments the [models.dev](https://models.dev) dataset with
**Arena AI leaderboard** intelligence scores — a per-model
ELO-based fitness measure for several task categories.

## What gets added

Every entry in `models.json` whose name matches an Arena leaderboard
model gains a new top-level `arena` field:

```jsonc
{
  "id": "anthropic/claude-opus-4.6",
  // ... existing models.dev fields ...
  "arena": {
    "leaderboard": "code",                  // "text" or "code"
    "rank": 6,                              // Arena rank
    "elo": 1542,                            // raw ELO
    "ci": 5,                                // 95% CI half-width
    "votes": 9778,                          // human preference votes
    "vendor": "Anthropic",
    "license": "proprietary",
    "score": 0.6698,                        // normalized taskFit (see below)
    "confidence": "high",                   // "high" / "medium" / "low"
    "categories": ["coding"],               // mapped models.dev task categories
    "lastUpdated": "Jun 15, 2026",
    "sourceUrl": "https://arena.ai/leaderboard/code",
    "fetchedAt": "2026-06-16T07:00:50Z"
  }
}
```

A flat side-file `models-arena.json` is also written — every Arena
entry, keyed by its leaderboard name:

```json
{
  "arena": {
    "claude-opus-4-6-thinking": { "elo": 1542, "score": 0.6289, ... },
    "kimi-k2.6": { "elo": 1515, "score": 0.5841, ... }
  },
  "generatedAt": "2026-06-16T07:00:50Z"
}
```

## Public feed (GitHub Pages)

A static copy of the merge is published by GitHub Pages at:

```
https://megamen32.github.io/models-dev-arena/
```

Endpoints (all served as `application/json` from the `dev` branch):

| File                     | What's in it                                                            |
| ------------------------ | ----------------------------------------------------------------------- |
| `/`                      | Status page (last sync time, counts, source links)                     |
| `/_meta.json`            | Last-refresh timestamp, Arena `last_updated`, counts, source URLs      |
| `/models-arena.json`     | Flat lookup keyed by Arena leaderboard name                            |
| `/models.json`           | Full models.dev catalog with `arena` field on matched entries           |
| `/INTELLIGENCE.md`       | This document                                                           |

The index page fetches `/_meta.json` and renders a live "last refresh"
card. The page is regenerated on every push to `dev`; `arena:sync` is
also scheduled to run daily at 06:00 UTC (see
`.github/workflows/arena-sync.yml`).

```jsonc
{
  "id": "anthropic/claude-opus-4.6",
  // ... existing models.dev fields ...
  "arena": {
    "leaderboard": "code",                  // "text" or "code"
    "rank": 6,                              // Arena rank
    "elo": 1542,                            // raw ELO
    "ci": 5,                                // 95% CI half-width
    "votes": 9778,                          // human preference votes
    "vendor": "Anthropic",
    "license": "proprietary",
    "score": 0.6698,                        // normalized taskFit (see below)
    "confidence": "high",                   // "high" / "medium" / "low"
    "categories": ["coding"],               // mapped models.dev task categories
    "lastUpdated": "Jun 15, 2026",
    "sourceUrl": "https://arena.ai/leaderboard/code",
    "fetchedAt": "2026-06-16T07:00:50Z"
  }
}
```

A flat side-file `models-arena.json` is also written — every Arena
entry, keyed by its leaderboard name:

```json
{
  "arena": {
    "claude-opus-4-6-thinking": { "elo": 1542, "score": 0.6289, ... },
    "kimi-k2.6": { "elo": 1515, "score": 0.5841, ... }
  },
  "generatedAt": "2026-06-16T07:00:50Z"
}
```

## How `score` is calculated

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

The result is rounded to 4 decimal places and stored as `score`.

## Confidence buckets

Confidence is a function of how many human preference votes underpin
the ELO:

| votes     | confidence |
| --------- | ---------- |
| `>= 5000` | `high`     |
| `>= 1000` | `medium`   |
| `< 1000`  | `low`      |

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

Vendor prefixes stripped from Arena names include `anthropic/`,
`openai/`, `google/`, `meta/`, `mistral/`, `deepseek/`, `xai/`,
`cohere/`, `qwen/`, `alibaba/`, `nvidia/`, `01-ai/`, `phind/`,
`zerox/`, `together/`, `fireworks/`, `perplexity/`, `ai21/`,
`moonshotai/`, `zhipuai/`, `xiaomi/`.

## Refresh cadence

- Arena updates the leaderboard roughly daily.
- The bundled `sync-arena.ts` script pulls a fresh snapshot on demand:

  ```bash
  bun packages/core/script/sync-arena.ts
  ```

  It writes `models-arena.json` and rewrites `models.json` in place.

- The script is idempotent — re-running overwrites the `arena` field
  and leaves all other models.dev fields untouched.

## Data source

```
GET https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=code
GET https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=text
```

Response shape:

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

`score` is the raw ELO (renamed `elo` in the merged output to avoid
collision with the normalized `score` field).
