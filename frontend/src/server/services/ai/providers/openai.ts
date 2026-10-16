import type { AiMessage, ChatRequest, ChatResult, LlmProvider, ProviderSettings, StopReason, ToolCall } from '../types';
import { AiProviderError } from '../types';
import { postJson } from './http';
import {
  OPENAI_BASE_URL,
  OPENAI_DEFAULT_MODEL,
  azureChatUrl,
  isReasoningModel,
  normalizeEffort,
  parseToolArgs,
  toStrictSchema,
} from './openaiCommon';
import { responsesChat } from './openaiResponses';

// OpenAI-family adapters. Which API each provider speaks:
//
// - openai (api.openai.com): the Responses API, OpenAI's recommended API for
//   agents. It carries reasoning state between tool-calling turns (encrypted
//   reasoning items) and is where new model features land first. Set
//   OPENAI_API=chat to fall back to Chat Completions, e.g. behind a proxy that
//   only speaks /chat/completions.
// - azure_openai: Chat Completions against an Azure deployment, with the
//   OpenAI-specific parameters (strict tools, parallel calls, reasoning effort,
//   max_completion_tokens).
// - openai_compatible (Mistral, xAI, Groq, DeepSeek, OpenRouter, vLLM,
//   Ollama...): plain Chat Completions with the widely supported subset only
//   (max_tokens, no strict/parallel flags), since those servers vary in what
//   they accept.

type Flavor = 'openai' | 'azure' | 'compatible';

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

function toChatMessages(system: string, messages: AiMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text || null,
        ...(m.toolCalls.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            }
          : {}),
      });
    } else {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.callId, content: r.content });
    }
  }
  return out;
}

function mapStop(reason: string | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

interface ChatConfig {
  url: string;
  headers: Record<string, string>;
  model: string;
  flavor: Flavor;
  reasoningEffort: string | null;
  timeoutMs?: number | null;
  label: string;
}

export function buildChatCompletionsBody(config: Pick<ChatConfig, 'model' | 'flavor' | 'reasoningEffort'>, request: ChatRequest): Record<string, unknown> {
  const openAiParams = config.flavor !== 'compatible';
  const maxTokens = request.maxTokens ?? 16000;
  // Deployment names on Azure are arbitrary, so an explicitly configured
  // effort is trusted there; elsewhere only reasoning models get one.
  const effort = config.reasoningEffort && (config.flavor === 'azure' || isReasoningModel(config.model)) ? config.reasoningEffort : null;

  return {
    model: config.model,
    messages: toChatMessages(request.system, request.messages),
    ...(request.tools.length
      ? {
          tools: request.tools.map((t) => {
            const strict = openAiParams ? toStrictSchema(t.parameters) : null;
            return {
              type: 'function',
              function: { name: t.name, description: t.description, parameters: strict ?? t.parameters, ...(strict ? { strict: true } : {}) },
            };
          }),
          ...(openAiParams ? { parallel_tool_calls: true } : {}),
        }
      : {}),
    // Reasoning models reject max_tokens; OpenAI and Azure accept
    // max_completion_tokens for every model. Compatible servers mostly only
    // know max_tokens.
    ...(openAiParams ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    ...(effort ? { reasoning_effort: effort } : {}),
  };
}

export function parseChatCompletionsResult(body: any, fallbackModel: string): ChatResult {
  const choice = body?.choices?.[0];
  const message = choice?.message ?? {};
  const toolCalls: ToolCall[] = (message.tool_calls ?? [])
    .filter((c: any) => c?.type === 'function' || c?.function)
    .map((c: any) => ({ id: c.id, name: c.function.name, args: parseToolArgs(c.function.arguments) }));
  const usage = body?.usage ?? {};

  return {
    text: typeof message.content === 'string' ? message.content.trim() : '',
    toolCalls,
    stop: message.refusal ? 'refusal' : mapStop(choice?.finish_reason),
    model: body?.model || fallbackModel,
    usage: {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      ...(usage.completion_tokens_details?.reasoning_tokens != null ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens } : {}),
      ...(usage.prompt_tokens_details?.cached_tokens != null ? { cachedInputTokens: usage.prompt_tokens_details.cached_tokens } : {}),
    },
  };
}

async function chatCompletions(config: ChatConfig, request: ChatRequest): Promise<ChatResult> {
  const body = await postJson(config.url, config.headers, buildChatCompletionsBody(config, request), {
    label: config.label,
    timeoutMs: config.timeoutMs,
  });
  return parseChatCompletionsResult(body, config.model);
}

export type OpenAiFamily = 'openai' | 'azure_openai' | 'openai_compatible';

export function createOpenAiProvider(settings: ProviderSettings, name: OpenAiFamily = 'openai'): LlmProvider {
  const effort = normalizeEffort(settings.reasoningEffort);
  const timeoutMs = settings.timeoutMs;

  if (name === 'azure_openai') {
    if (!settings.baseUrl) throw new AiProviderError('Set the Azure OpenAI endpoint (base URL)', 400);
    if (!settings.model) throw new AiProviderError('Set the Azure OpenAI deployment name as the model', 400);
    const model = settings.model;
    const url = azureChatUrl(settings.baseUrl, model);
    const config: ChatConfig = { url, headers: { 'api-key': settings.apiKey }, model, flavor: 'azure', reasoningEffort: effort, timeoutMs, label: 'Azure OpenAI' };
    return { name, model, api: 'chat_completions', chat: (request) => chatCompletions(config, request) };
  }

  if (name === 'openai_compatible') {
    if (!settings.model) throw new AiProviderError('Set a model name for the openai_compatible provider', 400);
    if (!settings.baseUrl) throw new AiProviderError('openai_compatible needs a base URL', 400);
    const model = settings.model;
    const baseUrl = settings.baseUrl.replace(/\/+$/, '');
    const config: ChatConfig = {
      url: `${baseUrl}/chat/completions`,
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      model,
      flavor: 'compatible',
      reasoningEffort: effort,
      timeoutMs,
      label: 'The AI endpoint',
    };
    return { name, model, api: 'chat_completions', chat: (request) => chatCompletions(config, request) };
  }

  const model = settings.model || OPENAI_DEFAULT_MODEL;
  const baseUrl = (settings.baseUrl || OPENAI_BASE_URL).replace(/\/+$/, '');
  if ((process.env.OPENAI_API || '').toLowerCase() === 'chat') {
    const config: ChatConfig = {
      url: `${baseUrl}/chat/completions`,
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      model,
      flavor: 'openai',
      reasoningEffort: effort,
      timeoutMs,
      label: 'OpenAI',
    };
    return { name, model, api: 'chat_completions', chat: (request) => chatCompletions(config, request) };
  }
  return {
    name,
    model,
    api: 'responses',
    chat: (request) => responsesChat({ baseUrl, apiKey: settings.apiKey, model, reasoningEffort: effort, timeoutMs }, request),
  };
}
