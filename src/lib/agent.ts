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
import { existsSync } from "fs";
import { resolve } from "path";
import {
    addTodo,
    startTodo,
    completeTodo,
    failTodo,
    completeTask,
    failTask,
    isAborted,
    markTaskAborted,
    setTaskPlanning,
    setTaskRunning,
    getNextPendingTodo,
    getTaskProgress,
} from "./taskManager.js";

export type AgentMessage = {
    role: "user" | "assistant";
    content: string;
};

export type StreamEvent =
    | { type: "text"; content: string }
    | { type: "thinking"; content: string }
    | { type: "todo_created"; todoId: string; content: string }
    | { type: "todo_completed"; todoId: string; result: string }
    | { type: "todo_failed"; todoId: string; error: string }
    | { type: "task_completed"; result: string }
    | { type: "task_failed"; error: string }
    | { type: "task_aborted" };

export type TaskResult = {
    taskId: string;
    status: "completed" | "failed" | "aborted";
    result?: string;
    error?: string;
};

async function createSafeFilesystemClient(workingDirectory: string) {
    const transport = new StdioClientTransport({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", workingDirectory],
        stderr: "ignore",
    });

    const client = new Client({ name: "cat-fs-client", version: "1.0.0" });

    await client.connect(transport);
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
                try {
                    const response = await client.callTool({ name: t.name, arguments: args });
                    if (response.content && Array.isArray(response.content)) {
                        return (response.content as any[])
                            .filter((c: any) => c.type === "text")
                            .map((c: any) => c.text)
                            .join("\n");
                    }
                    return JSON.stringify(response);
                } catch (error: any) {
                    if (error.message?.includes("Connection closed") || error.code === -32000) {
                        throw new Error(`Tool ${t.name} connection lost: ${error.message}`);
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

        const cwd = process.cwd();
        fsClient = await createSafeFilesystemClient(cwd);
        const fsToolList = await fsClient.client.listTools();
        const fsTools = mcpToolsToAiTools(fsClient.client, fsToolList.tools);

        searchClient = await createMCPClient({
            transport: new StreamableHTTPClientTransport(exaUrl),
        });

        const searchTools = await searchClient.tools();

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
    } catch (error: any) {
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
        try {
            if (fsClient) {
                await fsClient.client.close?.();
            }
        } catch {
        }
        try {
            if (searchClient) {
                await searchClient.close?.();
            }
        } catch {
        }
    }
}

const PLANNING_PROMPT = `You are a task planning assistant. Given a user request, break it down into a list of actionable todo items.

Each todo should be:
- Specific and concrete
- Achievable in a single step
- Clear and unambiguous

Return your response as a JSON array of todo strings, like:
["Create project directory", "Write package.json", "Install dependencies", "Create main component"]

User request:`;

function normalizeTodos(todos: string[]): string[] {
    const cleaned = todos.map((todo) => todo.trim()).filter(Boolean);
    return Array.from(new Set(cleaned));
}

function requiresToolExecution(todoContent: string): boolean {
    return /\b(create|write|edit|update|delete|rename|move|copy|install|run|execute|build|test|search|fetch|read|list|file|folder|directory|command|script)\b/i.test(todoContent);
}

function inferExpectedFilePath(todoContent: string, workingDirectory: string): string | null {
    const fileNameMatch = todoContent.match(/\bfile called\s+["']?([^"'\s]+)["']?/i);
    if (!fileNameMatch) {
        return null;
    }

    const fileName = fileNameMatch[1] ?? "";
    if (!fileName) {
        return null;
    }
    const inMatch = todoContent.match(/\bin\s+(.+)$/i);
    const rawDir = inMatch?.[1]?.trim().replace(/[.]+$/, "");

    if (!rawDir) {
        return resolve(workingDirectory, fileName);
    }

    if (rawDir.startsWith("/")) {
        return resolve(rawDir, fileName);
    }

    return resolve(workingDirectory, rawDir, fileName);
}

export async function planTask(prompt: string): Promise<string[]> {
    const config = loadConfig();
    const model = getModel(config.provider, config.model);

    const messages = [
        { role: "user" as const, content: PLANNING_PROMPT + "\n\n" + prompt }
    ];

    const result = createLLMStream({
        model,
        system: "You are a task planning assistant. Return ONLY a JSON array of todo strings, nothing else.",
        messages,
        tools: {},
    });

    let fullText = "";
    for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
            fullText += part.text;
        }
    }

    try {
        const jsonMatch = fullText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const todos = JSON.parse(jsonMatch[0]);
            if (Array.isArray(todos)) {
                return normalizeTodos(todos.map((todo) => String(todo)));
            }
        }
    } catch {
    }

    return normalizeTodos([prompt]);
}

export async function* runTaskWithTodos(
    taskId: string,
    prompt: string,
    workingDirectory: string,
): AsyncGenerator<StreamEvent> {
    setTaskPlanning(taskId);
    
    const todoList = await planTask(prompt);
    
    for (const todo of todoList) {
        addTodo(taskId, todo);
    }

    setTaskRunning(taskId);

    let fullResult = "";

    while (true) {
        if (isAborted(taskId)) {
            yield { type: "text", content: "\nTask aborted by user." };
            markTaskAborted(taskId);
            return;
        }

        const nextTodo = getNextPendingTodo(taskId);
        if (!nextTodo) {
            break;
        }

        startTodo(taskId, nextTodo.id);
        
        yield { type: "thinking", content: `Executing: ${nextTodo.content}` };

        try {
            const result = await executeTodo(nextTodo.content, workingDirectory);
            completeTodo(nextTodo.id, result);
            fullResult += `\n\n# ${nextTodo.content}\n${result}`;
        } catch (error: any) {
            failTodo(nextTodo.id, error.message);
            yield { type: "text", content: `\nError in '${nextTodo.content}': ${error.message}` };
            
            const progress = getTaskProgress(taskId);
            if (progress && progress.pendingTodos.length > 0) {
                yield { type: "thinking", content: "Continuing with remaining tasks..." };
                continue;
            }
            break;
        }
    }

    const progress = getTaskProgress(taskId);
    if (progress) {
        const completedCount = progress.completedTodos.length;
        const failedCount = progress.failedTodos.length;
        
        if (failedCount > 0) {
            yield { type: "text", content: `\n\nTask completed with ${failedCount} failed item(s).` };
            failTask(taskId, `${failedCount} items failed`);
        } else {
            yield { type: "text", content: `\n\nTask completed successfully! (${completedCount} items)` };
            completeTask(taskId, fullResult);
        }
    }
}

async function executeTodo(todoContent: string, workingDirectory: string): Promise<string> {
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

        fsClient = await createSafeFilesystemClient(workingDirectory);
        const fsToolList = await fsClient.client.listTools();
        const fsTools = mcpToolsToAiTools(fsClient.client, fsToolList.tools);

        searchClient = await createMCPClient({
            transport: new StreamableHTTPClientTransport(exaUrl),
        });
        const searchTools = await searchClient.tools();

        const scopedShellTool = dynamicTool({
            description: "Execute a shell command in the terminal",
            inputSchema: jsonSchema({
                type: "object",
                properties: {
                    command: { type: "string" },
                    cwd: { type: "string" },
                },
                required: ["command"],
                additionalProperties: false,
            }),
            execute: async (args: any) => {
                const proc = Bun.spawn(["sh", "-c", args.command], {
                    cwd: args.cwd ?? workingDirectory,
                    stdout: "pipe",
                    stderr: "pipe",
                });

                const stdout = await new Response(proc.stdout).text();
                const stderr = await new Response(proc.stderr).text();
                const exitCode = await proc.exited;

                if (exitCode !== 0) {
                    return `Command failed (exit code ${exitCode}):\n${stderr || stdout}`;
                }

                return stdout || "(no output)";
            },
        });

        const tools: ToolSet = {
            ...fsTools,
            ...searchTools,
            shell: scopedShellTool,
        };

        const messages = [
            {
                role: "user" as const,
                content:
                    `${todoContent}\n\n` +
                    `Requirements:\n` +
                    `- Use tools to perform real actions.\n` +
                    `- Do not claim success without executing and verifying.\n` +
                    `- If you create or edit files, verify by reading/listing them before final response.`,
            }
        ];

        const result = createLLMStream({
            model,
            system: systemprompt,
            messages,
            tools,
            maxSteps: 40,
        });

        let fullText = "";
        let toolCallCount = 0;
        for await (const part of result.fullStream) {
            switch (part.type) {
                case "text-delta":
                    fullText += part.text;
                    break;
                case "tool-call":
                    toolCallCount += 1;
                    break;
                default:
                    break;
            }
        }

        const needsTools = requiresToolExecution(todoContent);
        if (needsTools && toolCallCount === 0) {
            throw new Error("No tool calls were made for a task that requires execution.");
        }

        const expectedFilePath = inferExpectedFilePath(todoContent, workingDirectory);
        if (expectedFilePath && !existsSync(expectedFilePath)) {
            throw new Error(`Expected file was not created: ${expectedFilePath}`);
        }

        const output = fullText.trim();
        if (!output) {
            throw new Error("Task produced no output.");
        }

        return output;
    } finally {
        try {
            if (fsClient) await fsClient.client.close?.();
        } catch (e) {}
        try {
            if (searchClient) await searchClient.close?.();
        } catch (e) {}
    }
}
