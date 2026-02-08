import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./cli";

describe("parseCliArgs", () => {
  it("parses --spec flag", () => {
    const result = parseCliArgs(["--spec", "petstore.yaml"]);
    expect(result.spec).toBe("petstore.yaml");
  });

  it("parses --port flag", () => {
    const result = parseCliArgs(["--spec", "x.yaml", "--port", "8080"]);
    expect(result.port).toBe(8080);
  });

  it("parses --hostname flag", () => {
    const result = parseCliArgs(["--spec", "x.yaml", "--hostname", "0.0.0.0"]);
    expect(result.hostname).toBe("0.0.0.0");
  });

  it("parses --seed flag", () => {
    const result = parseCliArgs(["--spec", "x.yaml", "--seed", "seed.json"]);
    expect(result.seed).toBe("seed.json");
  });

  it("parses --cors flag", () => {
    const result = parseCliArgs(["--spec", "x.yaml", "--cors"]);
    expect(result.cors).toBe(true);
  });

  it("parses --debug flag", () => {
    const result = parseCliArgs(["--spec", "x.yaml", "--debug"]);
    expect(result.debug).toBe(true);
  });

  it("parses -h / --help flag", () => {
    const result = parseCliArgs(["-h"]);
    expect(result.help).toBe(true);
  });

  it("defaults port to undefined when not provided", () => {
    const result = parseCliArgs(["--spec", "x.yaml"]);
    expect(result.port).toBeUndefined();
  });

  it("defaults cors to false", () => {
    const result = parseCliArgs(["--spec", "x.yaml"]);
    expect(result.cors).toBe(false);
  });

  it("defaults spec to empty string when not provided", () => {
    const result = parseCliArgs([]);
    expect(result.spec).toBe("");
  });

  it("parses positional spec argument", () => {
    const result = parseCliArgs(["petstore.yaml"]);
    expect(result.spec).toBe("petstore.yaml");
  });

  it("positional spec works with other flags", () => {
    const result = parseCliArgs(["petstore.yaml", "--port", "8080", "--cors"]);
    expect(result.spec).toBe("petstore.yaml");
    expect(result.port).toBe(8080);
    expect(result.cors).toBe(true);
  });

  it("--spec flag takes precedence over positional", () => {
    const result = parseCliArgs(["positional.yaml", "--spec", "flag.yaml"]);
    expect(result.spec).toBe("flag.yaml");
  });
});
