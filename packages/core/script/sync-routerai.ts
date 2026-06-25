#!/usr/bin/env bun
/**
 * sync-routerai.ts — Sync routerai.ru model catalog into providers/routerai/models/.
 *
 * Pulls the live catalog from https://routerai.ru/api/v1/models (302 LLM models
 * with real RUB pricing) and writes one provider TOML per model into
 * providers/routerai/models/<vendor>/<model>.toml.
 *
 * Pricing in routerai is per-token in RUB. Models.dev / fork convention is
 * per-million tokens in USD, so each entry is converted at the current
 * USD/RUB rate (default fallback 92.0 if the rate provider is unreachable).
 *
 * Models that have a matching models/<vendor>/<model>.toml are written with
 * `base_model` so they inherit release date / context length / modalities
 * automatically. Unknown models get inline metadata so they're still usable.
 *
 * Run from the repo root: `bun packages/core/script/sync-routerai.ts`.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { getUsdRubRate, rubPerTokenToUsdPer1M } from "../src/currency";

const ROUTERAI_BASE = "https://routerai.ru/api/v1";
const SCHEMA_VERSION = "routerai-v1";

interface RouterAIPricing {
  prompt?: number;
  completion?: number;
  [k: string]: unknown;
}

interface RouterAIArchitecture {
  modality?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  tokenizer?: string | null;
  instruct_type?: string | null;
}

interface RouterAIModel {
  id: string;
  name?: string;
  description?: string;
  created?: number;
  context_length?: number | null;
  architecture?: RouterAIArchitecture;
  pricing?: RouterAIPricing;
  supported_parameters?: string[];
  per_request_limits?: unknown;
  [k: string]: unknown;
}

interface RouterAIResponse {
  data?: RouterAIModel[];
}

async function fetchRouterAICatalog(): Promise<RouterAIModel[]> {
  const res = await fetch(`${ROUTERAI_BASE}/models`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`routerai.ru /models returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as RouterAIResponse | RouterAIModel[];
  const list = Array.isArray(body) ? body : body.data ?? [];
  console.log(`[routerai] fetched ${list.length} models`);
  return list;
}

async function fetchUsdRubRate(): Promise<number> {
  const rate = await getUsdRubRate();
  console.log(`[routerai] USD/RUB rate: ${rate.rate} (${rate.source})`);
  return rate.rate;
}

function rubPerTokenToUsdPer1M(rubPerToken: number | undefined, rate: number): number {
  if (!rubPerToken || rubPerToken <= 0) return 0;
  const usdPer1M = (rubPerToken * 1_000_000) / rate;
  return Math.round(usdPer1M * 10_000) / 10_000;
}

function parseVendor(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : "routerai";
}

function parseModelSlug(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(slash + 1) : modelId;
}

function isLLM(m: RouterAIModel): boolean {
  const out = m.architecture?.output_modalities ?? [];
  return out.includes("text") && !out.includes("video") && !out.includes("image");
}

function supportsVision(m: RouterAIModel): boolean {
  const inp = m.architecture?.input_modalities ?? [];
  return inp.includes("image");
}

function supportsTools(m: RouterAIModel): boolean {
  const params = m.supported_parameters ?? [];
  return (
    params.includes("tools") ||
    params.includes("tool_choice") ||
    params.includes("functions") ||
    params.includes("tool_call")
  );
}

function supportsStructuredOutput(m: RouterAIModel): boolean {
  const params = m.supported_parameters ?? [];
  return (
    params.includes("response_format") ||
    params.includes("structured_outputs") ||
    params.includes("json_schema")
  );
}

function supportsReasoning(m: RouterAIModel): boolean {
  const id = m.id.toLowerCase();
  const params = m.supported_parameters ?? [];
  return (
    id.includes("thinking") ||
    id.includes("reasoning") ||
    params.includes("reasoning_effort") ||
    params.includes("thinking_budget")
  );
}

function unixToDateString(unix: number | undefined): string | undefined {
  if (!unix || unix <= 0) return undefined;
  try {
    const d = new Date(unix * 1000);
    return d.toISOString().slice(0, 10);
  } catch {
    return undefined;
  }
}

function baseModelExists(repoRoot: string, baseId: string): boolean {
  // base_id format in fork: <vendor>/<model>
  const path = resolve(repoRoot, "models", `${baseId}.toml`);
  if (existsSync(path)) return true;
  // Some base models live under models/<vendor>/<model>.toml
  const nested = resolve(repoRoot, "models", `${baseId.split("/").join("/")}.toml`);
  return existsSync(nested);
}

function tomlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

function buildModelToml(
  m: RouterAIModel,
  usdRubRate: number,
  repoRoot: string
): { path: string; content: string; usesBaseModel: boolean } {
  const pricing = m.pricing ?? {};
  const inputUsd = rubPerTokenToUsdPer1M(pricing.prompt, usdRubRate);
  const outputUsd = rubPerTokenToUsdPer1M(pricing.completion, usdRubRate);

  const vendor = parseVendor(m.id);
  const slug = parseModelSlug(m.id);

  // base_model path
  const baseId = m.id;
  const usesBaseModel = baseModelExists(repoRoot, baseId);

  const lines: string[] = [];
  lines.push(`# Auto-generated by packages/core/script/sync-routerai.ts`);
  lines.push(`# Source: ${ROUTERAI_BASE}/models (fetched live)`);
  lines.push(`# DO NOT EDIT — re-run the sync to update pricing.`);
  lines.push("");

  if (usesBaseModel) {
    lines.push(`base_model = "${tomlEscape(baseId)}"`);
  } else {
    if (m.name) lines.push(`name = "${tomlEscape(m.name)}"`);
    if (m.description) {
      lines.push(`description = "${tomlEscape(m.description.slice(0, 800))}"`);
    }
    const created = unixToDateString(m.created);
    if (created) {
      lines.push(`release_date = "${created}"`);
      lines.push(`last_updated = "${created}"`);
    }
    if (m.context_length && m.context_length > 0) {
      lines.push("");
      lines.push("[limit]");
      lines.push(`context = ${m.context_length}`);
    }
  }

  lines.push("");
  lines.push("[cost]");
  lines.push(`input = ${inputUsd}`);
  lines.push(`output = ${outputUsd}`);

  // Inline metadata only for non-base_model entries
  if (!usesBaseModel) {
    lines.push("");
    lines.push("attachment = " + (supportsVision(m) ? "true" : "false"));
    lines.push("tool_call = " + (supportsTools(m) ? "true" : "false"));
    lines.push(
      "structured_output = " + (supportsStructuredOutput(m) ? "true" : "false")
    );
    lines.push("reasoning = " + (supportsReasoning(m) ? "true" : "false"));
  }

  return {
    path: resolve(repoRoot, "providers", "routerai", "models", vendor, `${slug}.toml`),
    content: lines.join("\n") + "\n",
    usesBaseModel,
  };
}

async function main() {
  const root = resolve(import.meta.dir, "../../..");
  const modelsRoot = resolve(root, "providers", "routerai", "models");

  const usdRubRate = await fetchUsdRubRate();
  const catalog = await fetchRouterAICatalog();

  const llm = catalog.filter(isLLM);
  console.log(`[routerai] LLM subset: ${llm.length} models`);

  let written = 0;
  let withBaseModel = 0;
  let inlined = 0;
  let freeModels = 0;

  for (const m of llm) {
    const { path, content, usesBaseModel } = buildModelToml(m, usdRubRate, root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    written++;
    if (usesBaseModel) withBaseModel++;
    else inlined++;
    if ((m.pricing?.prompt ?? 0) === 0 && (m.pricing?.completion ?? 0) === 0) {
      freeModels++;
    }
  }

  console.log(
    `[routerai] wrote ${written} provider TOMLs (${withBaseModel} base_model, ${inlined} inlined)`
  );
  console.log(`[routerai] ${freeModels} models with $0/$0 pricing (free tier)`);

  // Update _meta.json with provenance.
  const metaPath = resolve(root, "_meta.json");
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    meta = {};
  }
  const benchmarks = (meta.benchmarks ?? {}) as Record<string, unknown>;
  benchmarks["routerai"] = {
    fetchedAt: new Date().toISOString(),
    modelCount: llm.length,
    source: ROUTERAI_BASE,
    public_url: "https://routerai.ru/models",
    doc: "https://routerai.ru/models",
    currency: "RUB",
    schema_version: SCHEMA_VERSION,
    usd_rub_rate: usdRubRate,
  };
  meta.benchmarks = benchmarks;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log(`[_meta.json] wrote routerai provenance → ${metaPath}`);

  // Cleanup: print unused files (models no longer in catalog).
  // Skipped in this first version — keep historical data until we have
  // a delete-policy decision from the user.
}

main().catch((err) => {
  console.error("[sync-routerai] failed:", err);
  process.exit(1);
});
