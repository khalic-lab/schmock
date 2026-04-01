import { createCliServer } from "@schmock/cli";
import { resolve } from "node:path";

const server = await createCliServer({
  spec: resolve(import.meta.dirname, "spec.yaml"),
  port: 0, // random port
});

try {
  const base = `http://${server.hostname}:${server.port}`;

  // GET /ping
  const res = await fetch(`${base}/ping`);
  if (res.status !== 200) throw new Error("Status: " + res.status);

  const body = await res.json();
  if (typeof body !== "object") throw new Error("Body not object: " + typeof body);

  console.log("@schmock/cli: all checks passed");
} finally {
  server.close();
}
