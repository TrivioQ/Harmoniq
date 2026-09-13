export type HarmoniqClientOptions = {
  registryUrl: string;
  workspaceSlug: string;
  hostApp: string;
  environment: string;
  apiKey?: string;
  pollIntervalMs?: number;
};

export type ModuleEntry = {
  url: string;
  integrity: string;
};

export type ReportOptions = {
  success: boolean;
  loadMs?: number;
  variant?: string;
  error?: Error;
};

export type ManifestModule = {
  id?: string;
  url: string;
  integrity?: string;
};

export type ManifestData = {
  version?: string;
  modules?: Record<string, ManifestModule>;
  [key: string]: unknown;
};

export type EventListener = (...args: unknown[]) => void;

export class HarmoniqClient {
  private options: HarmoniqClientOptions;
  private manifest: ManifestData | null = null;
  private etag: string | null = null;
  private isPolling = false;
  private listeners: Record<string, EventListener[]> = {};
  private variant?: string;

  constructor(options: HarmoniqClientOptions) {
    this.options = options;
  }

  public async init(): Promise<void> {
    await this.fetchManifest();
    if (this.options.pollIntervalMs && this.options.pollIntervalMs > 0) {
      this.startPolling();
    }
  }

  private async fetchManifest(): Promise<void> {
    const { registryUrl, workspaceSlug, hostApp, environment, apiKey } = this.options;
    const url = `${registryUrl}/api/manifest/${workspaceSlug}/${hostApp}/${environment}`;

    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (this.etag) headers['If-None-Match'] = this.etag;

    try {
      const response = await fetch(url, { headers });

      if (response.status === 304) {
        // Not modified
        return;
      }

      if (response.ok) {
        this.manifest = await response.json();
        this.etag = response.headers.get('ETag');

        const variant = response.headers.get('X-Harmoniq-Variant');
        if (variant) {
          this.variant = variant;
          if (variant !== 'stable') {
            this.emit('variantAssigned', variant);
          }
        }

        this.emit('manifestUpdate', this.manifest);
      } else {
        throw new Error(`Failed to fetch manifest: ${response.status}`);
      }
    } catch (error) {
      // Fallback to last known good manifest (stale-while-revalidate behavior)
      if (!this.manifest) {
        throw error;
      }
      console.warn('HarmoniqClient: Failed to update manifest, using stale version.', error);
    }
  }

  private startPolling() {
    this.isPolling = true;
    setInterval(() => {
      if (this.isPolling) {
        this.fetchManifest().catch(console.error);
      }
    }, this.options.pollIntervalMs);
  }

  public stopPolling() {
    this.isPolling = false;
  }

  public getModuleUrl(name: string): string | null {
    return this.manifest?.modules?.[name]?.url || null;
  }

  public getModuleEntry(name: string): ModuleEntry | null {
    const mod = this.manifest?.modules?.[name];
    if (!mod) return null;
    return { url: mod.url, integrity: mod.integrity || '' };
  }

  public getScriptTag(name: string): string | null {
    const entry = this.getModuleEntry(name);
    if (!entry) return null;
    return `<script type="module" src="${entry.url}" integrity="${entry.integrity}" crossorigin="anonymous"></script>`;
  }

  public async reportModuleLoad(name: string, options: ReportOptions): Promise<void> {
    const { registryUrl, workspaceSlug, environment, apiKey } = this.options;
    const moduleId = this.manifest?.modules?.[name]?.id || name; // Fallback to name if ID not in manifest

    const url = `${registryUrl}/api/modules/${moduleId}/health`;

    const payload = {
      workspaceSlug,
      environment,
      variant: options.variant || 'stable',
      success: options.success,
      loadMs: options.loadMs,
      errorMessage: options.error?.message,
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    try {
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    } catch (error) {
      console.error('HarmoniqClient: Failed to report module load health.', error);
    }
  }

  public getVariant(): string {
    return this.variant || 'stable';
  }

  public async reportModuleError(
    name: string,
    options: { error: string; variant: string }
  ): Promise<void> {
    await this.reportModuleLoad(name, {
      success: false,
      error: new Error(options.error),
      variant: options.variant,
    });
  }

  public on(event: string, callback: EventListener) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }

  public off(event: string, callback: EventListener) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((cb) => cb !== callback);
    }
  }

  private emit(event: string, ...args: unknown[]) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((cb) => cb(...args));
    }
  }
}
