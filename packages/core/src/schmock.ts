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
  private eventHandlers: Map<string, ((data: any) => void)[]>;
  private nextId = 1;

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
    switch (method) {
      case "GET":
        return this.get(path, options);
      case "POST":
        return this.post(path, options?.body, options);
      case "PUT":
        return this.put(path, options?.body, options);
      case "DELETE":
        return this.delete(path, options);
      case "PATCH":
        return this.patch(path, options?.body, options);
      default:
        throw new Error(`Method ${method} not implemented`);
    }
  }

  async post(
    path: string,
    body?: unknown,
    _options?: Partial<Omit<SchmockRequest, "method" | "path" | "body">>,
  ): Promise<SchmockResponse> {
    const request: SchmockRequest = {
      path,
      method: "POST",
      headers: _options?.headers || {},
      query: _options?.query || {},
      params: _options?.params || {},
      body,
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

    // For POST, we typically create a new resource
    // In a real implementation, this would add to a collection
    // For now, we'll return the posted data with an ID
    // Check if route has existing data array to determine next ID
    let id = this.nextId;
    if (Array.isArray(route.data)) {
      id = route.data.length + 1;
    }

    const newResource = {
      id,
      ...(typeof body === "object" && body !== null ? body : {}),
    };

    this.nextId++;

    const response: SchmockResponse = {
      status: 201,
      body: newResource,
      headers: {
        "Content-Type": "application/json",
      },
    };

    // Emit request:end event
    this.emit("request:end", { request, response });

    return response;
  }

  async put(
    path: string,
    body?: unknown,
    _options?: Partial<Omit<SchmockRequest, "method" | "path" | "body">>,
  ): Promise<SchmockResponse> {
    const request: SchmockRequest = {
      path,
      method: "PUT",
      headers: _options?.headers || {},
      query: _options?.query || {},
      params: _options?.params || {},
      body,
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

    // For PUT, we replace the entire resource
    const response: SchmockResponse = {
      status: 200,
      body: body,
      headers: {
        "Content-Type": "application/json",
      },
    };

    // Emit request:end event
    this.emit("request:end", { request, response });

    return response;
  }

  async delete(
    path: string,
    _options?: Partial<Omit<SchmockRequest, "method" | "path">>,
  ): Promise<SchmockResponse> {
    const request: SchmockRequest = {
      path,
      method: "DELETE",
      headers: _options?.headers || {},
      query: _options?.query || {},
      params: _options?.params || {},
      body: undefined,
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

    // For DELETE, return 204 No Content
    const response: SchmockResponse = {
      status: 204,
      body: undefined,
      headers: {},
    };

    // Emit request:end event
    this.emit("request:end", { request, response });

    return response;
  }

  async patch(
    path: string,
    body?: unknown,
    _options?: Partial<Omit<SchmockRequest, "method" | "path" | "body">>,
  ): Promise<SchmockResponse> {
    const request: SchmockRequest = {
      path,
      method: "PATCH",
      headers: _options?.headers || {},
      query: _options?.query || {},
      params: _options?.params || {},
      body,
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

    // For PATCH, merge the body with existing data
    const existingData = route.data;
    const mergedData = {
      ...(typeof existingData === "object" && existingData !== null
        ? existingData
        : {}),
      ...(typeof body === "object" && body !== null ? body : {}),
    };

    const response: SchmockResponse = {
      status: 200,
      body: mergedData,
      headers: {
        "Content-Type": "application/json",
      },
    };

    // Emit request:end event
    this.emit("request:end", { request, response });

    return response;
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
