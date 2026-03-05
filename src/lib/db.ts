import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

const CAT_DIR = join(homedir(), ".cat");
if (!existsSync(CAT_DIR)) {
    mkdirSync(CAT_DIR, { recursive: true });
}

const DB_PATH = join(CAT_DIR, "cat.db");
const db = new Database(DB_PATH);

const currentDir = process.cwd();

let currentSessionId = createHash("sha256").update(currentDir).digest("hex").slice(0, 16);

export function getSessionId(): string {
    return currentSessionId;
}

export function setSessionId(id: string) {
    currentSessionId = id;
}

db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_message_at DATETIME
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_session ON messages(session_id)`);

function ensureSession(sessionId: string, path: string) {
    const existing = db.query("SELECT id FROM sessions WHERE id = ?").get(sessionId);
    if (!existing) {
        db.run("INSERT INTO sessions (id, path) VALUES (?, ?)", [sessionId, path]);
    }
}

export type Message = {
    id: number;
    session_id: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at: string;
};

export type Session = {
    id: string;
    path: string;
    name: string | null;
    message_count: number;
    last_message_at: string;
};

export function saveMessage(role: "user" | "assistant" | "system", content: string) {
    ensureSession(currentSessionId, currentDir);
    db.run("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)", [
        currentSessionId,
        role,
        content,
    ]);
    db.run("UPDATE sessions SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?", [currentSessionId]);
}

export function getRecentMessages(limit: number = 50): Message[] {
    const query = db.query(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?"
    );
    const messages = query.all(currentSessionId, limit) as Message[];
    return messages.reverse();
}

export function getCurrentDirSessions(): Session[] {
    const query = db.query(`
    SELECT s.id, s.path, s.name, s.last_message_at,
           (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as message_count
    FROM sessions s
    WHERE s.path = ?
    ORDER BY s.last_message_at DESC
  `);
    return query.all(currentDir) as Session[];
}

export function getOtherDirSessions(): Session[] {
    const query = db.query(`
    SELECT s.id, s.path, s.name, s.last_message_at,
           (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as message_count
    FROM sessions s
    WHERE s.path != ?
    ORDER BY s.last_message_at DESC
  `);
    return query.all(currentDir) as Session[];
}

export function getSessionMessages(sessionId: string, limit: number = 50): Message[] {
    const query = db.query(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?"
    );
    const messages = query.all(sessionId, limit) as Message[];
    return messages.reverse();
}

export function createNewSession(): string {
    const newId = createHash("sha256")
        .update(currentDir + Date.now().toString())
        .digest("hex")
        .slice(0, 16);
    
    const countQuery = db.query("SELECT COUNT(*) as count FROM sessions WHERE path = ?");
    const result = countQuery.get(currentDir) as { count: number };
    const sessionName = `Session ${result.count + 1}`;

    db.run("INSERT INTO sessions (id, path, name) VALUES (?, ?, ?)", [newId, currentDir, sessionName]);
    currentSessionId = newId;
    return newId;
}

export const TASK_STATUS = {
    PENDING: "pending",
    PLANNING: "planning",
    RUNNING: "running",
    COMPLETED: "completed",
    FAILED: "failed",
    ABORTED: "aborted",
} as const;

export const TODO_STATUS = {
    PENDING: "pending",
    IN_PROGRESS: "in_progress",
    COMPLETED: "completed",
    FAILED: "failed",
    SKIPPED: "skipped",
} as const;

export type TaskStatus = "planning" | "running" | "completed" | "failed" | "aborted";

export type TaskTodoStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export type TaskTodo = {
    id: string;
    task_id: string;
    content: string;
    status: TaskTodoStatus;
    result?: string;
    error?: string;
    created_at: string;
    updated_at: string;
};

export type Task = {
    id: string;
    prompt: string;
    working_directory: string;
    status: TaskStatus;
    current_todo_id: string | null;
    result: string | null;
    error: string | null;
    created_at: string;
    updated_at: string;
};

db.run(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    working_directory TEXT,
    status TEXT DEFAULT 'planning',
    current_todo_id TEXT,
    result TEXT,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS task_todos (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    result TEXT,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_task_todos_task_id ON task_todos(task_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);

db.run(`
  CREATE TABLE IF NOT EXISTS task_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT,
    todo_id TEXT,
    phase TEXT NOT NULL,
    message TEXT NOT NULL,
    stack TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_task_errors_task_id ON task_errors(task_id)`);

function generateId(): string {
    return createHash("sha256").update(Date.now().toString() + Math.random().toString()).digest("hex").slice(0, 16);
}

export function createTask(prompt: string, workingDirectory: string = currentDir): Task {
    const taskId = generateId();
    db.run(
        "INSERT INTO tasks (id, prompt, working_directory, status) VALUES (?, ?, ?, ?)",
        [taskId, prompt, workingDirectory, "planning"]
    );
    return getTask(taskId)!;
}

export function getTask(id: string): Task | undefined {
    const query = db.query("SELECT * FROM tasks WHERE id = ?");
    return query.get(id) as Task | undefined;
}

export function updateTaskStatus(id: string, status: TaskStatus, result?: string, error?: string): void {
    db.run(
        "UPDATE tasks SET status = ?, result = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [status, result || null, error || null, id]
    );
}

export function setCurrentTodo(taskId: string, todoId: string | null): void {
    db.run(
        "UPDATE tasks SET current_todo_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [todoId, taskId]
    );
}

export function getTaskTodos(taskId: string): TaskTodo[] {
    const query = db.query("SELECT * FROM task_todos WHERE task_id = ? ORDER BY id ASC");
    return query.all(taskId) as TaskTodo[];
}

export function createTaskTodo(taskId: string, content: string): TaskTodo {
    const todoId = generateId();
    db.run(
        "INSERT INTO task_todos (id, task_id, content, status) VALUES (?, ?, ?, ?)",
        [todoId, taskId, content, "pending"]
    );
    const query = db.query("SELECT * FROM task_todos WHERE id = ?");
    return query.get(todoId) as TaskTodo;
}

export function updateTodoStatus(todoId: string, status: TaskTodoStatus, result?: string, error?: string): void {
    db.run(
        "UPDATE task_todos SET status = ?, result = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [status, result || null, error || null, todoId]
    );
}

export function getTodo(todoId: string): TaskTodo | undefined {
    const query = db.query("SELECT * FROM task_todos WHERE id = ?");
    return query.get(todoId) as TaskTodo | undefined;
}

export function getAllTasks(limit: number = 50): Task[] {
    const query = db.query("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?");
    return query.all(limit) as Task[];
}

export function logTaskError(taskId: string | null, todoId: string | null, phase: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? null) : null;
    db.run(
        "INSERT INTO task_errors (task_id, todo_id, phase, message, stack) VALUES (?, ?, ?, ?, ?)",
        [taskId, todoId, phase, message, stack]
    );
}

export function getTaskErrors(taskId: string): Array<{ id: number; task_id: string; todo_id: string | null; phase: string; message: string; stack: string | null; created_at: string }> {
    const query = db.query("SELECT * FROM task_errors WHERE task_id = ? ORDER BY created_at ASC");
    return query.all(taskId) as any[];
}
