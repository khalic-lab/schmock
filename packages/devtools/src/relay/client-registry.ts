import type { CacheLike, CacheStorageLike } from "./types.js";

/** The string ids in a stored list; none when it is not a JSON array. */
function parseIds(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

/**
 * The set of client ids that are relaying, kept durable in the Cache API so a
 * restarted worker still knows them. Every failure degrades to memory-only.
 */
export class ClientRegistry {
  readonly ready: Promise<void>;
  private readonly ids = new Set<string>();
  /** False once Cache Storage failed: the registry then lives in memory only. */
  private persistent: boolean;
  private isLoaded = false;
  private queue: Promise<unknown>;

  constructor(
    private readonly storage: CacheStorageLike | undefined,
    private readonly cacheName: string,
    private readonly key: string,
  ) {
    this.persistent = storage !== undefined;
    this.ready = this.load().then(() => {
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

  /** Keep only `liveIds`, durably. */
  retain(liveIds: Iterable<string>): Promise<void> {
    const live = new Set(liveIds);
    return this.enqueue(() => {
      for (const id of [...this.ids]) {
        if (!live.has(id)) this.ids.delete(id);
      }
    });
  }

  private async load(): Promise<void> {
    const cache = await this.open();
    if (cache === undefined) return;
    for (const id of (await this.readStored(cache)) ?? []) this.ids.add(id);
  }

  /**
   * The named cache, opened again for every use: app code that deletes it
   * leaves an earlier handle working but orphaned, so writes through that
   * handle would never be read back. Undefined once Cache Storage failed.
   */
  private async open(): Promise<CacheLike | undefined> {
    if (!this.persistent || this.storage === undefined) return undefined;
    try {
      return await this.storage.open(this.cacheName);
    } catch {
      this.persistent = false;
      return undefined;
    }
  }

  /**
   * The stored ids; undefined when none are stored (app code deleted the
   * cache) or the read failed, which also makes the registry memory-only.
   */
  private async readStored(cache: CacheLike): Promise<string[] | undefined> {
    try {
      const stored = await cache.match(this.key);
      return stored === undefined ? undefined : parseIds(await stored.text());
    } catch {
      this.persistent = false;
      return undefined;
    }
  }

  /**
   * Run `mutate` against the stored list, then store the result. The stored
   * list, not this instance's memory, is the starting point whenever it
   * exists: a new worker version loads the list when its script runs, and the
   * version still active may change it (a goodbye) before the new one handles
   * its first message or activates. Memory is the starting point only when
   * the list is gone (app code deleted the cache), so it is written back
   * whole, or when Cache Storage failed.
   */
  private enqueue(mutate: () => void): Promise<void> {
    const run = async (): Promise<void> => {
      const cache = await this.open();
      const stored =
        cache === undefined ? undefined : await this.readStored(cache);
      if (stored !== undefined) {
        this.ids.clear();
        for (const id of stored) this.ids.add(id);
      }
      mutate();
      if (cache === undefined || !this.persistent) return;
      try {
        await cache.put(
          this.key,
          new Response(JSON.stringify([...this.ids]), {
            headers: { "content-type": "application/json" },
          }),
        );
      } catch {
        this.persistent = false;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next;
    return next;
  }
}
