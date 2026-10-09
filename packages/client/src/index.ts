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
   * Identifies the user for canary assignment (CAN-02): the same id always gets the same
   * variant. Sent as `X-Harmoniq-User-Id`, to the registry only. While a user key is set,
   * the registry is asked before the CDN, whose copy is always the stable variant. Use an
   * opaque id; the registry only ever exposes a hash of it (`cohortId`).
   */
  userId?: string;
  /**
   * Without `userId`, give anonymous visitors a random id kept in `persist` storage, so
   * they can take part in canaries and stay in their variant across visits.
   */
  anonymousCanary?: boolean;
  /**
   * Manifest bundled with the host build (e.g. `harmoniq manifest pull --out …`), used
   * when no source is reachable and nothing is cached.
   */
  fallbackManifest?: Manifest;
  /**
   * Let developers point modules at local builds (M2.6). Overrides come from `overrides`,
   * the `?harmoniq-override=name@url` query parameter (comma-separated for several) and
   * `localStorage['harmoniq:overrides']` (`{ "name": "url" }`). Overridden modules have no
   * integrity check. Enable outside production only, e.g.
   * `allowOverrides: process.env.NODE_ENV !== 'production'`.
   */
  allowOverrides?: boolean;
  overrides?: Record<string, string>;
  /**
   * Query parameter that selects the environment, e.g. `harmoniq-env` for preview links
   * (`?harmoniq-env=pr-123`). Enable on non-production hosts only.
   */
  environmentFromQuery?: string;
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
  /**
   * Report module load outcomes to the registry (HLT-01), used for health dashboards,
   * canary comparisons and alerts. Off by default. Reports are batched and sent with
   * `navigator.sendBeacon` when available; `sampleRate` (0–1) keeps a share of them.
   */
  reportHealth?: boolean | { sampleRate?: number; flushIntervalMs?: number };
}

/** A module load outcome for `reportModuleLoad`. */
export interface ModuleLoadReport {
  success: boolean;
  loadMs?: number;
  error?: unknown;
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
  /** Some modules are served from developer overrides instead of the manifest. */
  overrideActive: 'overrideActive',
  error: 'error',
} as const;

type EventMap = {
  [EVENTS.manifestUpdate]: Manifest;
  [EVENTS.variantAssigned]: VariantAssignment;
  [EVENTS.manifestStale]: { source: ManifestSource; generatedAt: string };
  [EVENTS.overrideActive]: Record<string, string>;
  [EVENTS.error]: Error;
};
type EventName = keyof EventMap;
type Listener<E extends EventName> = (payload: EventMap[E]) => void;

const DEFAULT_TIMEOUT_MS = 5_000;
const SDK_VERSION = '1.0.0';
const HEALTH_BATCH_SIZE = 20;
const HEALTH_MAX_EVENTS = 50; // per request, the registry's limit
const HEALTH_FLUSH_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

const escapeAttr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function isManifest(value: unknown): value is Manifest {
  const m = value as Partial<Manifest> | null;
  return !!m && m.schemaVersion === 2 && Array.isArray(m.modules);
}

const OVERRIDES_KEY = 'harmoniq:overrides';
const ANONYMOUS_ID_KEY = 'harmoniq:uid';
const USER_ID_HEADER = 'X-Harmoniq-User-Id';
/** Registry manifest URLs; only these receive the user id (CDNs may reject the header). */
const isRegistryManifestUrl = (url: string) => url.includes('/api/manifest/');

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}
const isHttpUrl = (value: string) => /^https?:\/\//i.test(value);

function queryParams(): URLSearchParams | null {
  try {
    return typeof location === 'undefined' ? null : new URLSearchParams(location.search);
  } catch {
    return null;
  }
}

/** `name@url` pairs from the query string, comma-separated. URLs may contain `@`. */
function overridesFromQuery(params: URLSearchParams | null): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of params?.getAll('harmoniq-override') ?? []) {
    for (const pair of value.split(',')) {
      const at = pair.indexOf('@', 1); // scoped names start with @
      if (at > 0) result[pair.slice(0, at)] = pair.slice(at + 1);
    }
  }
  return result;
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
  private readonly cdnSource: string | null;
  private readonly registrySource: string;
  private userKey: string | null;
  private readonly store: ManifestStore | null;
  private readonly storeKey: string;
  private readonly overrides: Record<string, string>;
  private readonly environment: string;
  private readonly healthUrl: string;
  private healthQueue: Array<{
    module: string;
    version: string;
    success: boolean;
    loadMs?: number;
    error?: string;
  }> = [];
  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onPageHide = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'hidden') {
      this.flushHealth();
    }
  };

  constructor(private readonly options: HarmoniqClientOptions) {
    const enc = encodeURIComponent;
    const params = queryParams();
    const fromQuery = options.environmentFromQuery && params?.get(options.environmentFromQuery);
    this.environment = fromQuery || options.environment;
    const { workspaceSlug: ws, hostApp } = options;
    const env = this.environment;
    const path = `${enc(ws)}/${enc(hostApp)}/${enc(env)}`;
    this.registrySource = `${options.registryUrl.replace(/\/$/, '')}/api/manifest/${path}`;
    this.healthUrl = `${options.registryUrl.replace(/\/$/, '')}/api/health/${path}`;
    if (options.reportHealth && typeof addEventListener === 'function') {
      // Deliver what's queued before the page goes away (bfcache, tab close, navigation).
      addEventListener('visibilitychange', this.onPageHide);
      addEventListener('pagehide', this.onPageHide);
    }
    this.cdnSource = options.cdnBaseUrl
      ? `${options.cdnBaseUrl.replace(/\/$/, '')}/manifests/${path}.json`
      : null;
    this.store = options.persist === false ? null : (options.persist ?? defaultStore());
    this.userKey = options.userId || (options.anonymousCanary ? this.anonymousId() : null);
    this.storeKey = `harmoniq:manifest:${ws}:${hostApp}:${env}`;
    this.overrides = options.allowOverrides ? this.loadOverrides(params) : {};
  }

  /** Manifest URLs to try, in order. */
  private get sources(): string[] {
    if (this.options.sources) return this.options.sources;
    if (!this.cdnSource) return [this.registrySource];
    // Only the registry assigns canary variants; the CDN stays the fallback.
    return this.userKey
      ? [this.registrySource, this.cdnSource]
      : [this.cdnSource, this.registrySource];
  }

  /** A random id for this browser, kept across visits (`anonymousCanary`). */
  private anonymousId(): string | null {
    try {
      const existing = this.store?.getItem(ANONYMOUS_ID_KEY);
      if (existing) return existing;
      const id = randomId();
      this.store?.setItem(ANONYMOUS_ID_KEY, id);
      return id;
    } catch {
      return null;
    }
  }

  /**
   * Sets (or clears) the user for canary assignment, e.g. after sign-in, and re-fetches
   * the manifest so the user's variant applies immediately.
   */
  async setUserId(userId: string | null): Promise<void> {
    const next = userId || (this.options.anonymousCanary ? this.anonymousId() : null);
    if (next === this.userKey) return;
    this.userKey = next;
    this.etags.clear(); // the cached response belonged to the previous user
    if (this.initPromise) await this.fetchManifest().catch(() => undefined);
  }

  /** Developer overrides in effect (empty unless `allowOverrides`). */
  getOverrides(): Record<string, string> {
    return { ...this.overrides };
  }

  /** The environment in use (may come from `environmentFromQuery`). */
  getEnvironment(): string {
    return this.environment;
  }

  private loadOverrides(params: URLSearchParams | null): Record<string, string> {
    let stored: Record<string, string> = {};
    try {
      const raw = (this.options.persist === false ? null : defaultStore())?.getItem(OVERRIDES_KEY);
      stored = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      stored = {};
    }
    const merged = { ...stored, ...this.options.overrides, ...overridesFromQuery(params) };
    return Object.fromEntries(
      Object.entries(merged).filter(([, url]) => typeof url === 'string' && isHttpUrl(url))
    );
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
    this.flushHealth();
    if (typeof removeEventListener === 'function') {
      removeEventListener('visibilitychange', this.onPageHide);
      removeEventListener('pagehide', this.onPageHide);
    }
  }

  /**
   * HLT-01: records how loading a module went. The version comes from the manifest in
   * use; overridden modules and modules not in the manifest are not reported. No-op
   * unless `reportHealth` is on.
   */
  reportModuleLoad(name: string, report: ModuleLoadReport) {
    const health = this.options.reportHealth;
    if (!health) return;
    const sampleRate = typeof health === 'object' ? (health.sampleRate ?? 1) : 1;
    if (sampleRate < 1 && Math.random() >= sampleRate) return;
    const mod = this.modules.get(name);
    if (!mod || this.overrides[name]) return;

    const error =
      report.error === undefined
        ? undefined
        : (report.error instanceof Error
            ? `${report.error.name}: ${report.error.message}`
            : String(report.error)
          ).slice(0, 500);
    this.healthQueue.push({
      module: name,
      version: mod.version,
      success: report.success,
      ...(report.loadMs !== undefined && { loadMs: Math.max(0, Math.round(report.loadMs)) }),
      ...(error && !report.success && { error }),
    });

    if (this.healthQueue.length >= HEALTH_BATCH_SIZE) {
      this.flushHealth();
    } else if (!this.healthTimer) {
      const interval =
        typeof health === 'object' ? (health.flushIntervalMs ?? HEALTH_FLUSH_MS) : HEALTH_FLUSH_MS;
      this.healthTimer = setTimeout(() => this.flushHealth(), interval);
    }
  }

  /** Shorthand for a failed load. */
  reportModuleError(name: string, error: unknown) {
    this.reportModuleLoad(name, { success: false, error });
  }

  /** Sends queued health reports now. Called automatically; safe to call any time. */
  flushHealth() {
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = null;
    while (this.healthQueue.length) {
      const events = this.healthQueue.splice(0, HEALTH_MAX_EVENTS);
      // text/plain keeps it a "simple" cross-origin request: no preflight, beacon-safe.
      const body = JSON.stringify({ events, client: `harmoniq-js/${SDK_VERSION}` });
      const beacon =
        !this.options.fetch && typeof navigator !== 'undefined' && navigator.sendBeacon
          ? navigator.sendBeacon(
              this.healthUrl,
              new Blob([body], { type: 'text/plain;charset=UTF-8' })
            )
          : false;
      if (!beacon) {
        const doFetch = this.options.fetch ?? (typeof fetch === 'function' ? fetch : null);
        void doFetch?.(this.healthUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body,
          keepalive: true,
        }).catch(() => undefined); // health reporting must never affect the host
      }
    }
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
    // Overridden (local) modules have no hash: omit the attribute rather than emit an empty one.
    const integrity = entry.integrity ? ` integrity="${escapeAttr(entry.integrity)}"` : '';
    return `<script type="module" src="${escapeAttr(entry.url)}"${integrity} crossorigin="anonymous"></script>`;
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
      const headers: Record<string, string> = etag ? { 'If-None-Match': etag } : {};
      if (this.userKey && isRegistryManifestUrl(url)) headers[USER_ID_HEADER] = this.userKey;
      const res = await doFetch(url, { headers, signal: controller.signal });
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
        parsed.environment === this.environment
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
    const overridden = Object.keys(this.overrides);
    for (const name of overridden) {
      // Local builds have no integrity hash; the version marks the entry as overridden.
      this.modules.set(name, {
        name,
        url: this.overrides[name],
        integrity: '',
        version: 'override',
      });
    }
    if (overridden.length && !previous) {
      console.warn(`[harmoniq] Serving overridden modules: ${overridden.join(', ')}`);
      this.emit(EVENTS.overrideActive, { ...this.overrides });
    }

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
