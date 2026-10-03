import type * as Schmock from "@schmock/core";
import type { DevToolsColor, ExchangeSummary, ExchangeTone } from "./types.js";

export const TONE_COLORS: Readonly<Record<ExchangeTone, DevToolsColor>> =
  Object.freeze({
    success: "primary",
    "client-error": "tertiary",
    "server-error": "error",
    failed: "error",
    aborted: "secondary",
  });

export function measureExchange(
  exchange: Schmock.Exchange,
  summary: ExchangeSummary,
  target: { readonly track: string; readonly trackGroup?: string },
  timeline: Pick<Performance, "measure"> | undefined = globalThis.performance,
): void {
  if (typeof timeline?.measure !== "function") return;
  try {
    // Method call on the timeline: a detached `measure` is an illegal invocation.
    timeline.measure(summary.name, {
      start: exchange.startTime,
      end: Math.max(exchange.endTime, exchange.startTime),
      detail: {
        devtools: {
          dataType: "track-entry",
          track: target.track,
          ...(target.trackGroup !== undefined
            ? { trackGroup: target.trackGroup }
            : {}),
          color: TONE_COLORS[summary.tone],
          tooltipText: `${exchange.request.method} ${exchange.request.url} → ${summary.outcome}`,
          properties: [
            ["Method", exchange.request.method],
            ["URL", exchange.request.url],
            ["Outcome", summary.outcome],
            ["Duration", summary.duration],
          ],
        },
      },
    });
  } catch {
    // Browsers without the options form throw; reporting must never break the app.
  }
}
