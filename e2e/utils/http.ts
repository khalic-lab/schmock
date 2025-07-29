/**
 * HTTP client utilities for E2E testing
 */

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  json: () => any;
}

export async function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
  } = {}
): Promise<HttpResponse> {
  const {
    method = "GET",
    headers = {},
    body,
    timeout = 10000
  } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const responseBody = await response.text();
    const responseHeaders: Record<string, string> = {};
    
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      status: response.status,
      headers: responseHeaders,
      body: responseBody,
      json: () => {
        try {
          return JSON.parse(responseBody);
        } catch (error) {
          throw new Error(`Failed to parse JSON response: ${responseBody}`);
        }
      }
    };
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`HTTP request timeout after ${timeout}ms`);
    }
    
    throw error;
  }
}

export async function waitForServer(
  url: string, 
  timeout: number = 30000,
  interval: number = 500
): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    try {
      await httpRequest(url, { timeout: 2000 });
      return; // Server is ready
    } catch (error) {
      // Server not ready yet, wait and retry
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }
  
  throw new Error(`Server at ${url} did not become ready within ${timeout}ms`);
}