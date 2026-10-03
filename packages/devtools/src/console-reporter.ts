import type * as Schmock from "@schmock/core";
import type { ExchangeSummary, ExchangeTone } from "./types.js";

type ConsoleSink = Pick<
  Console,
  "groupCollapsed" | "log" | "error" | "groupEnd"
>;

export const TONE_STYLES: Readonly<Record<ExchangeTone, string>> =
  Object.freeze({
    success: "color:#fff;background:#188038;padding:0 4px;border-radius:3px",
    "client-error":
      "color:#fff;background:#b06000;padding:0 4px;border-radius:3px",
    "server-error":
      "color:#fff;background:#c5221f;padding:0 4px;border-radius:3px",
    failed: "color:#fff;background:#c5221f;padding:0 4px;border-radius:3px",
    aborted: "color:#fff;background:#5f6368;padding:0 4px;border-radius:3px",
  });

/**
 * Log one exchange as a collapsed console group; the group always closes.
 *
 * The title renders as the label in a tone-coloured badge, a space, then
 * `<name> → <outcome> (<duration>)`. The label, URL and error text reach the
 * console as `%s` arguments, never inside the format string, so a `%c`, `%s`
 * or `%d` in them prints literally instead of consuming arguments.
 */
export function logExchange(
  exchange: Schmock.Exchange,
  summary: ExchangeSummary,
  label: string,
  sink: ConsoleSink = console,
): void {
  sink.groupCollapsed(
    "%c%s%c %s",
    TONE_STYLES[summary.tone],
    label,
    "",
    `${summary.name} → ${summary.outcome} (${summary.duration})`,
  );
  try {
    const { method, url, headers, body } = exchange.request;
    sink.log("Request", {
      method,
      url,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    if (exchange.outcome === "answered") {
      const {
        status,
        headers: responseHeaders,
        body: responseBody,
      } = exchange.response;
      sink.log("Response", {
        status,
        headers: responseHeaders,
        ...(responseBody !== undefined ? { body: responseBody } : {}),
      });
    } else if (exchange.outcome === "failed") {
      sink.error(exchange.error);
    } else {
      sink.log("Aborted by the client");
    }
  } finally {
    sink.groupEnd();
  }
}
