export class Schmock implements Schmock.Core {
  private config: Schmock.Config
  private routes: Map<string, Schmock.Route>

  constructor(config: Schmock.Config) {
    this.config = config
    this.routes = new Map()
    this.initializeRoutes()
  }

  private initializeRoutes(): void {
    Object.entries(this.config.routes).forEach(([path, routeConfig]) => {
      if (typeof routeConfig === 'string' || typeof routeConfig === 'object') {
        const route: Schmock.Route = typeof routeConfig === 'string' 
          ? { data: routeConfig }
          : routeConfig
        this.routes.set(path, route)
      }
    })
  }

  async get(path: string, options?: Partial<Omit<Schmock.Request, 'method' | 'path'>>): Promise<Schmock.Response> {
    const route = this.routes.get(path)
    
    if (!route) {
      return {
        status: 404,
        body: { error: 'Not Found' },
        headers: {}
      }
    }

    return {
      status: 200,
      body: route.data,
      headers: {
        'Content-Type': 'application/json'
      }
    }
  }

  // Stubs for interface compliance - to be implemented
  use(plugin: Schmock.Plugin): Schmock.Core {
    return this
  }

  async request(method: Schmock.Request['method'], path: string, options?: Partial<Omit<Schmock.Request, 'method' | 'path'>>): Promise<Schmock.Response> {
    if (method === 'GET') {
      return this.get(path, options)
    }
    throw new Error(`Method ${method} not implemented`)
  }

  async post(path: string, body?: any, options?: Partial<Omit<Schmock.Request, 'method' | 'path' | 'body'>>): Promise<Schmock.Response> {
    throw new Error('POST not implemented')
  }

  async put(path: string, body?: any, options?: Partial<Omit<Schmock.Request, 'method' | 'path' | 'body'>>): Promise<Schmock.Response> {
    throw new Error('PUT not implemented')
  }

  async delete(path: string, options?: Partial<Omit<Schmock.Request, 'method' | 'path'>>): Promise<Schmock.Response> {
    throw new Error('DELETE not implemented')
  }

  async patch(path: string, body?: any, options?: Partial<Omit<Schmock.Request, 'method' | 'path' | 'body'>>): Promise<Schmock.Response> {
    throw new Error('PATCH not implemented')
  }

  on<K extends keyof Schmock.EventMap>(event: K, handler: (data: Schmock.EventMap[K]) => void): void {
    // To be implemented
  }

  off<K extends keyof Schmock.EventMap>(event: K, handler: (data: Schmock.EventMap[K]) => void): void {
    // To be implemented
  }

  emit<K extends keyof Schmock.EventMap>(event: K, data: Schmock.EventMap[K]): void {
    // To be implemented
  }
}