import type * as Schmock from "@schmock/core";
import type { ExchangeSummary, ExchangeTone } from "./types.js";

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "<unprintable>";
  }
}

function displayUrlOf(url: string, pageOrigin: string | undefined): string {
  if (pageOrigin === undefined) return url;
  try {
    const origin = new URL(pageOrigin).origin;
    const target = new URL(url);
    if (origin === "null" || target.origin !== origin) return url;
    return `${target.pathname}${target.search}`;
  } catch {
    return url;
  }
}

function outcomeOf(exchange: Schmock.Exchange): string {
  switch (exchange.outcome) {
    case "answered":
      return String(exchange.response.status);
    case "failed":
      return `failed: ${describeError(exchange.error)}`;
    default:
      return "aborted";
  }
}

function toneOf(exchange: Schmock.Exchange): ExchangeTone {
  if (exchange.outcome === "failed") return "failed";
  if (exchange.outcome === "aborted") return "aborted";
  const { status } = exchange.response;
  if (status >= 500) return "server-error";
  if (status >= 400) return "client-error";
  return "success";
}

export function summarizeExchange(
  exchange: Schmock.Exchange,
  pageOrigin?: string,
): ExchangeSummary {
  const { method, url } = exchange.request;
  return {
    name: `${method} ${displayUrlOf(url, pageOrigin)}`,
    outcome: outcomeOf(exchange),
    duration: `${Math.max(0, exchange.endTime - exchange.startTime).toFixed(1)} ms`,
    tone: toneOf(exchange),
  };
}
