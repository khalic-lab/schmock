import type * as Schmock from "@schmock/core";
import { version as packageVersion } from "../package.json";
import { logExchange } from "./console-reporter.js";
import { summarizeExchange } from "./exchange-summary.js";
import { invalidOption } from "./invalid-option.js";
import { measureExchange } from "./performance-reporter.js";
import type { DevtoolsPluginOptions } from "./types.js";

export { startServiceWorkerRelay } from "./relay/page-relay.js";
export type {
  DevtoolsPluginOptions,
  RelayFallbackReason,
  ServiceWorkerRelay,
  ServiceWorkerRelayOptions,
} from "./types.js";

function invalid(option: string, requirement: string, value: unknown): never {
  throw invalidOption("devtoolsPlugin", option, requirement, value);
}

function pageOrigin(): string | undefined {
  try {
    const pageLocation: unknown = Reflect.get(globalThis, "location");
    if (typeof pageLocation === "object" && pageLocation !== null) {
      const origin: unknown = Reflect.get(pageLocation, "origin");
      if (typeof origin === "string") return origin;
    }
  } catch {
    // A blocked location getter just means absolute URLs.
  }
  return undefined;
}

/**
 * Report every exchange a mock's fetch interception settles, whether answered,
 * failed or aborted, to the browser DevTools: one collapsed console group and
 * one Performance-panel track entry.
 */
export function devtoolsPlugin(
  options?: DevtoolsPluginOptions,
): Schmock.Plugin {
  if (
    options !== undefined &&
    (typeof options !== "object" || options === null || Array.isArray(options))
  ) {
    invalid("options", "an object", options);
  }
  const consoleOption: unknown = options && Reflect.get(options, "console");
  const performanceOption: unknown =
    options && Reflect.get(options, "performance");
  const trackOption: unknown = options && Reflect.get(options, "track");
  const trackGroupOption: unknown =
    options && Reflect.get(options, "trackGroup");

  if (consoleOption !== undefined && typeof consoleOption !== "boolean") {
    invalid("console", "a boolean", consoleOption);
  }
  if (
    performanceOption !== undefined &&
    typeof performanceOption !== "boolean"
  ) {
    invalid("performance", "a boolean", performanceOption);
  }
  if (
    trackOption !== undefined &&
    (typeof trackOption !== "string" || trackOption === "")
  ) {
    invalid("track", "a non-empty string", trackOption);
  }
  if (
    trackGroupOption !== undefined &&
    (typeof trackGroupOption !== "string" || trackGroupOption === "")
  ) {
    invalid("trackGroup", "a non-empty string", trackGroupOption);
  }

  const settings = Object.freeze({
    console: consoleOption !== false,
    performance: performanceOption !== false,
    track: typeof trackOption === "string" ? trackOption : "Schmock",
    trackGroup:
      typeof trackGroupOption === "string" ? trackGroupOption : undefined,
  });

  return {
    name: "devtools",
    version: packageVersion,
    process: (context, response) => ({ context, response }),
    onExchange(exchange: Schmock.Exchange): void {
      const summary = summarizeExchange(exchange, pageOrigin());
      if (settings.performance) {
        measureExchange(exchange, summary, {
          track: settings.track,
          trackGroup: settings.trackGroup,
        });
      }
      if (settings.console) {
        logExchange(exchange, summary, settings.track);
      }
    },
  };
}
