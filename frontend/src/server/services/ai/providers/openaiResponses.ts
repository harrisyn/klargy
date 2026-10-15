import type { AiMessage, ChatRequest, ChatResult, StopReason, ToolCall, ToolSpec } from '../types';
import { AiProviderError } from '../types';
import { postJson } from './http';
import { isReasoningModel, parseToolArgs, toStrictSchema } from './openaiCommon';

// OpenAI Responses API (POST /v1/responses), OpenAI's recommended API for
// tool-using agents on api.openai.com. Runs stateless (`store: false`): each
// turn sends the whole conversation, and reasoning models return their
// reasoning as encrypted items that are replayed verbatim on the next turn so
// the model keeps its chain of thought across tool calls without OpenAI
// retaining the conversation.

export interface ResponsesConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort: string | null;
  timeoutMs?: number | null;
}

type InputItem = Record<string, unknown>;

function isOutputItemList(raw: unknown): raw is InputItem[] {
  return Array.isArray(raw) && raw.every((item) => item && typeof item === 'object' && typeof (item as InputItem).type === 'string');
}

export function toResponsesInput(messages: AiMessage[]): InputItem[] {
  const input: InputItem[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      input.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      if (m.rawProvider === 'openai' && isOutputItemList(m.raw)) {
        // Replay this turn's output items (reasoning, message, function_call)
        // unchanged. Reasoning items without encrypted content can't be
        // resolved when store is false, so they are dropped.
        for (const item of m.raw) {
          if (item.type === 'reasoning' && !item.encrypted_content) continue;
          input.push(item);
        }
      } else {
        if (m.text) input.push({ role: 'assistant', content: m.text });
        for (const call of m.toolCalls) {
          input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) });
        }
      }
    } else {
      for (const r of m.results) input.push({ type: 'function_call_output', call_id: r.callId, output: r.content });
    }
  }
  return input;
}

export function toResponsesTool(tool: ToolSpec): InputItem {
  const strict = toStrictSchema(tool.parameters);
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: strict ?? tool.parameters,
    strict: !!strict,
  };
}

export function buildResponsesBody(config: ResponsesConfig, request: ChatRequest): Record<string, unknown> {
  const reasoning = isReasoningModel(config.model);
  return {
    model: config.model,
    instructions: request.system,
    input: toResponsesInput(request.messages),
    ...(request.tools.length
      ? {
          tools: request.tools.map(toResponsesTool),
          // The agent runs a turn's calls concurrently, so let the model batch them.
          parallel_tool_calls: true,
        }
      : {}),
    max_output_tokens: request.maxTokens ?? 16000,
    store: false,
    // No temperature/top_p: reasoning models reject non-default values and the
    // agent doesn't need them.
    ...(reasoning
      ? {
          include: ['reasoning.encrypted_content'],
          ...(config.reasoningEffort ? { reasoning: { effort: config.reasoningEffort } } : {}),
        }
      : {}),
  };
}

export function parseResponsesResult(body: any, fallbackModel: string): ChatResult {
  if (body?.status === 'failed') {
    throw new AiProviderError(`OpenAI API error: ${body?.error?.message || 'the response failed'}`, 502);
  }
  const output: InputItem[] = Array.isArray(body?.output) ? body.output : [];
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  let refused = false;

  for (const item of output) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content as InputItem[]) {
        if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
        else if (part.type === 'refusal') refused = true;
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({ id: String(item.call_id ?? item.id), name: String(item.name), args: parseToolArgs(item.arguments) });
    }
  }

  let stop: StopReason;
  const incomplete = body?.incomplete_details?.reason;
  if (refused) stop = 'refusal';
  else if (toolCalls.length) stop = 'tool_use';
  else if (body?.status === 'incomplete') stop = incomplete === 'max_output_tokens' ? 'length' : incomplete === 'content_filter' ? 'refusal' : 'other';
  else if (body?.status === 'completed' || body?.status === undefined) stop = 'end';
  else stop = 'other';

  const usage = body?.usage ?? {};
  return {
    text: texts.join('\n').trim(),
    toolCalls,
    stop,
    model: body?.model || fallbackModel,
    usage: {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      ...(usage.output_tokens_details?.reasoning_tokens != null ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens } : {}),
      ...(usage.input_tokens_details?.cached_tokens != null ? { cachedInputTokens: usage.input_tokens_details.cached_tokens } : {}),
    },
    raw: output,
  };
}

export async function responsesChat(config: ResponsesConfig, request: ChatRequest): Promise<ChatResult> {
  const body = await postJson(
    `${config.baseUrl}/responses`,
    { Authorization: `Bearer ${config.apiKey}` },
    buildResponsesBody(config, request),
    { label: 'OpenAI', timeoutMs: config.timeoutMs }
  );
  return parseResponsesResult(body, config.model);
}
