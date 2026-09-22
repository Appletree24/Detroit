import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { DriverRequest, Message, ModelResponse, Variant } from "../contracts";
import type { toolSchemas } from "./tools";

export type ModelRequest = {
  model: string;
  messages: Message[];
  tools: typeof toolSchemas;
  temperature: number;
  max_completion_tokens: number;
  stream: false;
};
export interface ModelAdapter {
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}
export class ScriptedModel implements ModelAdapter {
  private index = 0;
  constructor(private responses: NonNullable<DriverRequest["script"]>) {}
  async complete(_request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    signal.throwIfAborted();
    const next = this.responses[this.index++];
    if (!next) throw new Error("Script exhausted without final response");
    return { id: `synthetic-${this.index}`, ...next, usage: null };
  }
}
export function openAIRequest(request: ModelRequest) {
  const messages: ChatCompletionMessageParam[] = request.messages.map((m) => {
    if (m.role === "assistant")
      return {
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                type: "function" as const,
                id: c.id,
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      };
    if (m.role === "tool") return { role: "tool", content: m.content, tool_call_id: m.callId };
    return m;
  });
  return { ...request, messages };
}
export class OpenAIModel implements ModelAdapter {
  private client: OpenAI;
  constructor(variant: Variant, apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: variant.baseURL,
      maxRetries: 0,
      timeout: variant.budgets.deadlineMs,
    });
  }
  async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    // M1 intentionally uses complete, non-streaming responses. Partial responses
    // never reach the executor; SDK retries are disabled and errors end the run.
    const response = await this.client.chat.completions.create(openAIRequest(request), { signal });
    const choice = response.choices[0];
    if (!choice || !["stop", "tool_calls"].includes(choice.finish_reason))
      throw new Error(`Incomplete model response: ${choice?.finish_reason}`);
    const calls = (choice.message.tool_calls ?? []).map((call) => {
      if (call.type !== "function") throw new Error("Unsupported non-function tool");
      return { id: call.id, name: call.function.name, arguments: call.function.arguments };
    });
    return {
      id: response.id,
      content: choice.message.content ?? "",
      toolCalls: calls,
      usage: response.usage
        ? {
            input: response.usage.prompt_tokens,
            output: response.usage.completion_tokens,
            source: "provider",
          }
        : null,
    };
  }
}
