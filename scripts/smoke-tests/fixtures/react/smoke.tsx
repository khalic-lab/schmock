import { JSDOM } from "jsdom";

// Set up DOM globals before importing React
const dom = new JSDOM("<!DOCTYPE html><html><body><div id='root'></div></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
});

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { schmock } from "@schmock/core";
import { SchmockProvider, useSchmock } from "@schmock/react";

// 1. Verify exports exist
if (typeof SchmockProvider !== "function") throw new Error("SchmockProvider not a function");
if (typeof useSchmock !== "function") throw new Error("useSchmock not a function");

// 2. Test intercept lifecycle via Provider
const mock = schmock();
mock("GET /api/users", [{ id: 1, name: "Alice" }]);

const savedFetch = globalThis.fetch;

function App() {
  const [users, setUsers] = useState<Array<{ id: number; name: string }>>([]);
  const m = useSchmock();

  useEffect(() => {
    void fetch("http://localhost/api/users")
      .then((r) => r.json())
      .then(setUsers);
  }, []);

  return React.createElement(
    "div",
    { id: "app" },
    React.createElement("span", { id: "count" }, String(users.length)),
    users.map((u) =>
      React.createElement("span", { key: u.id, className: "user" }, u.name),
    ),
    React.createElement("span", { id: "has-mock" }, m ? "yes" : "no"),
  );
}

const container = document.getElementById("root")!;
const root = createRoot(container);

root.render(
  React.createElement(SchmockProvider, { mock }, React.createElement(App)),
);

// Wait for effects to flush
await new Promise((r) => setTimeout(r, 100));

const appEl = document.getElementById("app");
if (!appEl) throw new Error("App not rendered");

// Check useSchmock works
const hasMock = document.getElementById("has-mock");
if (hasMock?.textContent !== "yes") throw new Error("useSchmock failed: " + hasMock?.textContent);

// Check fetch was intercepted
const count = document.getElementById("count");
if (count?.textContent !== "1") throw new Error("Fetch not intercepted, count: " + count?.textContent);

const userSpan = document.querySelector(".user");
if (userSpan?.textContent !== "Alice") throw new Error("User not rendered: " + userSpan?.textContent);

// Check spy API
if (!mock.called("GET", "/api/users")) throw new Error("spy: should be called");

// Unmount should restore fetch
root.unmount();
await new Promise((r) => setTimeout(r, 50));

console.log("@schmock/react: all checks passed");
