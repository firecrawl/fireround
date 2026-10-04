// The reconciling model, resolved from whichever key the operator set. The Vercel AI Gateway is the
// default (one key, any model, failover and spend in one place); a direct OpenAI, OpenRouter, or
// Anthropic key works the same way. No key means no reconciliation: the pipeline runs on Firecrawl alone.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGateway } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

export type ReconcileProvider = "gateway" | "openai" | "openrouter" | "anthropic";

export interface ReconcileModel {
  provider: ReconcileProvider;
  /** The model id as the provider names it. */
  modelId: string;
  /** "gateway:openai/gpt-6-luna": what the verification records and the settings page shows. */
  label: string;
  model: LanguageModel;
}

/**
 * The default per provider: GPT 6 Luna, a cheap model with the judgment the cross-source read needs;
 * Anthropic's nearest tier for a direct Anthropic key. A gateway team that enforces Zero Data
 * Retention cannot reach a model with no ZDR provider yet; pin RECONCILE_MODEL (openai/gpt-5.6-luna
 * has one) until it does.
 */
export const DEFAULT_MODEL: Record<ReconcileProvider, string> = {
  gateway: "openai/gpt-6-luna",
  openai: "gpt-6-luna",
  openrouter: "openai/gpt-6-luna",
  anthropic: "claude-haiku-4.5",
};

const PROVIDER_ORDER: ReconcileProvider[] = ["gateway", "openai", "openrouter", "anthropic"];
const KEY_FOR: Record<ReconcileProvider, string> = {
  gateway: "AI_GATEWAY_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/**
 * The read-back steps a model can be set for on its own: the feed's lanes (sweep, watch, a monitor's
 * page), corroboration, a history round, the X lane's announcements, the money repair's re-ground. RECONCILE_MODEL_<STEP> overrides
 * RECONCILE_MODEL for that step alone; unset, every step reads with RECONCILE_MODEL or the default.
 */
export type ReconcileStep = "feed" | "corroborate" | "history" | "announcements" | "repair";

/** Which provider the environment selects, without building a client: for the settings page and tests. */
export function reconcileProviderFor(
  env: Record<string, string | undefined> = process.env,
  step?: ReconcileStep,
): { provider: ReconcileProvider; modelId: string } | null {
  if ((env.RECONCILE ?? "").toLowerCase() === "off") return null;
  const forced = env.RECONCILE_PROVIDER as ReconcileProvider | undefined;
  const order = forced && PROVIDER_ORDER.includes(forced) ? [forced] : PROVIDER_ORDER;
  for (const provider of order) {
    const key = env[KEY_FOR[provider]];
    // The gateway also accepts Vercel's OIDC token, but only where it sits in the environment (a
    // pulled .env or a build); a deployed function does not see it there, so set AI_GATEWAY_API_KEY on Vercel.
    if (!key && !(provider === "gateway" && env.VERCEL_OIDC_TOKEN)) continue;
    const forStep = step ? env[`RECONCILE_MODEL_${step.toUpperCase()}`]?.trim() : undefined;
    return { provider, modelId: forStep || env.RECONCILE_MODEL?.trim() || DEFAULT_MODEL[provider] };
  }
  return null;
}

const cached = new Map<string, ReconcileModel>();

/** The configured model, or null when no key is set or RECONCILE=off. */
export function reconcileModel(env: Record<string, string | undefined> = process.env, step?: ReconcileStep): ReconcileModel | null {
  const pick = reconcileProviderFor(env, step);
  if (!pick) return null;
  return buildModel(pick, env);
}

/**
 * A stronger mid-priced model per provider, for the dossier check: it reads a dozen pages and rules on
 * every claim, once per company, so judgment is worth more than the cheapest tier, but the top tier is
 * not needed for reading claims against pages.
 */
export const DOSSIER_VERIFY_DEFAULT_MODEL: Record<ReconcileProvider, string> = {
  gateway: "openai/gpt-6-sol",
  openai: "gpt-6-sol",
  openrouter: "openai/gpt-6-sol",
  anthropic: "claude-sonnet-5",
};

/**
 * The dossier check's model: DOSSIER_VERIFY_MODEL when set, else a pinned RECONCILE_MODEL (so a
 * deployment that pinned a ZDR model for reconcile keeps that pin here), else the strongest default.
 * The same keys pick the provider; with no key there is no check, and no dossier is saved.
 */
export function dossierVerifyProviderFor(
  env: Record<string, string | undefined> = process.env,
): { provider: ReconcileProvider; modelId: string } | null {
  const override = env.DOSSIER_VERIFY_MODEL?.trim();
  const pick = reconcileProviderFor(override ? { ...env, RECONCILE: undefined } : env);
  if (!pick) return null;
  const modelId = override || env.RECONCILE_MODEL?.trim() || DOSSIER_VERIFY_DEFAULT_MODEL[pick.provider];
  return { provider: pick.provider, modelId };
}

export function dossierVerifyModel(env: Record<string, string | undefined> = process.env): ReconcileModel | null {
  const pick = dossierVerifyProviderFor(env);
  if (!pick) return null;
  return buildModel(pick, env);
}

/**
 * The publication audit's model: a different family from the read-back's default, so the last look
 * does not share the first one's blind spots, at a mid-priced tier. PUBLICATION_AUDIT_MODEL overrides it.
 */
export const PUBLICATION_AUDIT_DEFAULT_MODEL: Record<ReconcileProvider, string> = {
  gateway: "anthropic/claude-sonnet-5-5",
  openai: "gpt-6-sol",
  openrouter: "anthropic/claude-sonnet-5.5",
  anthropic: "claude-sonnet-5-5",
};

export function publicationAuditModel(env: Record<string, string | undefined> = process.env): ReconcileModel | null {
  const pick = reconcileProviderFor({ ...env, RECONCILE: undefined });
  if (!pick || (env.PUBLICATION_AUDIT ?? "").toLowerCase() === "off") return null;
  return buildModel(
    { provider: pick.provider, modelId: env.PUBLICATION_AUDIT_MODEL?.trim() || PUBLICATION_AUDIT_DEFAULT_MODEL[pick.provider] },
    env,
  );
}

function buildModel(pick: { provider: ReconcileProvider; modelId: string }, env: Record<string, string | undefined>): ReconcileModel {
  const key = `${pick.provider}:${pick.modelId}:${env[KEY_FOR[pick.provider]] ?? "oidc"}`;
  const hit = cached.get(key);
  if (hit) return hit;
  const label = `${pick.provider}:${pick.modelId}`;
  const model: LanguageModel = (() => {
    switch (pick.provider) {
      case "gateway":
        return createGateway({ apiKey: env.AI_GATEWAY_API_KEY })(pick.modelId);
      case "openai":
        return createOpenAI({ apiKey: env.OPENAI_API_KEY })(pick.modelId);
      case "openrouter":
        return createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })(pick.modelId);
      case "anthropic":
        return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(pick.modelId);
    }
  })();
  const built = { provider: pick.provider, modelId: pick.modelId, label, model };
  cached.set(key, built);
  return built;
}
