import prisma from '../../lib/prisma';
import { decrypt } from '../../lib/encryption';
import { createAnthropicProvider } from './providers/anthropic';
import { createOpenAiProvider } from './providers/openai';
import { createGeminiProvider } from './providers/gemini';
import type { LlmProvider, ProviderName, ProviderSettings } from './types';
import { PROVIDER_NAMES } from './types';

export * from './types';

/** Builds an adapter for the given settings. */
export function buildProvider(settings: ProviderSettings): LlmProvider {
  switch (settings.provider) {
    case 'anthropic':
      return createAnthropicProvider(settings);
    case 'openai':
    case 'azure_openai':
    case 'openai_compatible':
      return createOpenAiProvider(settings, settings.provider);
    case 'gemini':
      return createGeminiProvider(settings);
  }
}

const ENV_KEYS: Record<ProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  azure_openai: 'AZURE_OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openai_compatible: 'AI_API_KEY',
};

/** Deployment-wide tuning that applies to whichever provider is active. */
function envOptions(): Pick<ProviderSettings, 'reasoningEffort' | 'timeoutMs'> {
  const timeout = Number(process.env.AI_REQUEST_TIMEOUT_MS);
  return {
    reasoningEffort: process.env.AI_REASONING_EFFORT || null,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : null,
  };
}

/** Fills in env-level options (reasoning effort, timeout) for a provider config. */
export function withEnvOptions(settings: ProviderSettings): ProviderSettings {
  return { ...envOptions(), ...settings };
}

/**
 * The active provider: the superadmin's saved config if one is active,
 * otherwise environment configuration (AI_PROVIDER, default "anthropic",
 * plus that provider's key and optional AI_MODEL / AI_BASE_URL). Either way
 * AI_REASONING_EFFORT and AI_REQUEST_TIMEOUT_MS apply (OpenAI-family adapters). Returns null
 * when nothing is configured.
 */
export async function getActiveProviderSettings(): Promise<ProviderSettings | null> {
  const saved = await prisma.aiProviderConfig.findFirst({ where: { isActive: true } });
  if (saved && PROVIDER_NAMES.includes(saved.provider as ProviderName)) {
    return withEnvOptions({
      provider: saved.provider as ProviderName,
      apiKey: decrypt(saved.encryptedApiKey),
      model: saved.model,
      baseUrl: saved.baseUrl,
    });
  }

  const provider = (process.env.AI_PROVIDER || 'anthropic') as ProviderName;
  if (!PROVIDER_NAMES.includes(provider)) return null;
  const apiKey = process.env[ENV_KEYS[provider]] || process.env.AI_API_KEY;
  if (!apiKey) return null;
  return withEnvOptions({ provider, apiKey, model: process.env.AI_MODEL || null, baseUrl: process.env.AI_BASE_URL || null });
}

export async function getAiProvider(): Promise<LlmProvider | null> {
  const settings = await getActiveProviderSettings();
  return settings ? buildProvider(settings) : null;
}
