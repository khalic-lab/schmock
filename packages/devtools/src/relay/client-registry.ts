import type { CacheLike, CacheStorageLike } from "./types.js";

/**
 * The set of client ids that are relaying, kept durable in the Cache API so a
 * restarted worker still knows them. Every failure degrades to memory-only.
 */
export class ClientRegistry {
  readonly ready: Promise<void>;
  private readonly ids = new Set<string>();
  private cache: CacheLike | undefined;
  private isLoaded = false;
  private queue: Promise<unknown>;

  constructor(
    storage: CacheStorageLike | undefined,
    cacheName: string,
    private readonly key: string,
  ) {
    this.ready = this.load(storage, cacheName).then(() => {
      this.isLoaded = true;
    });
    this.queue = this.ready;
  }

  get loaded(): boolean {
    return this.isLoaded;
  }

  has(id: string): boolean {
    return this.isLoaded && this.ids.has(id);
  }

  add(id: string): Promise<void> {
    return this.enqueue(() => {
      this.ids.add(id);
    });
  }

  delete(id: string): Promise<void> {
    return this.enqueue(() => {
      this.ids.delete(id);
    });
  }

  retain(liveIds: Iterable<string>): Promise<void> {
    const live = new Set(liveIds);
    return this.enqueue(() => {
      for (const id of [...this.ids]) {
        if (!live.has(id)) this.ids.delete(id);
      }
    });
  }

  private async load(
    storage: CacheStorageLike | undefined,
    cacheName: string,
  ): Promise<void> {
    if (storage === undefined) return;
    try {
      const cache = await storage.open(cacheName);
      const stored = await cache.match(this.key);
      this.cache = cache;
      if (stored === undefined) return;
      const text = await stored.text();
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (typeof entry === "string") this.ids.add(entry);
          }
        }
      } catch {
        this.ids.clear();
      }
    } catch {
      this.cache = undefined;
      this.ids.clear();
    }
  }

  private enqueue(mutate: () => void): Promise<void> {
    const run = async (): Promise<void> => {
      mutate();
      const cache = this.cache;
      if (cache === undefined) return;
      try {
        await cache.put(
          this.key,
          new Response(JSON.stringify([...this.ids]), {
            headers: { "content-type": "application/json" },
          }),
        );
      } catch {
        this.cache = undefined;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next;
    return next;
  }
}
