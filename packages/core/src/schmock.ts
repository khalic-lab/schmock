import type {
  SchmockConfig,
  SchmockCore,
  SchmockEventMap,
  SchmockPlugin,
  SchmockRequest,
  SchmockResponse,
  SchmockRoute,
} from "./types";

export class Schmock implements SchmockCore {
  private config: SchmockConfig;
  private routes: Map<string, SchmockRoute>;
  private eventHandlers: Map<string, ((data: unknown) => void)[]>;

  constructor(config: SchmockConfig) {
    this.config = config;
    this.routes = new Map();
    this.eventHandlers = new Map();
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    Object.entries(this.config.routes).forEach(([path, routeConfig]) => {
      if (typeof routeConfig === "string" || typeof routeConfig === "object") {
        const route: SchmockRoute =
          typeof routeConfig === "string" ? { data: routeConfig } : routeConfig;
        this.routes.set(path, route);
      }
    });
  }

  async get(
    path: string,
    _options?: Partial<Omit<SchmockRequest, "method" | "path">>,
  ): Promise<SchmockResponse> {
    const request: SchmockRequest = {
      path,
      method: "GET",
      headers: _options?.headers || {},
      query: _options?.query || {},
      params: _options?.params || {},
      body: _options?.body,
    };

    const route = this.routes.get(path);

    // Emit request:start event
    this.emit("request:start", { request, route: route || { data: null } });

    if (!route) {
      const response: SchmockResponse = {
        status: 404,
        body: { error: "Not Found" },
        headers: {},
      };

      // Emit request:end event
      this.emit("request:end", { request, response });

      return response;
    }

    const response: SchmockResponse = {
      status: 200,
      body: route.data,
      headers: {
        "Content-Type": "application/json",
      },
    };

    // Emit request:end event
    this.emit("request:end", { request, response });

    return response;
  }

  use(plugin: SchmockPlugin): SchmockCore {
    // Emit plugin:registered event
    this.emit("plugin:registered", { plugin });
    return this;
  }

  async request(
    method: SchmockRequest["method"],
    path: string,
    options?: Partial<Omit<SchmockRequest, "method" | "path">>,
  ): Promise<SchmockResponse> {
    if (method === "GET") {
      return this.get(path, options);
    }
    throw new Error(`Method ${method} not implemented`);
  }

  async post(
    _path: string,
    _body?: unknown,
    _options?: Partial<Omit<SchmockRequest, "method" | "path" | "body">>,
  ): Promise<SchmockResponse> {
    throw new Error("POST not implemented");
  }

  async put(
    _path: string,
    _body?: unknown,
    _options?: Partial<Omit<SchmockRequest, "method" | "path" | "body">>,
  ): Promise<SchmockResponse> {
    throw new Error("PUT not implemented");
  }

  async delete(
    _path: string,
    _options?: Partial<Omit<SchmockRequest, "method" | "path">>,
  ): Promise<SchmockResponse> {
    throw new Error("DELETE not implemented");
  }

  async patch(
    _path: string,
    _body?: unknown,
    _options?: Partial<Omit<SchmockRequest, "method" | "path" | "body">>,
  ): Promise<SchmockResponse> {
    throw new Error("PATCH not implemented");
  }

  on<K extends keyof SchmockEventMap>(
    event: K,
    handler: (data: SchmockEventMap[K]) => void,
  ): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)?.push(handler);
  }

  off<K extends keyof SchmockEventMap>(
    event: K,
    handler: (data: SchmockEventMap[K]) => void,
  ): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  emit<K extends keyof SchmockEventMap>(
    event: K,
    data: SchmockEventMap[K],
  ): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(data);
        } catch (error) {
          // Emit error event if handler fails
          this.emit("error", { error: error as Error });
        }
      });
    }
  }
}
