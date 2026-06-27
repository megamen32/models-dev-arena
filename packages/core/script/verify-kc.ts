#!/usr/bin/env bun
/**
 * verify-kc.ts — On-demand knowledge cutoff verifier.
 *
 * Calls an LLM (default: gpt-4o-mini via OpenAI-compatible API) to determine
 * a model's knowledge cutoff date. Returns YYYY-MM or "unknown".
 *
 * This is INTENTIONALLY expensive and opt-in. Use only when:
 *   - Our fork (megamen32/models-dev-arena) has no KC for the model
 *   - Upstream models.dev (https://models.dev/api.json) has no KC either
 *   - Arena lastUpdated is missing
 *
 * CLI:
 *   bun run verify-kc "openai/gpt-5.4-nano"
 *   bun run verify-kc "google/gemini-2.5-flash-image" --today 2026-06
 *   OPENAI_API_KEY=sk-xxx bun run verify-kc "x"
 *
 * Env:
 *   OPENAI_API_KEY     — required
 *   OPENAI_BASE_URL    — optional (default: https://api.openai.com/v1)
 *   VERIFY_KC_MODEL    — optional (default: gpt-4o-mini)
 *
 * The current year+month is passed to the LLM as "today" so it can decide
 * whether a given KC is "recent" or "outdated".
 */

import OpenAI from "openai";

interface VerifyResult {
  model_id: string;
  kc: string | null;        // YYYY-MM or null
  reason: string;
  source: "llm";
  llm_model: string;
  cost_usd_estimate: number;
  today: string;
}

const SYSTEM_PROMPT = `You are a model registry lookup assistant. Given the name of an LLM, return its training data knowledge cutoff date.

Output rules:
- If you know the knowledge cutoff, return ONLY the date in YYYY-MM format.
- If you don't know, return ONLY the word "unknown".
- No other text, no explanation, no quotes, no markdown.

Examples:
- "gpt-4o" → "2023-09"
- "claude-3.5-sonnet-20240620" → "2024-06"
- "gpt-5-nano" → "2025-08"
- "fake-model-9000" → "unknown"`;

async function verifyKC(
  modelId: string,
  today: string,
  client: OpenAI,
  llmModel: string,
): Promise<VerifyResult> {
  const userPrompt = `Today is ${today}. What is the knowledge cutoff of "${modelId}"?`;

  const t0 = Date.now();
  const response = await client.chat.completions.create({
    model: llmModel,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 10,
    temperature: 0,
  });
  const elapsed = (Date.now() - t0) / 1000;

  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  const usage = response.usage;
  // gpt-4o-mini pricing: $0.150/M input, $0.600/M output (USD)
  const costUsd = usage
    ? (usage.prompt_tokens / 1_000_000) * 0.15
      + (usage.completion_tokens / 1_000_000) * 0.6
    : 0;

  // Validate: YYYY-MM or "unknown"
  const isKc = /^\d{4}-\d{2}$/.test(raw);

  if (raw === "unknown" || !isKc) {
    return {
      model_id: modelId,
      kc: null,
      reason: raw === "unknown" ? "llm: no knowledge" : `llm: unexpected output '${raw.slice(0, 40)}'`,
      source: "llm",
      llm_model: llmModel,
      cost_usd_estimate: costUsd,
      today,
    };
  }

  return {
    model_id: modelId,
    kc: raw,
    reason: `llm: returned '${raw}' in ${elapsed.toFixed(1)}s`,
    source: "llm",
    llm_model: llmModel,
    cost_usd_estimate: costUsd,
    today,
  };
}

async function main() {
  const modelId = process.argv[2];
  if (!modelId) {
    console.error("usage: bun run verify-kc <model-id> [--today YYYY-MM]");
    console.error("  OPENAI_API_KEY must be set");
    process.exit(2);
  }
  let today = new Date().toISOString().slice(0, 7);
  const todayArgIdx = process.argv.indexOf("--today");
  if (todayArgIdx >= 0 && process.argv[todayArgIdx + 1]) {
    today = process.argv[todayArgIdx + 1];
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is required");
    process.exit(2);
  }
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
  });
  const llmModel = process.env.VERIFY_KC_MODEL ?? "gpt-4o-mini";

  const result = await verifyKC(modelId, today, client, llmModel);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("verify-kc failed:", e);
    process.exit(1);
  });
}

export { verifyKC };
