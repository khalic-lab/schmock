import { REQUEST_ADMISSION_KEY } from "./admission.js";
import { CallableMockInstance } from "./builder.js";
import type { ServerControllerFactory } from "./server-controller.js";

/**
 * Build the callable mock `schmock()` returns, listening with the server
 * `createServer` builds. Shared by the Node entry (`index.ts`) and the browser
 * entry (`index.browser.ts`), which differ only in that server.
 */
export function createCallableMock(
  config: Schmock.GlobalConfig | undefined,
  createServer: ServerControllerFactory,
): Schmock.CallableMockInstance {
  const instance = new CallableMockInstance(config || {}, createServer);

  // Callable proxy: a function with attached methods
  const callableInstance: Schmock.CallableMockInstance = Object.assign(
    (
      route: Schmock.RouteKey,
      generator: Schmock.Generator,
      routeConfig: Schmock.RouteConfig = {},
    ) => {
      instance.defineRoute(route, generator, routeConfig);
      return callableInstance;
    },
    {
      pipe: (plugin: Schmock.Plugin) => {
        instance.pipe(plugin);
        return callableInstance;
      },
      handle: instance.handle.bind(instance),
      history: instance.history.bind(instance),
      called: instance.called.bind(instance),
      callCount: instance.callCount.bind(instance),
      lastRequest: instance.lastRequest.bind(instance),
      reset: instance.reset.bind(instance),
      resetHistory: instance.resetHistory.bind(instance),
      resetState: instance.resetState.bind(instance),
      on<E extends Schmock.SchmockEvent>(
        event: E,
        listener: (data: Schmock.SchmockEventMap[E]) => void,
      ) {
        instance.on(event, listener);
        return callableInstance;
      },
      off<E extends Schmock.SchmockEvent>(
        event: E,
        listener: (data: Schmock.SchmockEventMap[E]) => void,
      ) {
        instance.off(event, listener);
        return callableInstance;
      },
      getRoutes: instance.getRoutes.bind(instance),
      getState: instance.getState.bind(instance),
      listen: instance.listen.bind(instance),
      close: instance.close.bind(instance),
      intercept: (options?: Schmock.InterceptOptions) =>
        instance.intercept(options),
    },
  );

  Object.defineProperty(callableInstance, REQUEST_ADMISSION_KEY, {
    value: () => instance.createRequestAdmission(),
  });

  instance.setCallableRef(callableInstance);

  return callableInstance;
}
