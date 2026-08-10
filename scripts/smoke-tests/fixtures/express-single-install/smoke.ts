// The architecture promises framework adapters are a single install: adding
// @schmock/express alone must bring @schmock/core along. This fixture pins
// that promise by declaring ONLY the adapter (plus express itself, which is a
// genuinely external peer) and then resolving core through it.
import { schmock } from "@schmock/core";
import { toExpress } from "@schmock/express";
import express from "express";

if (typeof schmock !== "function") {
  throw new Error(
    "@schmock/core did not resolve from a lone @schmock/express install",
  );
}

const mock = schmock();
mock("GET /users", [{ id: 1, name: "Alice" }]);

const app = express();
app.use("/api", toExpress(mock));

const server = app.listen(0, async () => {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Bad address");

  try {
    const response = await fetch(`http://127.0.0.1:${addr.port}/api/users`);
    if (response.status !== 200)
      throw new Error(`GET status: ${response.status}`);
    const users = await response.json();
    if (users[0].name !== "Alice") throw new Error("GET body wrong");

    console.log("@schmock/express: single-install checks passed");
  } finally {
    server.close();
  }
});
