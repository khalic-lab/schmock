import { describe, expect, it, vi } from "vitest";
import { RequestGenerations } from "./generations.js";

function setup() {
  const uninstall = vi.fn();
  const gens = new RequestGenerations(uninstall);
  return { uninstall, gens };
}

describe("RequestGenerations.current", () => {
  it("exposes a fresh, current, stable generation", () => {
    const { gens } = setup();

    expect(gens.current.activeAdmissions).toBe(0);
    expect(gens.isCurrent(gens.current)).toBe(true);
    const first = gens.current;
    expect(gens.current).toBe(first);
    expect(gens.current).toBe(first);
  });

  it("is the generation admit() returns", () => {
    const { gens } = setup();
    const g = gens.current;

    expect(gens.admit()).toBe(g);
    expect(gens.current).toBe(g);
    expect(g.activeAdmissions).toBe(1);
  });

  it("switches to a new generation on advance()", () => {
    const { gens } = setup();
    const before = gens.current;

    const returned = gens.advance();

    expect(returned).toBe(before);
    expect(gens.isCurrent(before)).toBe(false);
    expect(gens.current).not.toBe(before);
    expect(gens.isCurrent(gens.current)).toBe(true);
    expect(gens.current.activeAdmissions).toBe(0);
  });

  it("admits nothing and uninstalls nothing when read", () => {
    const { gens, uninstall } = setup();

    for (let i = 0; i < 5; i++) expect(gens.current.activeAdmissions).toBe(0);
    gens.admit();
    for (let i = 0; i < 5; i++) expect(gens.current.activeAdmissions).toBe(1);

    expect(uninstall).not.toHaveBeenCalled();
  });

  it("does not uninstall a retired generation with an in-flight request", () => {
    const { gens, uninstall } = setup();
    const plugin = { name: "p", process: vi.fn() };
    gens.admit();
    const old = gens.advance();
    gens.retire(old, [plugin]);

    for (let i = 0; i < 5; i++) expect(gens.current).toBeDefined();

    expect(uninstall).not.toHaveBeenCalled();
    expect(old.activeAdmissions).toBe(1);
    expect(old.retiredPlugins).toEqual([plugin]);

    gens.release(old);

    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(uninstall).toHaveBeenCalledWith([plugin]);
  });

  it("is a getter-only accessor", () => {
    const { gens } = setup();
    const descriptor = Object.getOwnPropertyDescriptor(
      RequestGenerations.prototype,
      "current",
    );

    expect(typeof descriptor?.get).toBe("function");
    expect(descriptor?.set).toBeUndefined();

    const before = gens.current;
    expect(Reflect.set(gens, "current", {})).toBe(false);
    expect(gens.current).toBe(before);
  });
});
