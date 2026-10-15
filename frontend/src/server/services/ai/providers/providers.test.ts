import { describe, it, expect, vi, afterEach } from 'vitest';
import { createOpenAiProvider } from './openai';
import { createGeminiProvider } from './gemini';
import type { AiMessage, ToolSpec } from '../types';

const tool: ToolSpec = {
  name: 'get_live_status',
  description: 'Live queue status',
  parameters: { type: 'object', properties: { locationId: { type: 'string' } }, additionalProperties: false },
};

const history: AiMessage[] = [
  { role: 'user', content: 'How busy is it?' },
  { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'get_live_status', args: { locationId: 'loc1' } }] },
  { role: 'tool', results: [{ callId: 'call_1', name: 'get_live_status', content: '{"waiting":3}' }] },
];

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
  global.fetch = fn as any;
  return fn;
}

afterEach(() => vi.restoreAllMocks());

describe('OpenAI-compatible adapter', () => {
  it('sends system, tool calls and tool results in chat-completions shape', async () => {
    const fetchMock = mockFetch({
      model: 'gpt-test',
      choices: [{ finish_reason: 'stop', message: { content: '3 people are waiting.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const provider = createOpenAiProvider({ provider: 'openai_compatible', apiKey: 'k', model: 'gpt-test', baseUrl: 'https://llm.example/v1/' }, 'openai_compatible');
    const result = await provider.chat({ system: 'sys', messages: history, tools: [tool] });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://llm.example/v1/chat/completions');
    const sent = JSON.parse(init.body);
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(sent.messages[2].tool_calls[0]).toEqual({ id: 'call_1', type: 'function', function: { name: 'get_live_status', arguments: '{"locationId":"loc1"}' } });
    expect(sent.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"waiting":3}' });
    expect(sent.tools[0].function.name).toBe('get_live_status');
    // Compatible servers get the widely supported subset only.
    expect(sent.max_tokens).toBe(16000);
    expect(sent.max_completion_tokens).toBeUndefined();
    expect(sent.tools[0].function.strict).toBeUndefined();
    expect(sent.parallel_tool_calls).toBeUndefined();
    expect(result).toMatchObject({ text: '3 people are waiting.', stop: 'end', usage: { inputTokens: 10, outputTokens: 5 } });
  });

  it('parses tool calls, tolerating malformed argument JSON', async () => {
    mockFetch({
      choices: [{
        finish_reason: 'tool_calls',
        message: { content: null, tool_calls: [
          { id: 'a', type: 'function', function: { name: 'list_sites', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'get_live_status', arguments: '{bad json' } },
        ] },
      }],
    });
    const provider = createOpenAiProvider({ provider: 'openai_compatible', apiKey: 'k', model: 'm', baseUrl: 'https://llm.example/v1' }, 'openai_compatible');
    const result = await provider.chat({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: [tool] });
    expect(result.stop).toBe('tool_use');
    expect(result.toolCalls).toEqual([
      { id: 'a', name: 'list_sites', args: {} },
      { id: 'b', name: 'get_live_status', args: {} },
    ]);
  });

  it('requires a model name and base URL', () => {
    expect(() => createOpenAiProvider({ provider: 'openai_compatible', apiKey: 'k', baseUrl: 'https://x/v1' }, 'openai_compatible')).toThrow(/model/);
    expect(() => createOpenAiProvider({ provider: 'openai_compatible', apiKey: 'k', model: 'm' }, 'openai_compatible')).toThrow(/base URL/);
  });
});

describe('Gemini adapter', () => {
  it('maps function calls/responses and strips unsupported schema keywords', async () => {
    const fetchMock = mockFetch({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'list_sites', args: {} } }] } }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
    });
    const provider = createGeminiProvider({ provider: 'gemini', apiKey: 'k', model: 'gemini-test' });
    const result = await provider.chat({ system: 'sys', messages: history, tools: [tool] });

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.systemInstruction.parts[0].text).toBe('sys');
    expect(sent.contents[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'get_live_status', args: { locationId: 'loc1' } } }] });
    expect(sent.contents[2].parts[0].functionResponse).toEqual({ name: 'get_live_status', response: { content: '{"waiting":3}' } });
    expect(sent.tools[0].functionDeclarations[0].parameters.additionalProperties).toBeUndefined();
    expect(result.stop).toBe('tool_use');
    expect(result.toolCalls[0].name).toBe('list_sites');
  });

  it('reports safety blocks as refusals', async () => {
    mockFetch({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] });
    const provider = createGeminiProvider({ provider: 'gemini', apiKey: 'k', model: 'g' });
    const result = await provider.chat({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: [] });
    expect(result.stop).toBe('refusal');
  });
});
