// @harmoniq/client — zero runtime dependencies (DX-05). Types mirror ManifestSchema in
// @harmoniq/core (schemaVersion 2); they are duplicated here so the SDK stays standalone.

export interface ManifestModule {
  name: string;
  url: string;
  integrity: string;
  version: string;
  dependencies?: Record<string, string>;
  exposes?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface Manifest {
  schemaVersion: 2;
  workspaceSlug: string;
  hostApp: { slug: string; name: string };
  environment: string;
  variant: 'stable' | 'canary';
  cohortId: string;
  generatedAt: string;
  etag: string;
  modules: ManifestModule[];
}

export interface HarmoniqClientOptions {
  registryUrl: string;
  workspaceSlug: string;
  hostApp: string;
  environment: string;
  /** Re-fetch the manifest on this interval (uses ETags, so unchanged manifests are cheap). */
  pollIntervalMs?: number;
  /** Upper bound for exponential backoff after failed polls. Default 60s. */
  maxBackoffMs?: number;
  /** Per-request timeout. Default 5s. */
  timeoutMs?: number;
  /** Custom fetch (tests, SSR polyfills). */
  fetch?: typeof fetch;
}

export interface ModuleEntry {
  url: string;
  integrity: string;
  version: string;
}

export interface VariantAssignment {
  variant: Manifest['variant'];
  cohortId: string;
}

/** Event names, exported so adapters can never drift from the client (bug §4.11). */
export const EVENTS = {
  manifestUpdate: 'manifestUpdate',
  variantAssigned: 'variantAssigned',
  error: 'error',
} as const;

type EventMap = {
  [EVENTS.manifestUpdate]: Manifest;
  [EVENTS.variantAssigned]: VariantAssignment;
  [EVENTS.error]: Error;
};
type EventName = keyof EventMap;
type Listener<E extends EventName> = (payload: EventMap[E]) => void;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

const escapeAttr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function isManifest(value: unknown): value is Manifest {
  const m = value as Partial<Manifest> | null;
  return !!m && m.schemaVersion === 2 && Array.isArray(m.modules);
}

export class HarmoniqClient {
  private manifest: Manifest | null = null;
  private modules = new Map<string, ManifestModule>();
  private etag: string | null = null;
  private lastError: Error | null = null;
  private initPromise: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private destroyed = false;
  private listeners = new Map<EventName, Set<Listener<never>>>();

  constructor(private readonly options: HarmoniqClientOptions) {}

  /**
   * Loads the manifest and starts polling. Idempotent: every caller shares one load and
   * there is only ever one poll loop. Rejects if the first load fails; call again to retry.
   */
  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.fetchManifest().then(
        () => this.scheduleNextPoll(),
        (err) => {
          this.initPromise = null;
          throw err;
        }
      );
    }
    return this.initPromise;
  }

  /** Stops polling and drops listeners. The last manifest stays readable. */
  destroy() {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  /** @deprecated Use destroy(). */
  stopPolling() {
    this.destroy();
  }

  getManifest(): Manifest | null {
    return this.manifest;
  }

  /** The error from the most recent failed fetch, cleared by the next success. */
  getError(): Error | null {
    return this.lastError;
  }

  getModule(name: string): ManifestModule | null {
    return this.modules.get(name) ?? null;
  }

  getModuleUrl(name: string): string | null {
    return this.modules.get(name)?.url ?? null;
  }

  getModuleEntry(name: string): ModuleEntry | null {
    const mod = this.modules.get(name);
    return mod ? { url: mod.url, integrity: mod.integrity, version: mod.version } : null;
  }

  /** SRI-02: a ready-to-inject script tag; attribute values are HTML-escaped. */
  getScriptTag(name: string): string | null {
    const entry = this.getModuleEntry(name);
    if (!entry) return null;
    return `<script type="module" src="${escapeAttr(entry.url)}" integrity="${escapeAttr(entry.integrity)}" crossorigin="anonymous"></script>`;
  }

  getVariant(): Manifest['variant'] {
    return this.manifest?.variant ?? 'stable';
  }

  getCohortId(): string | null {
    return this.manifest?.cohortId ?? null;
  }

  /** Subscribes to an event; returns the unsubscribe function. */
  on<E extends EventName>(event: E, listener: Listener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  off<E extends EventName>(event: E, listener: Listener<E>) {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  private emit<E extends EventName>(event: E, payload: EventMap[E]) {
    this.listeners.get(event)?.forEach((listener) => (listener as Listener<E>)(payload));
  }

  private get url() {
    const { registryUrl, workspaceSlug, hostApp, environment } = this.options;
    const enc = encodeURIComponent;
    return `${registryUrl.replace(/\/$/, '')}/api/manifest/${enc(workspaceSlug)}/${enc(hostApp)}/${enc(environment)}`;
  }

  /**
   * One conditional request. On failure the previous manifest is kept (stale beats
   * broken) and an `error` event is emitted; the error is rethrown to the caller.
   */
  private async fetchManifest(): Promise<void> {
    const doFetch = this.options.fetch ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    try {
      // Never sends credentials: manifests are public, and browsers must not hold API keys.
      const res = await doFetch(this.url, {
        headers: this.etag ? { 'If-None-Match': this.etag } : {},
        signal: controller.signal,
      });
      if (res.status === 304) {
        this.succeeded();
        return;
      }
      if (!res.ok) throw new Error(`Manifest request failed with HTTP ${res.status}`);
      const body: unknown = await res.json();
      if (!isManifest(body)) throw new Error('Registry returned an unsupported manifest format');
      this.apply(body, res.headers.get('ETag'));
      this.succeeded();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.lastError = error;
      this.consecutiveFailures++;
      this.emit(EVENTS.error, error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private succeeded() {
    this.lastError = null;
    this.consecutiveFailures = 0;
  }

  private apply(manifest: Manifest, etag: string | null) {
    const previous = this.manifest;
    this.manifest = manifest;
    this.etag = etag ?? `"${manifest.etag}"`;
    this.modules = new Map(manifest.modules.map((m) => [m.name, m]));

    if (previous?.etag !== manifest.etag) this.emit(EVENTS.manifestUpdate, manifest);
    // CAN-10: emitted on the first assignment and whenever it changes, not on every poll.
    if (previous?.variant !== manifest.variant || previous?.cohortId !== manifest.cohortId) {
      this.emit(EVENTS.variantAssigned, { variant: manifest.variant, cohortId: manifest.cohortId });
    }
  }

  private scheduleNextPoll() {
    const interval = this.options.pollIntervalMs;
    if (!interval || interval <= 0 || this.destroyed || this.timer) return;

    // Exponential backoff with jitter after failures, so a registry outage isn't
    // hammered by every open tab at once.
    const max = this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    const delay = this.consecutiveFailures
      ? Math.min(interval * 2 ** this.consecutiveFailures, max) * (0.75 + Math.random() * 0.5)
      : interval;

    this.timer = setTimeout(() => {
      this.timer = null;
      this.fetchManifest()
        .catch(() => undefined) // already emitted as an `error` event
        .finally(() => this.scheduleNextPoll());
    }, delay);
  }
}
