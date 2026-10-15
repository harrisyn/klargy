import type { JsonSchema } from '../types';

// Helpers shared by the OpenAI Responses and Chat Completions adapters.

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** Used when the openai provider has no model set. */
export const OPENAI_DEFAULT_MODEL = 'gpt-5-mini';

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/**
 * Whether a model name looks like an OpenAI reasoning model (o-series, GPT-5
 * and later, gpt-oss). These reject `max_tokens` and non-default
 * `temperature`/`top_p`, and accept a reasoning effort. Tolerates vendor
 * prefixes such as "openai/gpt-5". The "-chat" GPT-5 variants are treated as
 * non-reasoning, so no reasoning parameters are sent to them.
 */
export function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase().replace(/^.*\//, '');
  if (/^gpt-\d/.test(m) && /-chat(-|$)/.test(m)) return false;
  return /^(o\d|gpt-(?:[5-9]|\d{2,})|gpt-oss|codex)/.test(m);
}

/** A configured reasoning effort, or null when unset or unrecognized. */
export function normalizeEffort(effort: string | null | undefined): string | null {
  const value = (effort || '').trim().toLowerCase();
  return (REASONING_EFFORTS as readonly string[]).includes(value) ? value : null;
}

/**
 * Rewrites a tool schema for OpenAI strict mode, where every property must be
 * listed in `required` and `additionalProperties` must be false. Optional
 * properties become nullable instead; the model then sends null for "omitted",
 * which parseToolArgs strips. Returns null if the schema can't be expressed
 * strictly (the tool is then sent non-strict).
 */
export function toStrictSchema(schema: JsonSchema): JsonSchema | null {
  const converted = strictObject(schema as unknown as Record<string, unknown>);
  return converted as JsonSchema | null;
}

function strictObject(schema: Record<string, unknown>): Record<string, unknown> | null {
  if (schema.type !== 'object') return null;
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(properties)) {
    let next: Record<string, unknown> | null = prop;
    if (prop?.type === 'object') next = strictObject(prop);
    if (!next || typeof next.type !== 'string') return null;
    out[key] = required.has(key) ? next : { ...next, type: [next.type, 'null'] };
  }
  return { ...schema, properties: out, required: Object.keys(out), additionalProperties: false };
}

/** Parses tool-call arguments, tolerating bad JSON and dropping nulls (strict mode's "omitted"). */
export function parseToolArgs(json: unknown): Record<string, unknown> {
  let value: unknown = json;
  if (typeof json === 'string') {
    try {
      value = JSON.parse(json || '{}');
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== null));
}

/**
 * Chat Completions URL for an Azure OpenAI resource. `endpoint` is the
 * resource URL (https://NAME.openai.azure.com). Without an api-version it uses
 * Azure's v1 API (/openai/v1/chat/completions, deployment passed as `model`).
 * With `?api-version=...` on the endpoint it uses the classic
 * /openai/deployments/{deployment}/chat/completions?api-version=... route.
 */
export function azureChatUrl(endpoint: string, deployment: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Azure OpenAI needs a valid endpoint URL, e.g. https://my-resource.openai.azure.com');
  }
  const apiVersion = url.searchParams.get('api-version');
  const path = url.pathname.replace(/\/+$/, '');
  if (apiVersion) {
    const deploymentPath = /\/openai\/deployments\/[^/]+$/.test(path) ? path : `/openai/deployments/${encodeURIComponent(deployment)}`;
    return `${url.origin}${deploymentPath}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
  }
  const v1Path = path.endsWith('/openai/v1') ? path : `${path.replace(/\/openai$/, '')}/openai/v1`;
  return `${url.origin}${v1Path}/chat/completions`;
}
