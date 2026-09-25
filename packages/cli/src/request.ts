import type * as Schmock from "@schmock/core";
import { serveNodeRequest } from "@schmock/core";
import type {
  MockRequestHandler,
  RequestAdmission,
} from "@schmock/core/adapter";
import { acquireRequestAdmission } from "@schmock/core/adapter";
import { answerAdminRequest, isAdminPath } from "./admin.js";
import { corsHeadersFor, isCorsPreflight } from "./cors.js";

const MAX_REQUEST_BODY_SIZE = 10 * 1024 * 1024;

/**
 * The parts of Node's request and response the bridge uses. Structural, as
 * core declares them, so a request typed by any `@types/node` copy fits.
 */
type NodeRequest = Parameters<typeof serveNodeRequest>[0];
type NodeResponse = Parameters<typeof serveNodeRequest>[1];

export interface CliRequestContext {
  /** The mock this request is served by, resolved when it arrives. */
  readonly mock: Schmock.CallableMockInstance;
  /** Whether `/schmock-admin/*` is the admin API rather than mock routes. */
  readonly admin: boolean;
  readonly cors: boolean;
  readonly adminToken: string | undefined;
}

/**
 * Admit a request against the mock as it is now. A mock that is not a
 * `schmock()` instance is routed through `mock.handle` unadmitted.
 *
 * A mock whose admission is broken still answers: the failure becomes the 500
 * of every request that reaches the mock, while the admin API and preflights,
 * which never use the admission, keep working. Thrown here instead, it would
 * escape the server's request listener as an unhandled rejection.
 */
function admitRequest(mock: Schmock.CallableMockInstance): RequestAdmission {
  const noRelease = (): void => {};
  let admission: RequestAdmission | undefined;
  try {
    admission = acquireRequestAdmission(mock);
  } catch (error) {
    return { handle: () => Promise.reject(error), release: noRelease };
  }
  return (
    admission ?? {
      handle: (method, path, options) => mock.handle(method, path, options),
      release: noRelease,
    }
  );
}

/**
 * Serve one CLI request through core's Node bridge, which parses it (400 for a
 * bad Host or target, 405 with `allow` for a verb Schmock does not route),
 * collects the body (400 when it is malformed, 413 over 10 MB) and writes
 * every answer. Only what the CLI adds is decided here: the CORS preflight,
 * the admin API, and which answers carry CORS headers.
 *
 * The admission is taken on arrival, before the body uploads: a watch reload
 * resets the previous mock as soon as it swaps in the new one, and an
 * admission snapshots routes, plugins and state, so a request already under
 * way keeps being served by the mock it arrived at.
 */
export function handleCliRequest(
  req: NodeRequest,
  res: NodeResponse,
  context: CliRequestContext,
): Promise<void> {
  const { mock, admin, cors, adminToken } = context;
  const admission = admitRequest(mock);

  const handle: MockRequestHandler = async (method, path, options) => {
    const adminRequest = isAdminPath(admin, path);
    // The preflight short-circuit deliberately excludes the admin surface:
    // without this gate an admin preflight would be answered 204 + wildcard
    // CORS no matter what the admin branch does. The CORS headers themselves
    // arrive through `extraHeaders`.
    if (cors && !adminRequest && isCorsPreflight(req, method)) {
      return { status: 204, body: undefined, headers: {} };
    }
    if (adminRequest) {
      return answerAdminRequest({ req, method, path, mock, adminToken });
    }
    return admission.handle(method, path, options);
  };

  return serveNodeRequest(req, res, {
    handle,
    maxBodySize: MAX_REQUEST_BODY_SIZE,
    // The admin surface stays CORS-free on every answer, its errors included.
    // A request whose target did not parse has no path, so it is not an admin
    // request and its 400 carries CORS like any other.
    extraHeaders: ({ path }) =>
      cors && !(path !== undefined && isAdminPath(admin, path))
        ? corsHeadersFor(req)
        : undefined,
  }).finally(() => admission.release());
}
