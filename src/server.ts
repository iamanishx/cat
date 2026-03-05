import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runTaskWithTodos } from "./lib/agent.js";
import { startTask, getTaskProgress, abortTask, failTask } from "./lib/taskManager.js";

const server = new McpServer({
    name: "cat-agent",
    version: "1.0.0",
});

// Track active background tasks so we can defer process exit until they finish.
let activeTasks = 0;
let shuttingDown = false;

function maybeExit() {
    if (shuttingDown && activeTasks === 0) {
        process.exit(0);
    }
}

function handleShutdown() {
    shuttingDown = true;
    maybeExit();
    // Hard exit after 10 minutes regardless.
    setTimeout(() => process.exit(0), 10 * 60 * 1000).unref();
}

server.registerTool(
    "run_task",
    {
        title: "Run Task",
        description:
            "Delegate a coding task to the Cat agent. It has access to the filesystem, shell, and web search. " +
            "It will autonomously execute the task and return results. " +
            "Use this for code generation, debugging, file editing, running commands, or any software engineering task. " +
            "This tool returns immediately with a task ID that can be used to poll for progress.",
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
    async ({ prompt, workingDirectory }) => {
        const cwd = workingDirectory || process.cwd();
        
        const task = startTask(prompt, cwd);
        
        activeTasks++;
        setImmediate(async () => {
            try {
                for await (const _event of runTaskWithTodos(task.id, prompt, cwd)) {
                }
            } catch (error: any) {
                failTask(task.id, error?.message || "Task execution failed");
            } finally {
                activeTasks--;
                maybeExit();
            }
        });
        
        return {
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify({
                        taskId: task.id,
                        status: "planning",
                        message: "Task created. Use get_progress to check status.",
                    }),
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

server.registerTool(
    "get_progress",
    {
        title: "Get Task Progress",
        description: "Poll for the status of a running task. Returns completed, pending, and failed todos.",
        inputSchema: z.object({
            taskId: z.string().describe("The task ID returned from run_task"),
        }),
    },
    async ({ taskId }) => {
        const progress = getTaskProgress(taskId);
        
        if (!progress) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({ error: "Task not found" }),
                    },
                ],
            };
        }
        
        return {
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify({
                        taskId: progress.taskId,
                        status: progress.status,
                        currentTodo: progress.currentTodo,
                        completedTodos: progress.completedTodos,
                        pendingTodos: progress.pendingTodos,
                        failedTodos: progress.failedTodos,
                        result: progress.result,
                        error: progress.error,
                    }),
                },
            ],
        };
    }
);

server.registerTool(
    "abort_task",
    {
        title: "Abort Task",
        description: "Abort a running task by its ID.",
        inputSchema: z.object({
            taskId: z.string().describe("The task ID to abort"),
        }),
    },
    async ({ taskId }) => {
        const success = abortTask(taskId);
        
        return {
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify({
                        success,
                        taskId,
                        message: success ? "Task aborted" : "Task not found or already completed",
                    }),
                },
            ],
        };
    }
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Keep the process alive while background tasks are running.
    // KiloCode/Cursor close stdin (and send SIGTERM) when they restart the server,
    // but background tasks must be allowed to finish writing to SQLite first.
    const keepAlive = setInterval(() => {}, 30_000);

    process.on("SIGTERM", () => {
        clearInterval(keepAlive);
        handleShutdown();
    });

    process.on("SIGINT", () => {
        clearInterval(keepAlive);
        handleShutdown();
    });

    process.stdin.on("end", () => {
        clearInterval(keepAlive);
        handleShutdown();
    });
}

main().catch(() => {
    process.exit(1);
});
