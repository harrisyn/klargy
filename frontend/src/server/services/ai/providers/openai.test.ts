import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOpenAiProvider } from './openai';
import { azureChatUrl, isReasoningModel, OPENAI_DEFAULT_MODEL, parseToolArgs, toStrictSchema } from './openaiCommon';
import { retryAfterMs, sleep } from './http';
import { AiProviderError } from '../types';
import type { AiMessage, ToolSpec } from '../types';

const tool: ToolSpec = {
  name: 'get_period_summary',
  description: 'Totals for a date range',
  parameters: {
    type: 'object',
    properties: { locationId: { type: 'string' }, days: { type: 'integer', minimum: 1, maximum: 90 } },
    required: ['locationId'],
    additionalProperties: false,
  },
};

const history: AiMessage[] = [
  { role: 'user', content: 'How busy is it?' },
  { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'get_period_summary', args: { locationId: 'loc1' } }] },
  { role: 'tool', results: [{ callId: 'call_1', name: 'get_period_summary', content: '{"waiting":3}' }] },
];

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status < 400, status, json: async () => body, headers: { get: (name: string) => lower[name.toLowerCase()] ?? null } };
}

function mockFetch(...responses: ReturnType<typeof response>[]) {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fn);
  return fn;
}

const sent = (fetchMock: ReturnType<typeof vi.fn>, call = 0) => JSON.parse(fetchMock.mock.calls[call][1].body);

const completed = (output: unknown[], extra: Record<string, unknown> = {}) => ({
  status: 'completed',
  model: 'gpt-5-mini-2025-08-07',
  output,
  usage: { input_tokens: 120, output_tokens: 40, output_tokens_details: { reasoning_tokens: 30 }, input_tokens_details: { cached_tokens: 64 } },
  ...extra,
});

const realSleep = sleep.fn;
beforeEach(() => {
  sleep.fn = vi.fn(async () => {});
  delete process.env.OPENAI_API;
});
afterEach(() => {
  sleep.fn = realSleep;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OpenAI (Responses API)', () => {
  it('sends a stateless Responses request with strict, parallel function tools', async () => {
    const fetchMock = mockFetch(response(completed([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '3 people are waiting.' }] }])));
    const provider = createOpenAiProvider({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-4.1' });
    expect(provider.api).toBe('responses');
    const result = await provider.chat({ system: 'sys', messages: history, tools: [tool] });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    const body = sent(fetchMock);
    expect(body.instructions).toBe('sys');
    expect(body.input).toEqual([
      { role: 'user', content: 'How busy is it?' },
      { type: 'function_call', call_id: 'call_1', name: 'get_period_summary', arguments: '{"locationId":"loc1"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"waiting":3}' },
    ]);
    expect(body.tools[0]).toEqual({
      type: 'function',
      name: 'get_period_summary',
      description: 'Totals for a date range',
      strict: true,
      parameters: {
        type: 'object',
        properties: { locationId: { type: 'string' }, days: { type: ['integer', 'null'], minimum: 1, maximum: 90 } },
        required: ['locationId', 'days'],
        additionalProperties: false,
      },
    });
    expect(body).toMatchObject({ parallel_tool_calls: true, max_output_tokens: 16000, store: false });
    for (const key of ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'reasoning', 'include']) expect(body[key]).toBeUndefined();

    expect(result).toMatchObject({
      text: '3 people are waiting.',
      stop: 'end',
      model: 'gpt-5-mini-2025-08-07',
      usage: { inputTokens: 120, outputTokens: 40, reasoningTokens: 30, cachedInputTokens: 64 },
    });
  });

  it('asks reasoning models for encrypted reasoning and the configured effort', async () => {
    const fetchMock = mockFetch(response(completed([])));
    const provider = createOpenAiProvider({ provider: 'openai', apiKey: 'k', model: 'gpt-5', reasoningEffort: 'LOW' });
    await provider.chat({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: [] });
    const body = sent(fetchMock);
    expect(body.include).toEqual(['reasoning.encrypted_content']);
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.tools).toBeUndefined();
    expect(body.parallel_tool_calls).toBeUndefined();
  });

  it('defaults the model and ignores an unknown effort', async () => {
    const fetchMock = mockFetch(response(completed([])));
    const provider = createOpenAiProvider({ provider: 'openai', apiKey: 'k', reasoningEffort: 'turbo' });
    expect(provider.model).toBe(OPENAI_DEFAULT_MODEL);
    await provider.chat({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: [] });
    expect(sent(fetchMock).reasoning).toBeUndefined();
  });

  it('parses parallel function calls, drops strict-mode nulls and replays the output items next turn', async () => {
    const output = [
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAA...' },
      { type: 'reasoning', id: 'rs_2', summary: [] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'list_sites', arguments: '{}', status: 'completed' },
      { type: 'function_call', id: 'fc_2', call_id: 'call_b', name: 'get_period_summary', arguments: '{"locationId":"loc1","days":null}', status: 'completed' },
    ];
    const fetchMock = mockFetch(response(completed(output)), response(completed([{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }])));
    const provider = createOpenAiProvider({ provider: 'openai', apiKey: 'k', model: 'gpt-5' });

    const first = await provider.chat({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: [tool] });
    expect(first.stop).toBe('tool_use');
    expect(first.toolCalls).toEqual([
      { id: 'call_a', name: 'list_sites', args: {} },
      { id: 'call_b', name: 'get_period_summary', args: { locationId: 'loc1' } },
    ]);

    const messages: AiMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', text: first.text, toolCalls: first.toolCalls, raw: first.raw, rawProvider: 'openai' },
      { role: 'tool', results: [
        { callId: 'call_a', name: 'list_sites', content: '[]' },
        { callId: 'call_b', name: 'get_period_summary', content: '{}' },
      ] },
    ];
    await provider.chat({ system: 's', messages, tools: [tool] });
    const input = sent(fetchMock, 1).input;
    expect(input).toEqual([
      { role: 'user', content: 'q' },
      output[0],
      output[2],
      output[3],
      { type: 'function_call_output', call_id: 'call_a', output: '[]' },
      { type: 'function_call_output', call_id: 'call_b', output: '{}' },
    ]);
  });

  it('reports refusals and truncation', async () => {
    mockFetch(
      response(completed([{ type: 'message', content: [{ type: 'refusal', refusal: "I can't help with that." }] }])),
      response({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning', id: 'rs', summary: [] }], usage: { input_tokens: 5, output_tokens: 64 } })
    );
    const provider = createOpenAiProvider({ provider: 'openai', apiKey: 'k', model: 'gpt-5' });
    const req = { system: 's', messages: [{ role: 'user' as const, content: 'q' }], tools: [] };
    expect((await provider.chat(req)).stop).toBe('refusal');
    const truncated = await provider.chat(req);
    expect(truncated).toMatchObject({ stop: 'length', text: '', usage: { inputTokens: 5, outputTokens: 64 } });
  });

  it('can fall back to Chat Completions with OPENAI_API=chat', async () => {
    process.env.OPENAI_API = 'chat';
    const fetchMock = mockFetch(response({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'No.' } }], usage: { prompt_tokens: 3, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 1 } } }));
    const provider = createOpenAiProvider({ provider: 'openai', apiKey: 'k', model: 'o4-mini', reasoningEffort: 'high' });
    expect(provider.api).toBe('chat_completions');
    const result = await provider.chat({ system: 's', messages: history, tools: [tool] });

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
    const body = sent(fetchMock);
    expect(body).toMatchObject({ max_completion_tokens: 16000, reasoning_effort: 'high', parallel_tool_calls: true });
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.tools[0].function.strict).toBe(true);
    expect(body.tools[0].function.parameters.required).toEqual(['locationId', 'days']);
    expect(result).toMatchObject({ stop: 'refusal', usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 1 } });
  });
});

describe('Azure OpenAI (Chat Completions)', () => {
  it('calls the v1 endpoint with the deployment as model and an api-key header', async () => {
    const fetchMock = mockFetch(response({ choices: [{ finish_reason: 'stop', message: { content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const provider = createOpenAiProvider(
      { provider: 'azure_openai', apiKey: 'az-key', model: 'my-gpt5', baseUrl: 'https://res.openai.azure.com/', reasoningEffort: 'minimal' },
      'azure_openai'
    );
    const result = await provider.chat({ system: 's', messages: history, tools: [tool] });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://res.openai.azure.com/openai/v1/chat/completions');
    expect(init.headers['api-key']).toBe('az-key');
    expect(init.headers.Authorization).toBeUndefined();
    const body = sent(fetchMock);
    expect(body).toMatchObject({ model: 'my-gpt5', max_completion_tokens: 16000, parallel_tool_calls: true, reasoning_effort: 'minimal' });
    expect(body.tools[0].function.strict).toBe(true);
    expect(result.text).toBe('OK');
  });

  it('uses the classic deployment route when an api-version is given', () => {
    expect(azureChatUrl('https://res.openai.azure.com?api-version=2024-10-21', 'dep 1')).toBe(
      'https://res.openai.azure.com/openai/deployments/dep%201/chat/completions?api-version=2024-10-21'
    );
    expect(azureChatUrl('https://res.openai.azure.com/openai/v1/', 'dep')).toBe('https://res.openai.azure.com/openai/v1/chat/completions');
    expect(() => azureChatUrl('not a url', 'dep')).toThrow(/endpoint/);
  });

  it('needs an endpoint and a deployment', () => {
    expect(() => createOpenAiProvider({ provider: 'azure_openai', apiKey: 'k', model: 'd' }, 'azure_openai')).toThrow(/endpoint/);
    expect(() => createOpenAiProvider({ provider: 'azure_openai', apiKey: 'k', baseUrl: 'https://r.openai.azure.com' }, 'azure_openai')).toThrow(/deployment/);
  });
});

describe('retries, timeouts and errors', () => {
  const req = { system: 's', messages: [{ role: 'user' as const, content: 'q' }], tools: [] };
  const provider = () => createOpenAiProvider({ provider: 'openai', apiKey: 'k', model: 'gpt-5-mini' });

  it('retries a 429 after the Retry-After delay', async () => {
    const fetchMock = mockFetch(
      response({ error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }, 429, { 'Retry-After': '2' }),
      response(completed([]))
    );
    await provider().chat(req);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep.fn).toHaveBeenCalledWith(2000);
  });

  it('retries 5xx with backoff, then gives up with a 502', async () => {
    const fetchMock = mockFetch(response({}, 500), response({}, 503), response({ error: { message: 'overloaded' } }, 503));
    const error = await provider().chat(req).catch((e) => e);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error.status).toBe(502);
  });

  it('does not retry quota errors, auth errors or long Retry-After waits', async () => {
    let fetchMock = mockFetch(response({ error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } }, 429));
    let error = await provider().chat(req).catch((e) => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ status: 429, message: expect.stringMatching(/quota/) });

    fetchMock = mockFetch(response({ error: { message: 'Incorrect API key provided' } }, 401));
    error = await provider().chat(req).catch((e) => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ status: 400, message: expect.stringMatching(/API key/) });

    fetchMock = mockFetch(response({}, 429, { 'retry-after': '120' }));
    error = await provider().chat(req).catch((e) => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.status).toBe(429);
  });

  it('reports an unknown model clearly', async () => {
    mockFetch(response({ error: { message: 'The model `gpt-9` does not exist or you do not have access to it.', code: 'model_not_found' } }, 404));
    const error = await provider().chat(req).catch((e) => e);
    expect(error).toMatchObject({ status: 400, message: expect.stringMatching(/model/) });
  });

  it('retries network errors but not timeouts', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(response(completed([])));
    vi.stubGlobal('fetch', fetchMock);
    await provider().chat(req);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const timeout = vi.fn().mockRejectedValue(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }));
    vi.stubGlobal('fetch', timeout);
    const error = await createOpenAiProvider({ provider: 'openai', apiKey: 'k', model: 'gpt-5', timeoutMs: 5000 }).chat(req).catch((e) => e);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ status: 504, message: expect.stringMatching(/5s/) });
  });

  it('reads Retry-After in seconds, milliseconds and HTTP-date form', () => {
    const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n] ?? null });
    expect(retryAfterMs(headers({ 'retry-after': '3' }))).toBe(3000);
    expect(retryAfterMs(headers({ 'retry-after-ms': '250', 'retry-after': '3' }))).toBe(250);
    const inTwoSeconds = new Date(Date.now() + 2000).toUTCString();
    expect(retryAfterMs(headers({ 'retry-after': inTwoSeconds }))).toBeGreaterThan(0);
    expect(retryAfterMs(headers({}))).toBeNull();
    expect(retryAfterMs(undefined)).toBeNull();
  });
});

describe('OpenAI helpers', () => {
  it('recognizes reasoning models', () => {
    for (const m of ['o3', 'o4-mini', 'gpt-5', 'gpt-5-mini', 'gpt-5.1', 'openai/gpt-5', 'gpt-oss-120b']) expect(isReasoningModel(m)).toBe(true);
    for (const m of ['gpt-4.1', 'gpt-4o-mini', 'gpt-5-chat-latest', 'mistral-large-latest', 'llama3']) expect(isReasoningModel(m)).toBe(false);
  });

  it('falls back to non-strict for schemas strict mode cannot express', () => {
    expect(toStrictSchema({ type: 'object', properties: { anything: {} } })).toBeNull();
    expect(toStrictSchema({ type: 'object', properties: {} })).toEqual({ type: 'object', properties: {}, required: [], additionalProperties: false });
  });

  it('parses tool arguments defensively', () => {
    expect(parseToolArgs('{bad')).toEqual({});
    expect(parseToolArgs('[1]')).toEqual({});
    expect(parseToolArgs('{"a":1,"b":null}')).toEqual({ a: 1 });
  });
});
