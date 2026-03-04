import { saveMessage } from "./db.js";
import { createMCPClient } from "@ai-sdk/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { shellTool } from "../tools/shell.js";
import { getModel } from "./provider.js";
import { loadConfig } from "./config.js";
import { systemprompt } from "./prompt.js";
import { createLLMStream } from "./llm.js";
import { dynamicTool, jsonSchema } from "ai";
import type { ToolSet } from "ai";

export type AgentMessage = {
    role: "user" | "assistant";
    content: string;
};

export type StreamEvent =
    | { type: "text"; content: string }
    | { type: "thinking"; content: string };

async function createSafeFilesystemClient() {
    console.error("[cat-agent] Spawning filesystem MCP child...");
    const transport = new StdioClientTransport({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
        stderr: "ignore",
    });

    const client = new Client(
        { name: "cat-fs-client", version: "1.0.0" },
    );

    client.onclose = () => {
        console.error("[cat-agent] Filesystem client onclose fired");
    };

    client.onerror = (error) => {
        console.error("[cat-agent] Filesystem client onerror:", error.message);
    };

    await client.connect(transport);
    console.error("[cat-agent] Filesystem client connected successfully");
    return { client, transport };
}

function mcpToolsToAiTools(client: Client, tools: Array<{ name: string; description?: string; inputSchema: any }>): ToolSet {
    const result: ToolSet = {};

    for (const t of tools) {
        result[t.name] = dynamicTool({
            description: t.description,
            inputSchema: jsonSchema({
                ...t.inputSchema,
                properties: t.inputSchema.properties ?? {},
                additionalProperties: false,
            }),
            execute: async (args: any) => {
                console.error(`[cat-agent] Calling MCP tool: ${t.name}`);
                try {
                    const response = await client.callTool({ name: t.name, arguments: args });
                    console.error(`[cat-agent] Tool ${t.name} returned successfully`);
                    if (response.content && Array.isArray(response.content)) {
                        return (response.content as any[])
                            .filter((c: any) => c.type === "text")
                            .map((c: any) => c.text)
                            .join("\n");
                    }
                    return JSON.stringify(response);
                } catch (error: any) {
                    console.error(`[cat-agent] Tool ${t.name} error:`, error.message);
                    if (error.message?.includes("Connection closed") || error.code === -32000) {
                        return `Tool error (connection lost): ${error.message}`;
                    }
                    throw error;
                }
            },
        });
    }

    return result;
}

export async function* runAgentStream(
    prompt: string,
    history: AgentMessage[],
): AsyncGenerator<StreamEvent> {
    let fsClient: { client: Client; transport: StdioClientTransport } | null = null;
    let searchClient: any = null;

    try {
        const config = loadConfig();
        const model = getModel(config.provider, config.model);
        const exaUrl = new URL("https://mcp.exa.ai/mcp");
        const exaApiKey = config.keys.exa || process.env.EXA_API_KEY;

        if (exaApiKey) {
            exaUrl.searchParams.set("exaApiKey", exaApiKey);
        }

        console.error("[cat-agent] Starting agent stream...");
        fsClient = await createSafeFilesystemClient();
        console.error("[cat-agent] Listing filesystem tools...");
        const fsToolList = await fsClient.client.listTools();
        console.error(`[cat-agent] Got ${fsToolList.tools.length} filesystem tools`);
        const fsTools = mcpToolsToAiTools(fsClient.client, fsToolList.tools);

        console.error("[cat-agent] Connecting to Exa search...");
        searchClient = await createMCPClient({
            transport: new StreamableHTTPClientTransport(exaUrl),
        });
        console.error("[cat-agent] Exa search connected");

        const searchTools = await searchClient.tools();
        console.error(`[cat-agent] Got ${Object.keys(searchTools).length} search tools`);

        const tools: ToolSet = {
            ...fsTools,
            ...searchTools,
            shell: shellTool,
        };

        const messages: Array<{ role: "user" | "assistant"; content: string }> = [
            ...history.map((h) => ({ role: h.role, content: h.content })),
            { role: "user", content: prompt },
        ];

        const result = createLLMStream({
            model,
            system: systemprompt,
            messages,
            tools,
        });
        console.error("[cat-agent] LLM stream started");

        let fullText = "";

        for await (const part of result.fullStream) {
            switch (part.type) {
                case "text-delta":
                    fullText += part.text;
                    yield { type: "text", content: part.text };
                    break;

                case "tool-call":
                    yield { type: "thinking", content: `Using tool: ${part.toolName}` };
                    break;

                case "tool-result":
                    yield { type: "thinking", content: `Tool complete: ${part.toolName}` };
                    break;

                case "error":
                    yield { type: "text", content: `\nError: ${part.error}` };
                    break;

                default:
                    break;
            }
        }

        saveMessage("user", prompt);
        saveMessage("assistant", fullText);
        console.error("[cat-agent] Agent stream completed successfully");
    } catch (error: any) {
        console.error("[cat-agent] Agent stream error:", error.message, error.stack);
        if (
            error.name === "AbortError" ||
            error.message?.includes("CancelledError") ||
            error.message?.includes("KeyboardInterrupt") ||
            error.code === "ABORT_ERR"
        ) {
            return;
        }

        yield { type: "text", content: `Error: ${error.message}` };
    } finally {
        console.error("[cat-agent] Cleanup starting...");
        try {
            if (fsClient) {
                console.error("[cat-agent] Closing filesystem client...");
                await fsClient.client.close?.();
                console.error("[cat-agent] Filesystem client closed");
            }
        } catch (e: any) {
            console.error("[cat-agent] Filesystem client close error:", e.message);
        }
        try {
            if (searchClient) {
                console.error("[cat-agent] Closing search client...");
                await searchClient.close?.();
                console.error("[cat-agent] Search client closed");
            }
        } catch (e: any) {
            console.error("[cat-agent] Search client close error:", e.message);
        }
        console.error("[cat-agent] Cleanup complete");
    }
}
