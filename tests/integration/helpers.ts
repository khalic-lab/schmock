import { resolve } from "node:path";

const FIXTURES_DIR = resolve(
  __dirname,
  "../../packages/openapi/src/__fixtures__",
);
export const PETSTORE_SPEC = resolve(FIXTURES_DIR, "petstore-openapi3.json");
export const TRAIN_TRAVEL_SPEC = resolve(FIXTURES_DIR, "train-travel.yaml");
export const SCALAR_GALAXY_SPEC = resolve(FIXTURES_DIR, "scalar-galaxy.yaml");

/** Fetch JSON from a running schmock server */
export async function fetchJson(
  port: number,
  path: string,
  init?: RequestInit,
) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  const isJson = res.headers.get("content-type")?.includes("json");
  const body = isJson && text.length > 0 ? JSON.parse(text) : text;
  return {
    status: res.status,
    body,
    headers: Object.fromEntries(res.headers),
  };
}
