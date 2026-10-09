import { CliError, EXIT, exitCodeForStatus } from './errors';

export class ApiClient {
  constructor(
    private baseUrl: string,
    private apiKey?: string,
    private extraHeaders: Record<string, string> = {}
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
          ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
          ...this.extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new CliError(
        `Cannot reach registry at ${this.baseUrl}: ${(err as Error).message}`,
        EXIT.generic
      );
    }

    const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    if (!res.ok) {
      const error = (data as { error?: { message?: string; details?: unknown } } | undefined)
        ?.error;
      throw new CliError(
        error?.message ?? `Registry returned HTTP ${res.status}`,
        exitCodeForStatus(res.status),
        error?.details
      );
    }
    return data as T;
  }

  get<T>(path: string) {
    return this.request<T>('GET', path);
  }

  put<T>(path: string, body: unknown) {
    return this.request<T>('PUT', path, body);
  }

  post<T>(path: string, body: unknown) {
    return this.request<T>('POST', path, body);
  }
}
