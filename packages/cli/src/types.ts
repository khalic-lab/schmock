import type { Server } from "node:http";

/**
 * Options for `createCliServer`, one per `schmock` flag. An alias of the
 * ambient `Schmock.CliOptions` rather than a copy, so the documented flags
 * and the accepted options cannot drift apart.
 */
export type CliOptions = Schmock.CliOptions;

/**
 * A running CLI server. Kept separate from the ambient `Schmock.CliServer`,
 * whose `server` is a browser-safe subset: this one exposes the exact Node.js
 * `Server`.
 */
export interface CliServer {
  server: Server;
  port: number;
  hostname: string;
  /**
   * The bearer token this server requires on `/schmock-admin/*`. Present only
   * when admin is enabled; supply it as `Authorization: Bearer <token>`.
   */
  adminToken?: string;
  /**
   * Stop watching, stop accepting, and settle once the socket is released —
   * within {@link CliOptions.shutdownGraceMs}. Memoized: every call observes
   * the same shutdown, so closing twice is safe and resolves twice.
   */
  close(): Promise<void>;
}
