// @harmoniq/client — zero runtime dependencies (DX-05). Types mirror ManifestSchema in
// @harmoniq/core (schemaVersion 2); they are duplicated here so the SDK stays standalone.

export interface ManifestModule {
  name: string;
  /** Import-map specifier when it differs from `name`. */
  specifier?: string;
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

/** Minimal Web Storage interface (localStorage, sessionStorage, or a test double). */
export interface ManifestStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface HarmoniqClientOptions {
  registryUrl: string;
  workspaceSlug: string;
  hostApp: string;
  environment: string;
  /**
   * Base URL of the published manifests (CDN in front of the storage bucket). When set,
   * the CDN copy is tried first and the registry second, so hosts keep working while the
   * registry is down. Published copies are always the stable variant.
   */
  cdnBaseUrl?: string;
  /** Full control over the manifest URLs to try, in order. Overrides `cdnBaseUrl`. */
  sources?: string[];
  /**
   * Manifest bundled with the host build (e.g. `harmoniq manifest pull --out …`), used
   * when no source is reachable and nothing is cached.
   */
  fallbackManifest?: Manifest;
  /**
   * Keep the last good manifest across page loads. Defaults to `localStorage` in
   * browsers; `false` disables it.
   */
  persist?: ManifestStore | false;
  /** Re-fetch the manifest on this interval (uses ETags, so unchanged manifests are cheap). */
  pollIntervalMs?: number;
  /** Upper bound for exponential backoff after failed polls. Default 60s. */
  maxBackoffMs?: number;
  /** Per-request timeout, per source. Default 5s. */
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

/** Where the current manifest came from. Anything but `network` is potentially stale. */
export type ManifestSource = 'network' | 'persisted' | 'fallback';

/** Event names, exported so adapters can never drift from the client (bug §4.11). */
export const EVENTS = {
  manifestUpdate: 'manifestUpdate',
  variantAssigned: 'variantAssigned',
  /** The manifest in use did not come from the network (registry and CDN unreachable). */
  manifestStale: 'manifestStale',
  error: 'error',
} as const;

type EventMap = {
  [EVENTS.manifestUpdate]: Manifest;
  [EVENTS.variantAssigned]: VariantAssignment;
  [EVENTS.manifestStale]: { source: ManifestSource; generatedAt: string };
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

function defaultStore(): ManifestStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // e.g. storage blocked by browser settings
  }
}

export class HarmoniqClient {
  private manifest: Manifest | null = null;
  private source: ManifestSource | null = null;
  private modules = new Map<string, ManifestModule>();
  /** ETags differ per source (a CDN's ETag is not the registry's). */
  private etags = new Map<string, string>();
  private lastError: Error | null = null;
  private initPromise: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private destroyed = false;
  private listeners = new Map<EventName, Set<Listener<never>>>();
  private readonly sources: string[];
  private readonly store: ManifestStore | null;
  private readonly storeKey: string;

  constructor(private readonly options: HarmoniqClientOptions) {
    const enc = encodeURIComponent;
    const { workspaceSlug: ws, hostApp, environment: env } = options;
    const path = `${enc(ws)}/${enc(hostApp)}/${enc(env)}`;
    const registry = `${options.registryUrl.replace(/\/$/, '')}/api/manifest/${path}`;
    this.sources =
      options.sources ??
      (options.cdnBaseUrl
        ? [`${options.cdnBaseUrl.replace(/\/$/, '')}/manifests/${path}.json`, registry]
        : [registry]);
    this.store = options.persist === false ? null : (options.persist ?? defaultStore());
    this.storeKey = `harmoniq:manifest:${ws}:${hostApp}:${env}`;
  }

  /**
   * Loads the manifest and starts polling. Idempotent: every caller shares one load and
   * there is only ever one poll loop. If every source fails, falls back to the persisted
   * copy, then to `fallbackManifest`; rejects only when none exists (call again to retry).
   */
  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.fetchManifest()
        .catch((err) => {
          if (!this.useOfflineCopy()) throw err;
        })
        .then(
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

  /** `network` when fresh; `persisted` or `fallback` while sources are unreachable. */
  getSource(): ManifestSource | null {
    return this.source;
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

  /**
   * Tries each source in order until one answers. On total failure the previous manifest
   * is kept (stale beats broken) and an `error` event is emitted; the error is rethrown.
   */
  private async fetchManifest(): Promise<void> {
    const failures: string[] = [];
    for (const url of this.sources) {
      try {
        if (await this.fetchFrom(url)) {
          this.lastError = null;
          this.consecutiveFailures = 0;
          return;
        }
      } catch (err) {
        failures.push(`${url}: ${(err as Error).message}`);
      }
    }
    const error = new Error(`No manifest source reachable (${failures.join('; ')})`);
    this.lastError = error;
    this.consecutiveFailures++;
    this.emit(EVENTS.error, error);
    throw error;
  }

  /** True when this source produced a usable answer (a manifest or a 304). */
  private async fetchFrom(url: string): Promise<boolean> {
    const doFetch = this.options.fetch ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    try {
      // Never sends credentials: manifests are public, and browsers must not hold API keys.
      const etag = this.etags.get(url);
      const res = await doFetch(url, {
        headers: etag ? { 'If-None-Match': etag } : {},
        signal: controller.signal,
      });
      if (res.status === 304 && this.manifest) {
        this.markFresh();
        return true;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: unknown = await res.json();
      if (!isManifest(body)) throw new Error('unsupported manifest format');
      const responseEtag = res.headers.get('ETag');
      if (responseEtag) this.etags.set(url, responseEtag);
      this.apply(body, 'network');
      this.persist(body);
      return true;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Uses the persisted copy, then the bundled fallback. Returns false if neither exists. */
  private useOfflineCopy(): boolean {
    const persisted = this.readPersisted();
    if (persisted) {
      this.apply(persisted, 'persisted');
    } else if (this.options.fallbackManifest && isManifest(this.options.fallbackManifest)) {
      this.apply(this.options.fallbackManifest, 'fallback');
    } else {
      return false;
    }
    this.emit(EVENTS.manifestStale, {
      source: this.source!,
      generatedAt: this.manifest!.generatedAt,
    });
    return true;
  }

  private markFresh() {
    this.source = 'network';
  }

  private readPersisted(): Manifest | null {
    try {
      const raw = this.store?.getItem(this.storeKey);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      // Only a manifest for exactly this workspace/host/environment.
      return isManifest(parsed) &&
        parsed.workspaceSlug === this.options.workspaceSlug &&
        parsed.hostApp?.slug === this.options.hostApp &&
        parsed.environment === this.options.environment
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  private persist(manifest: Manifest) {
    try {
      this.store?.setItem(this.storeKey, JSON.stringify(manifest));
    } catch {
      // Quota exceeded or storage blocked: persistence is best effort.
    }
  }

  private apply(manifest: Manifest, source: ManifestSource) {
    const previous = this.manifest;
    this.manifest = manifest;
    this.source = source;
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
