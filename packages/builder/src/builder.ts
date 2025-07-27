import type { 
  Builder, 
  BuilderConfig, 
  Routes, 
  MockInstance,
  RouteDefinition,
  ResponseContext,
  HttpMethod
} from './types'
import { parseRouteKey } from './parser'
import type { ParsedRoute } from './parser'

interface BuilderState<TState> {
  config?: BuilderConfig
  routes?: Routes<TState>
  state?: TState
  plugins: any[]
}

interface CompiledRoute<TState> extends ParsedRoute {
  definition: RouteDefinition<TState>
}

/**
 * Fluent builder for creating Schmock instances.
 * 
 * @internal
 */
export class SchmockBuilder<TState = any> implements Builder<TState> {
  private options: BuilderState<TState> = {
    plugins: []
  }

  config(options: BuilderConfig): Builder<TState> {
    this.options.config = { ...this.options.config, ...options }
    return this
  }

  routes(routes: Routes<TState>): Builder<TState> {
    this.options.routes = { ...this.options.routes, ...routes }
    return this
  }

  state<T>(initial: T): Builder<T> {
    const newBuilder = new SchmockBuilder<T>()
    newBuilder.options = {
      ...this.options,
      state: initial
    } as BuilderState<T>
    return newBuilder
  }

  use(plugin: any): Builder<TState> {
    this.options.plugins.push(plugin)
    return this
  }

  build(): MockInstance<TState> {
    const compiledRoutes = this.compileRoutes()
    const state = this.options.state
    const config = this.options.config || {}

    return new SchmockInstance(compiledRoutes, state, config)
  }

  /**
   * Compile route definitions into parsed routes with patterns.
   * Applies namespace prefix if configured.
   */
  private compileRoutes(): CompiledRoute<TState>[] {
    const routes = this.options.routes || {}
    const namespace = this.options.config?.namespace || ''
    
    return Object.entries(routes).map(([routeKey, definition]) => {
      const parsed = parseRouteKey(routeKey)
      
      // Apply namespace if configured
      if (namespace) {
        parsed.path = namespace + parsed.path
        // Rebuild pattern with namespace
        const regexPath = parsed.path
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/:([^/]+)/g, '([^/]+)')
        parsed.pattern = new RegExp(`^${regexPath}$`)
      }
      
      return {
        ...parsed,
        definition: definition!
      }
    })
  }
}

/**
 * Mock instance that handles requests based on configured routes.
 * 
 * @internal
 */
class SchmockInstance<TState> implements MockInstance<TState> {
  constructor(
    private routes: CompiledRoute<TState>[],
    private state: TState,
    private config: BuilderConfig
  ) {}

  async handle(
    method: HttpMethod, 
    path: string, 
    options?: {
      headers?: Record<string, string>
      body?: any
      query?: Record<string, string>
    }
  ): Promise<{
    status: number
    body: any
    headers: Record<string, string>
  }> {
    // Find matching route
    const route = this.findRoute(method, path)
    
    if (!route) {
      return {
        status: 404,
        body: { error: 'Not Found' },
        headers: {}
      }
    }

    // Extract params from path
    const params = this.extractParams(route, path)

    // Build context
    const context: ResponseContext<TState> = {
      state: this.state,
      params,
      query: options?.query || {},
      body: options?.body,
      headers: options?.headers || {},
      method,
      path
    }

    // Execute response function
    const result = await route.definition.response(context)

    // Parse result
    if (Array.isArray(result)) {
      // Check if it's a tuple response [status, body, headers?]
      if (typeof result[0] === 'number') {
        const [status, body, headers] = result
        return {
          status,
          body,
          headers: headers || {}
        }
      }
    }

    return {
      status: 200,
      body: result,
      headers: {}
    }
  }

  /**
   * Find a route that matches the given method and path.
   */
  private findRoute(method: HttpMethod, path: string): CompiledRoute<TState> | undefined {
    return this.routes.find(route => 
      route.method === method && route.pattern.test(path)
    )
  }

  /**
   * Extract parameter values from the path based on the route pattern.
   */
  private extractParams(route: CompiledRoute<TState>, path: string): Record<string, string> {
    const match = path.match(route.pattern)
    if (!match) return {}

    const params: Record<string, string> = {}
    route.params.forEach((param, index) => {
      params[param] = match[index + 1]
    })

    return params
  }
}