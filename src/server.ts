import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAgentStream } from "./lib/agent.js";
import type { AgentMessage } from "./lib/agent.js";

const server = new McpServer({
    name: "cat-agent",
    version: "1.0.0",
});

server.registerTool(
    "run-task",
    {
        title: "Run Task",
        description:
            "Delegate a coding task to the Cat agent. It has access to the filesystem, shell, and web search. " +
            "It will autonomously execute the task and return results. " +
            "Use this for code generation, debugging, file editing, running commands, or any software engineering task.",
        inputSchema: z.object({
            prompt: z.string().describe("The task or instruction to execute"),
            workingDirectory: z
                .string()
                .optional()
                .describe("Working directory for the task (defaults to where the server was started)"),
            history: z
                .array(
                    z.object({
                        role: z.enum(["user", "assistant"]),
                        content: z.string(),
                    })
                )
                .optional()
                .describe("Optional conversation history for context"),
        }),
    },
    async ({ prompt, workingDirectory, history }) => {
        if (workingDirectory) {
            try {
                process.chdir(workingDirectory);
            } catch (e: any) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Error: Could not change to directory ${workingDirectory}: ${e.message}`,
                        },
                    ],
                };
            }
        }

        const agentHistory: AgentMessage[] = (history || []).map((h) => ({
            role: h.role,
            content: h.content,
        }));

        let fullResponse = "";

        try {
            for await (const event of runAgentStream(prompt, agentHistory)) {
                switch (event.type) {
                    case "text":
                        fullResponse += event.content;
                        break;
                    case "thinking":
                        fullResponse += `\n[${event.content}]\n`;
                        break;
                }
            }
        } catch (error: any) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Agent error: ${error.message}`,
                    },
                ],
            };
        }

        return {
            content: [
                {
                    type: "text" as const,
                    text: fullResponse || "(no output)",
                },
            ],
        };
    }
);

server.registerTool(
    "shell-exec",
    {
        title: "Shell Execute",
        description: "Execute a shell command directly and return the output. For quick commands that don't need the full agent.",
        inputSchema: z.object({
            command: z.string().describe("The shell command to execute"),
            cwd: z.string().optional().describe("Working directory for the command"),
        }),
    },
    async ({ command, cwd }) => {
        try {
            const proc = Bun.spawn(["sh", "-c", command], {
                cwd: cwd || process.cwd(),
                stdout: "pipe",
                stderr: "pipe",
            });

            const stdout = await new Response(proc.stdout).text();
            const stderr = await new Response(proc.stderr).text();
            const exitCode = await proc.exited;

            if (exitCode !== 0) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Command failed (exit code ${exitCode}):\n${stderr || stdout}`,
                        },
                    ],
                };
            }

            return {
                content: [
                    {
                        type: "text" as const,
                        text: stdout || "(no output)",
                    },
                ],
            };
        } catch (error: any) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Error: ${error.message}`,
                    },
                ],
            };
        }
    }
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Cat MCP server running on stdio");
}

main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
