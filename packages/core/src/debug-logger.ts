/**
 * Debug logger that respects debug mode configuration
 */
export class DebugLogger {
  constructor(private enabled = false) {}

  log(category: string, message: string, data?: unknown) {
    if (!this.enabled) return;

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [SCHMOCK:${category.toUpperCase()}]`;

    if (data) {
      console.log(`${prefix} ${message}`, data);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }

  time(label: string) {
    if (!this.enabled) return;
    console.time(`[SCHMOCK] ${label}`);
  }

  timeEnd(label: string) {
    if (!this.enabled) return;
    console.timeEnd(`[SCHMOCK] ${label}`);
  }
}
