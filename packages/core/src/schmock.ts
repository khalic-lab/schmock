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

  constructor(config: SchmockConfig) {
    this.config = config;
    this.routes = new Map();
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
    const route = this.routes.get(path);

    if (!route) {
      return {
        status: 404,
        body: { error: "Not Found" },
        headers: {},
      };
    }

    return {
      status: 200,
      body: route.data,
      headers: {
        "Content-Type": "application/json",
      },
    };
  }

  // Stubs for interface compliance - to be implemented
  use(_plugin: SchmockPlugin): SchmockCore {
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
    _event: K,
    _handler: (data: SchmockEventMap[K]) => void,
  ): void {
    // To be implemented
  }

  off<K extends keyof SchmockEventMap>(
    _event: K,
    _handler: (data: SchmockEventMap[K]) => void,
  ): void {
    // To be implemented
  }

  emit<K extends keyof SchmockEventMap>(
    _event: K,
    _data: SchmockEventMap[K],
  ): void {
    // To be implemented
  }
}
