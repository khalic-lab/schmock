import { schmock } from "@schmock/core";
import { toExpress } from "@schmock/express";
import express from "express";

const mock = schmock();
mock("GET /api/users", [{ id: 1, name: "Alice" }]);
mock("POST /api/users", ({ body }) => [201, body]);

const app = express();
app.use(express.json());
app.use("/api", toExpress(mock));

// Start server on random port
const server = app.listen(0, async () => {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Bad address");
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    // GET
    const r1 = await fetch(`${base}/api/users`);
    if (r1.status !== 200) throw new Error("GET status: " + r1.status);
    const users = await r1.json();
    if (users[0].name !== "Alice") throw new Error("GET body wrong");

    // POST
    const r2 = await fetch(`${base}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bob" }),
    });
    if (r2.status !== 201) throw new Error("POST status: " + r2.status);
    const created = await r2.json();
    if (created.name !== "Bob") throw new Error("POST body wrong");

    // Passthrough (unmatched route returns 404 from express, not schmock)
    const r3 = await fetch(`${base}/api/unknown`);
    if (r3.status !== 404) throw new Error("Passthrough status: " + r3.status);

    console.log("@schmock/express: all checks passed");
  } finally {
    server.close();
  }
});
