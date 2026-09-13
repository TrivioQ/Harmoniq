import { Injectable, Inject, InjectionToken } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { HarmoniqClient } from '../index';
import type { HarmoniqClientOptions } from '../index';

export const HARMONIQ_OPTIONS = new InjectionToken<HarmoniqClientOptions>('HARMONIQ_OPTIONS');

export interface ModuleState {
  url: string | null;
  integrity: string | null;
  loading: boolean;
  error: Error | null;
}

@Injectable({
  providedIn: 'root',
})
export class HarmoniqService {
  private client: HarmoniqClient;
  private moduleStates = new Map<string, BehaviorSubject<ModuleState>>();

  constructor(@Inject(HARMONIQ_OPTIONS) private options: HarmoniqClientOptions) {
    this.client = new HarmoniqClient(this.options);
    this.client.init().catch(console.error);

    this.client.on('manifestUpdated', () => {
      for (const moduleName of this.moduleStates.keys()) {
        this.updateModuleState(moduleName);
      }
    });
  }

  public getClient(): HarmoniqClient {
    return this.client;
  }

  public getModule(moduleName: string): Observable<ModuleState> {
    if (!this.moduleStates.has(moduleName)) {
      const subject = new BehaviorSubject<ModuleState>({
        url: null,
        integrity: null,
        loading: true,
        error: null,
      });
      this.moduleStates.set(moduleName, subject);
      this.updateModuleState(moduleName);
    }
    return this.moduleStates.get(moduleName)!.asObservable();
  }

  private async updateModuleState(moduleName: string) {
    const subject = this.moduleStates.get(moduleName)!;
    try {
      await this.client.init();
      const entry = this.client.getModuleEntry(moduleName);
      if (entry) {
        subject.next({
          url: entry.url,
          integrity: entry.integrity || null,
          loading: false,
          error: null,
        });
        this.client.reportModuleLoad(moduleName, {
          success: true,
          variant: this.client.getVariant(),
        });
      } else {
        const err = new Error(`Module ${moduleName} not found in manifest`);
        subject.next({ url: null, integrity: null, loading: false, error: err });
        this.client.reportModuleError(moduleName, {
          error: err.message,
          variant: this.client.getVariant(),
        });
      }
    } catch (err: unknown) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      subject.next({ url: null, integrity: null, loading: false, error: errorObj });
      this.client.reportModuleError(moduleName, {
        error: errorObj.message,
        variant: this.client.getVariant(),
      });
    }
  }
}
