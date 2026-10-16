'use client';

import React, { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Loader2, Sparkles } from 'lucide-react';
import api, { AiProviderConfig } from '@/api/client';
import { Icon, PageHeader, Card, Badge, Button, Switch, Input } from '@/components/ui';

type ProviderName = AiProviderConfig['provider'];

interface ProviderMeta {
  label: string;
  keyHint: string;
  modelLabel?: string;
  modelHint: string;
  /** Suggestions for the model field; any other name can be typed. */
  models?: string[];
  baseUrl?: { label: string; placeholder: string; hint: string };
  apiVersion?: boolean;
  blurb: string;
}

// Current OpenAI API models at the time of writing. Free text is allowed, so
// newer or account-specific models can be entered directly.
const OPENAI_MODELS = ['gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini', 'o3'];

const PROVIDERS: Record<ProviderName, ProviderMeta> = {
  anthropic: {
    label: 'Anthropic (Claude)',
    keyHint: 'sk-ant-…',
    modelHint: 'Leave empty for the default (claude-opus-5)',
    blurb: 'Recommended default. Declined requests are automatically retried on a fallback Claude model.',
  },
  openai: {
    label: 'OpenAI',
    keyHint: 'sk-…',
    modelHint: 'Pick a suggestion or type any model your OpenAI project can use. Leave empty for the default.',
    models: OPENAI_MODELS,
    baseUrl: {
      label: 'Base URL (optional)',
      placeholder: 'https://api.openai.com/v1',
      hint: 'Only for a proxy or gateway. It must support the Responses API, or set OPENAI_API=chat on the server.',
    },
    blurb:
      'Responses API with strict function calling and parallel tool calls; reasoning state is kept between steps without OpenAI storing the conversation. Retries rate limits and server errors. Reasoning effort is set with AI_REASONING_EFFORT.',
  },
  azure_openai: {
    label: 'Azure OpenAI',
    keyHint: 'Key from the Azure OpenAI resource',
    modelLabel: 'Deployment name',
    modelHint: 'The name you gave the model deployment in Azure (not the model name, unless they match)',
    models: OPENAI_MODELS,
    baseUrl: {
      label: 'Endpoint',
      placeholder: 'https://my-resource.openai.azure.com',
      hint: 'The resource endpoint from the Azure portal (Keys and Endpoint)',
    },
    apiVersion: true,
    blurb: 'Chat Completions against an Azure OpenAI deployment, with the same tool and reasoning handling as OpenAI.',
  },
  gemini: {
    label: 'Google Gemini',
    keyHint: 'Google AI Studio API key',
    modelHint: 'Gemini model name, e.g. from AI Studio',
    blurb: 'Generative Language API with function calling.',
  },
  openai_compatible: {
    label: 'OpenAI-compatible endpoint',
    keyHint: 'API key for the endpoint',
    modelHint: 'Model name on that endpoint',
    baseUrl: {
      label: 'Base URL',
      placeholder: 'https://api.example.com/v1',
      hint: 'The URL that /chat/completions is appended to',
    },
    blurb: 'Mistral, xAI, Groq, DeepSeek, OpenRouter, or a self-hosted server (vLLM, Ollama) that speaks the OpenAI chat API.',
  },
};

interface FormState { apiKey: string; model: string; baseUrl: string; apiVersion: string; isActive: boolean }

// Azure stores the api-version on the endpoint URL (?api-version=...); the
// form edits the two separately.
function splitApiVersion(baseUrl: string): { baseUrl: string; apiVersion: string } {
  try {
    const url = new URL(baseUrl);
    const apiVersion = url.searchParams.get('api-version') || '';
    url.searchParams.delete('api-version');
    return { baseUrl: url.toString().replace(/\/$/, '').replace(/\?$/, ''), apiVersion };
  } catch {
    return { baseUrl, apiVersion: '' };
  }
}

function joinApiVersion(baseUrl: string, apiVersion: string): string {
  if (!baseUrl || !apiVersion.trim()) return baseUrl;
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}api-version=${encodeURIComponent(apiVersion.trim())}`;
}

const API_LABELS: Record<string, string> = { responses: 'Responses API', chat_completions: 'Chat Completions' };

export default function AiProvidersPage() {
  const [providers, setProviders] = useState<AiProviderConfig[]>([]);
  const [forms, setForms] = useState<Record<string, FormState>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string }>>({});

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.getAiProviders();
      setProviders(data);
      setForms(Object.fromEntries(data.map((p) => {
        const { baseUrl, apiVersion } = PROVIDERS[p.provider]?.apiVersion ? splitApiVersion(p.baseUrl || '') : { baseUrl: p.baseUrl || '', apiVersion: '' };
        return [p.provider, { apiKey: '', model: p.model || '', baseUrl, apiVersion, isActive: p.isActive }];
      })));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const update = (provider: string, patch: Partial<FormState>) =>
    setForms((prev) => ({ ...prev, [provider]: { ...prev[provider], ...patch } }));

  const baseUrlFor = (provider: ProviderName, form: FormState) =>
    PROVIDERS[provider]?.apiVersion ? joinApiVersion(form.baseUrl.trim(), form.apiVersion) : form.baseUrl.trim();

  const save = async (p: AiProviderConfig) => {
    const form = forms[p.provider];
    setSaving(p.provider);
    setResults((r) => ({ ...r, [p.provider]: undefined as any }));
    try {
      await api.saveAiProvider(p.provider, {
        apiKey: form.apiKey || undefined,
        model: form.model.trim() || undefined,
        baseUrl: baseUrlFor(p.provider, form) || undefined,
        isActive: form.isActive,
      });
      await load();
      setResults((r) => ({ ...r, [p.provider]: { ok: true, text: form.isActive ? 'Saved and active' : 'Saved' } }));
    } catch (err: any) {
      setResults((r) => ({ ...r, [p.provider]: { ok: false, text: err?.response?.data?.error || 'Could not save' } }));
    } finally {
      setSaving(null);
    }
  };

  const test = async (p: AiProviderConfig) => {
    const form = forms[p.provider];
    setTesting(p.provider);
    setResults((r) => ({ ...r, [p.provider]: undefined as any }));
    try {
      // Tests what is in the form, saved or not; empty fields use the saved values.
      const res = await api.testAiProvider(p.provider, {
        apiKey: form.apiKey || undefined,
        model: form.model.trim() || undefined,
        baseUrl: baseUrlFor(p.provider, form) || undefined,
      });
      const via = res.api ? ` via ${API_LABELS[res.api] ?? res.api}` : '';
      const timing = typeof res.latencyMs === 'number' ? `, ${res.latencyMs} ms` : '';
      setResults((r) => ({
        ...r,
        [p.provider]: res.ok ? { ok: true, text: `Key and model accepted: ${res.model}${via}${timing}` } : { ok: false, text: res.error || 'Test failed' },
      }));
    } catch (err: any) {
      setResults((r) => ({ ...r, [p.provider]: { ok: false, text: err?.response?.data?.error || 'Test failed' } }));
    } finally {
      setTesting(null);
    }
  };

  return (
    <div style={{ maxWidth: '900px' }}>
      <PageHeader
        title="AI providers"
        subtitle="Choose which LLM powers AI-assisted analytics. Only one provider is active at a time; tenants must also have the AI feature in their plan and switch it on."
        icon={Sparkles}
      />

      {loading ? (
        <div style={{ padding: '3rem', textAlign: 'center' }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <p style={{ color: 'var(--gray-500)', fontSize: '0.875rem', margin: 0 }}>
            The model only ever receives aggregated queue statistics (counts, wait and service times, service names), never names, contact details or identifiers.
          </p>
          {providers.map((p) => {
            const meta = PROVIDERS[p.provider];
            const form = forms[p.provider];
            const result = results[p.provider];
            if (!form) return null;
            return (
              <Card key={p.provider} style={{ padding: '1.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
                  <h2 style={{ fontSize: '1.125rem', fontWeight: 700, color: 'var(--gray-900)' }}>{meta.label}</h2>
                  <Badge tone={p.isActive ? 'success' : p.configured ? 'neutral' : 'neutral'}>
                    {p.isActive ? 'Active' : p.configured ? 'Saved' : 'Not set up'}
                  </Badge>
                </div>
                <p style={{ color: 'var(--gray-500)', fontSize: '0.875rem', marginBottom: '1.25rem' }}>{meta.blurb}</p>

                <div style={{ display: 'grid', gap: '0.9rem', marginBottom: '1.25rem' }}>
                  <Input
                    label="API key"
                    type="password"
                    placeholder={p.configured ? `Saved (${p.apiKeyMasked}) - leave empty to keep` : meta.keyHint}
                    value={form.apiKey}
                    onChange={(e) => update(p.provider, { apiKey: e.target.value })}
                  />
                  <Input
                    label={meta.modelLabel || 'Model'}
                    placeholder={p.defaultModel || 'Required'}
                    hint={meta.modelHint}
                    list={meta.models ? `ai-models-${p.provider}` : undefined}
                    autoComplete="off"
                    value={form.model}
                    onChange={(e) => update(p.provider, { model: e.target.value })}
                  />
                  {meta.models && (
                    <datalist id={`ai-models-${p.provider}`}>
                      {meta.models.map((m) => <option key={m} value={m} />)}
                    </datalist>
                  )}
                  {meta.baseUrl && (
                    <Input
                      label={meta.baseUrl.label}
                      placeholder={meta.baseUrl.placeholder}
                      hint={meta.baseUrl.hint}
                      value={form.baseUrl}
                      onChange={(e) => update(p.provider, { baseUrl: e.target.value })}
                    />
                  )}
                  {meta.apiVersion && (
                    <Input
                      label="API version (optional)"
                      placeholder="Leave empty for Azure's v1 API"
                      hint="Only for classic deployment URLs, e.g. 2024-10-21"
                      value={form.apiVersion}
                      onChange={(e) => update(p.provider, { apiVersion: e.target.value })}
                    />
                  )}
                  <Switch
                    label="Use this provider for AI analytics"
                    checked={form.isActive}
                    onChange={(e) => update(p.provider, { isActive: e.target.checked })}
                  />
                </div>

                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Button variant="primary" onClick={() => save(p)} disabled={saving === p.provider}>
                    {saving === p.provider ? <Icon icon={Loader2} size={16} className="qf-spin" /> : 'Save'}
                  </Button>
                  {(p.configured || form.apiKey) && (
                    <Button variant="secondary" onClick={() => test(p)} disabled={testing === p.provider}>
                      {testing === p.provider ? 'Testing…' : 'Test connection'}
                    </Button>
                  )}
                  {result && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem', color: result.ok ? 'var(--success-600)' : 'var(--error-600)' }}>
                      <Icon icon={result.ok ? CheckCircle2 : XCircle} size={16} />
                      {result.text}
                    </span>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
