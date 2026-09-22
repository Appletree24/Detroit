import type { Budgets, Message } from "../contracts";
import { toolSchemas } from "./tools";

export function validatePairs(history: Message[]): void {
  let pending = new Set<string>();
  const seen = new Set<string>();
  for (const message of history) {
    if (message.role === "tool") {
      if (!pending.delete(message.callId)) throw new Error("Orphan or duplicate tool result");
    } else {
      if (pending.size) throw new Error("Unresolved tool calls");
      if (message.role === "assistant") {
        pending = new Set();
        for (const call of message.toolCalls) {
          if (seen.has(call.id)) throw new Error("Duplicate tool call ID");
          pending.add(call.id);
          seen.add(call.id);
        }
      }
    }
  }
  if (pending.size) throw new Error("Unresolved tool calls");
}
export function buildContext(history: Message[], budgets: Budgets) {
  validatePairs(history);
  // A conservative UTF-8 byte estimate, not a provider tokenizer.
  const estimatedTokens =
    Buffer.byteLength(JSON.stringify({ messages: history, tools: toolSchemas }), "utf8") + 128;
  if (estimatedTokens + budgets.outputTokens + budgets.safetyTokens > budgets.contextTokens)
    throw new Error("context_budget_exceeded");
  return {
    messages: structuredClone(history),
    manifest: {
      strategy: "full-history/1",
      estimator: "utf8-bytes-plus-128",
      estimatedTokens,
      retainedMessages: history.length,
      removedMessages: 0,
    },
  };
}
