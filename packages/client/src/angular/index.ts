import { Inject, Injectable, InjectionToken, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable, combineLatest, map } from 'rxjs';
import { EVENTS, HarmoniqClient } from '../index';
import type { HarmoniqClientOptions, Manifest } from '../index';

export const HARMONIQ_OPTIONS = new InjectionToken<HarmoniqClientOptions>('HARMONIQ_OPTIONS');

export interface ModuleState {
  url: string | null;
  integrity: string | null;
  version: string | null;
  loading: boolean;
  error: Error | null;
  /** Kill switch: render a fallback instead of the module. */
  disabled: boolean;
  disabledReason: string | null;
}

/** ADP-03. One client per injector; destroyed with it. */
@Injectable({ providedIn: 'root' })
export class HarmoniqService implements OnDestroy {
  private readonly client: HarmoniqClient;
  private readonly manifestSubject = new BehaviorSubject<Manifest | null>(null);
  private readonly errorSubject = new BehaviorSubject<Error | null>(null);

  /** Emits every new manifest (null until the first one loads). */
  readonly manifest$: Observable<Manifest | null> = this.manifestSubject.asObservable();

  constructor(@Inject(HARMONIQ_OPTIONS) options: HarmoniqClientOptions) {
    this.client = new HarmoniqClient(options);
    this.client.on(EVENTS.manifestUpdate, (manifest) => {
      this.errorSubject.next(null);
      this.manifestSubject.next(manifest);
    });
    this.client.on(EVENTS.error, (error) => this.errorSubject.next(error));
    if (typeof window !== 'undefined') this.client.init().catch(() => undefined);
  }

  getClient(): HarmoniqClient {
    return this.client;
  }

  getModule(moduleName: string): Observable<ModuleState> {
    return combineLatest([this.manifestSubject, this.errorSubject]).pipe(
      map(([manifest, error]) => {
        const none = {
          url: null,
          integrity: null,
          version: null,
          disabled: false,
          disabledReason: null,
        };
        const entry = manifest ? this.client.getModuleEntry(moduleName) : null;
        if (entry) return { ...none, ...entry, loading: false, error: null };
        const killed = manifest ? this.client.isModuleDisabled(moduleName) : null;
        if (killed) {
          return {
            ...none,
            disabled: true,
            disabledReason: killed.reason,
            loading: false,
            error: null,
          };
        }
        if (manifest) {
          return {
            ...none,
            loading: false,
            error: new Error(`Module "${moduleName}" is not in the manifest`),
          };
        }
        return { ...none, loading: !error, error };
      })
    );
  }

  ngOnDestroy() {
    this.client.destroy();
    this.manifestSubject.complete();
    this.errorSubject.complete();
  }
}
