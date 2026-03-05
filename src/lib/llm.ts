import { streamText, stepCountIs } from "ai";
import type { ToolSet, ModelMessage, LanguageModel } from "ai";

export type StreamInput = {
    model: LanguageModel;
    system: string;
    messages: ModelMessage[];
    tools: ToolSet;
    abortSignal?: AbortSignal;
    maxSteps?: number;
};

export function createLLMStream(input: StreamInput) {
    return streamText({
        model: input.model,
        system: input.system,
        messages: input.messages,
        tools: input.tools,
        abortSignal: input.abortSignal,
        stopWhen: stepCountIs(input.maxSteps ?? 20),
        async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase();
            if (lower !== failed.toolCall.toolName && input.tools[lower]) {
                return {
                    ...failed.toolCall,
                    toolName: lower,
                };
            }
            return null;
        },
    });
}
