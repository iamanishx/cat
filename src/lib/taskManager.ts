import {
    createTask,
    getTask,
    updateTaskStatus,
    setCurrentTodo,
    getTaskTodos,
    createTaskTodo,
    updateTodoStatus,
    getTodo,
    logTaskError,
    type Task,
    type TaskTodo,
    type TaskStatus,
    type TaskTodoStatus,
} from "./db.js";

const TASK_STATUS = {
    PLANNING: "planning",
    RUNNING: "running",
    COMPLETED: "completed",
    FAILED: "failed",
    ABORTED: "aborted",
} as const;

const TODO_STATUS = {
    PENDING: "pending",
    IN_PROGRESS: "in_progress",
    COMPLETED: "completed",
    FAILED: "failed",
    SKIPPED: "skipped",
} as const;

export type TodoItem = {
    id: string;
    content: string;
    status: TaskTodoStatus;
    result?: string;
    error?: string;
};

export type TaskProgress = {
    taskId: string;
    status: TaskStatus;
    prompt: string;
    workingDirectory: string;
    currentTodo: TodoItem | null;
    completedTodos: TodoItem[];
    pendingTodos: TodoItem[];
    failedTodos: TodoItem[];
    result?: string;
    error?: string;
};

const runningTasks = new Map<string, { abort: boolean; taskId: string }>();

export function startTask(prompt: string, workingDirectory: string = process.cwd()): Task {
    const task = createTask(prompt, workingDirectory);
    runningTasks.set(task.id, { abort: false, taskId: task.id });
    return task;
}

export function getTaskProgress(taskId: string): TaskProgress | null {
    const task = getTask(taskId);
    if (!task) return null;

    const todos = getTaskTodos(taskId);
    const completed = todos.filter((t) => t.status === TODO_STATUS.COMPLETED);
    const pending = todos.filter((t) => t.status === TODO_STATUS.PENDING);
    const failed = todos.filter((t) => t.status === TODO_STATUS.FAILED);

    let currentTodo: TodoItem | null = null;
    if (task.current_todo_id) {
        const todo = getTodo(task.current_todo_id);
        if (todo) {
            currentTodo = {
                id: todo.id,
                content: todo.content,
                status: todo.status,
                result: todo.result,
                error: todo.error,
            };
        }
    }

    return {
        taskId: task.id,
        status: task.status,
        prompt: task.prompt,
        workingDirectory: task.working_directory,
        currentTodo,
        completedTodos: completed.map((t) => ({
            id: t.id,
            content: t.content,
            status: t.status,
            result: t.result,
            error: t.error,
        })),
        pendingTodos: pending.map((t) => ({
            id: t.id,
            content: t.content,
            status: t.status,
        })),
        failedTodos: failed.map((t) => ({
            id: t.id,
            content: t.content,
            status: t.status,
            error: t.error,
        })),
        result: task.result || undefined,
        error: task.error || undefined,
    };
}

export function addTodo(taskId: string, content: string): TaskTodo {
    return createTaskTodo(taskId, content);
}

export function startTodo(taskId: string, todoId: string): void {
    setCurrentTodo(taskId, todoId);
    updateTodoStatus(todoId, TODO_STATUS.IN_PROGRESS);
    updateTaskStatus(taskId, TASK_STATUS.RUNNING);
}

export function completeTodo(todoId: string, result: string): void {
    updateTodoStatus(todoId, TODO_STATUS.COMPLETED, result);
}

export function failTodo(todoId: string, error: string): void {
    updateTodoStatus(todoId, TODO_STATUS.FAILED, undefined, error);
}

export function skipTodo(todoId: string): void {
    updateTodoStatus(todoId, TODO_STATUS.SKIPPED);
}

export function completeTask(taskId: string, result: string): void {
    runningTasks.delete(taskId);
    setCurrentTodo(taskId, null);
    updateTaskStatus(taskId, TASK_STATUS.COMPLETED, result);
}

export function failTask(taskId: string, error: string): void {
    runningTasks.delete(taskId);
    setCurrentTodo(taskId, null);
    updateTaskStatus(taskId, TASK_STATUS.FAILED, undefined, error);
}

export function markTaskAborted(taskId: string): void {
    runningTasks.delete(taskId);
    setCurrentTodo(taskId, null);
    updateTaskStatus(taskId, TASK_STATUS.ABORTED);
}

export function abortTask(taskId: string): boolean {
    const taskInfo = runningTasks.get(taskId);
    if (!taskInfo) return false;
    taskInfo.abort = true;
    return true;
}

export function isAborted(taskId: string): boolean {
    const taskInfo = runningTasks.get(taskId);
    // If not in memory map, check the DB — the task may have been marked aborted
    // before this process started (e.g., re-used task ID) but we must NOT treat
    // a freshly-created task that's simply missing from the in-memory map as aborted.
    if (!taskInfo) {
        const task = getTask(taskId);
        return task?.status === "aborted";
    }
    return taskInfo.abort;
}

export function setTaskPlanning(taskId: string): void {
    updateTaskStatus(taskId, TASK_STATUS.PLANNING);
}

export function setTaskRunning(taskId: string): void {
    updateTaskStatus(taskId, TASK_STATUS.RUNNING);
}

export function getNextPendingTodo(taskId: string): TaskTodo | null {
    const todos = getTaskTodos(taskId);
    return todos.find((t) => t.status === TODO_STATUS.PENDING) || null;
}

export function recordError(taskId: string | null, todoId: string | null, phase: string, error: unknown): void {
    logTaskError(taskId, todoId, phase, error);
}
