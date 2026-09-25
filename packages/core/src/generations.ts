/** One period of the mock between two resets. */
export interface RequestGeneration {
  activeAdmissions: number;
  /** Set once retired: the plugins it still owes an uninstall. */
  retiredPlugins?: readonly Schmock.Plugin[];
}

type Uninstall = (plugins: readonly Schmock.Plugin[]) => void;

/**
 * The mock's request generations. `reset()` retires the current one, but the
 * plugins it had installed are uninstalled only once its last in-flight
 * request settles, so no admitted request loses its plugins mid-flight.
 */
export class RequestGenerations {
  #current: RequestGeneration = { activeAdmissions: 0 };
  /** Retired generations whose uninstall waits for in-flight requests. */
  readonly #retired = new Set<RequestGeneration>();
  readonly #uninstall: Uninstall;

  constructor(uninstall: Uninstall) {
    this.#uninstall = uninstall;
  }

  /**
   * Whether a request's generation is still the live one. Only its requests
   * emit lifecycle events and record history.
   */
  isCurrent(generation: RequestGeneration): boolean {
    return generation === this.#current;
  }

  /** Count one more in-flight request in the current generation. */
  admit(): RequestGeneration {
    const generation = this.#current;
    generation.activeAdmissions += 1;
    return generation;
  }

  /**
   * Count a request out. The last one out of a retired generation runs the
   * uninstall that generation owes.
   */
  release(generation: RequestGeneration): void {
    generation.activeAdmissions -= 1;
    if (
      generation.activeAdmissions === 0 &&
      generation.retiredPlugins !== undefined
    ) {
      const plugins = generation.retiredPlugins;
      generation.retiredPlugins = undefined;
      this.#retired.delete(generation);
      this.#uninstall(plugins);
    }
  }

  /** Start a new generation; the previous one is returned for `retire()`. */
  advance(): RequestGeneration {
    const previous = this.#current;
    this.#current = { activeAdmissions: 0 };
    return previous;
  }

  /**
   * Retire a generation that owes `plugins` an uninstall: at once when no
   * request of it is in flight, otherwise when its last request settles.
   */
  retire(
    generation: RequestGeneration,
    plugins: readonly Schmock.Plugin[],
  ): void {
    generation.retiredPlugins = plugins;
    if (generation.activeAdmissions === 0) {
      generation.retiredPlugins = undefined;
      this.#uninstall(plugins);
      return;
    }
    this.#retired.add(generation);
  }

  /**
   * Run the uninstall a retired generation still owes this plugin object, now,
   * before it is installed again. Left to the retired generation, it would run
   * when that generation's last request settles — after the new install() —
   * and tear down the live installation.
   */
  uninstallBeforeReinstall(plugin: Schmock.Plugin): void {
    for (const generation of this.#retired) {
      const pending = generation.retiredPlugins;
      if (!pending?.includes(plugin)) continue;
      generation.retiredPlugins = pending.filter(
        (retired) => retired !== plugin,
      );
      this.#uninstall([plugin]);
    }
  }
}
