/**
 * E2E: Todo app with Express + toExpress middleware.
 *
 * Same Todo CRUD baseline as every adapter fixture.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { schmock, notFound } from "@schmock/core";
import { toExpress } from "@schmock/express";

interface Todo {
  id: number;
  title: string;
  done: boolean;
}

let server: Server;
let base: string;
let mock: ReturnType<typeof schmock>;

beforeAll(async () => {
  mock = schmock({
    state: {
      todos: [
        { id: 1, title: "Buy milk", done: false },
        { id: 2, title: "Write tests", done: true },
      ] as Todo[],
      nextId: 3,
    },
  });

  mock("GET /todos", ({ state }) => state.todos);

  mock("POST /todos", ({ body, state }) => {
    const b = body as { title: string; done: boolean };
    const todo = { id: (state as any).nextId++, title: b.title, done: b.done };
    (state as any).todos.push(todo);
    return [201, todo];
  });

  mock("PATCH /todos/:id", ({ params, body, state }) => {
    const todos = (state as any).todos as Todo[];
    const todo = todos.find((t) => t.id === Number(params.id));
    if (!todo) return notFound("Todo not found");
    Object.assign(todo, body);
    return todo;
  });

  mock("DELETE /todos/:id", ({ params, state }) => {
    const todos = (state as any).todos as Todo[];
    const idx = todos.findIndex((t) => t.id === Number(params.id));
    if (idx === -1) return notFound("Todo not found");
    todos.splice(idx, 1);
    return [204, null];
  });

  const app = express();
  app.use(express.json());
  app.use("/api", toExpress(mock));

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") base = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => { server?.close(); });

describe("Todo App — Express (toExpress)", () => {
  it("loads all todos", async () => {
    const res = await fetch(`${base}/api/todos`);
    expect(res.status).toBe(200);
    const todos = await res.json();
    expect(todos).toHaveLength(2);
    expect(todos[0].title).toBe("Buy milk");
    expect(todos[1].done).toBe(true);
  });

  it("adds a new todo", async () => {
    const res = await fetch(`${base}/api/todos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Ship it", done: false }),
    });
    expect(res.status).toBe(201);
    const todo = await res.json();
    expect(todo.id).toBe(3);
    expect(todo.title).toBe("Ship it");

    // Verify persistence
    const list = await fetch(`${base}/api/todos`);
    expect(await list.json()).toHaveLength(3);
  });

  it("toggles a todo's done state", async () => {
    const res = await fetch(`${base}/api/todos/1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(200);
    const todo = await res.json();
    expect(todo.done).toBe(true);
    expect(todo.title).toBe("Buy milk");
  });

  it("deletes a todo", async () => {
    const res = await fetch(`${base}/api/todos/3`, { method: "DELETE" });
    expect(res.status).toBe(204);

    const list = await fetch(`${base}/api/todos`);
    const todos = await list.json();
    expect(todos.find((t: Todo) => t.id === 3)).toBeUndefined();
  });

  it("returns 404 for missing todo", async () => {
    const res = await fetch(`${base}/api/todos/999`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(404);
  });

  it("passthrough: unmatched routes fall through to express 404", async () => {
    const res = await fetch(`${base}/api/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("spy: tracks all operations", () => {
    expect(mock.called("GET", "/todos")).toBe(true);
    expect(mock.called("POST", "/todos")).toBe(true);
    expect(mock.called("PATCH", "/todos/1")).toBe(true);
    expect(mock.called("DELETE", "/todos/3")).toBe(true);
    expect(mock.callCount()).toBeGreaterThanOrEqual(6);
  });
});
