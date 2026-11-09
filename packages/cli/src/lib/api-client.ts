import { unwrapApiResponse } from "@kuintessence/shared";
import type { CliConfig } from "./config";

export { ApiError } from "@kuintessence/shared";

export class ApiClient {
  constructor(
    private baseUrl: string,
    private token?: string,
    private context?: { organizationId?: string },
  ) {}

  static fromConfig(config: CliConfig): ApiClient {
    return new ApiClient(config.serverUrl, config.token);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (this.context?.organizationId) h["X-KQ-Active-Organization"] = this.context.organizationId;
    return h;
  }

  private requestOptions(): RequestInit {
    return this.context ? { redirect: "error", signal: AbortSignal.timeout(30000) } : {};
  }

  async put<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api${path}`, {
      ...this.requestOptions(),
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(res);
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api${path}`, {
      ...this.requestOptions(),
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(res);
  }

  async get<T = unknown>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api${path}`, {
      ...this.requestOptions(),
      headers: this.headers(),
    });
    return this.parseResponse<T>(res);
  }

  async patch<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api${path}`, {
      ...this.requestOptions(),
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(res);
  }

  async delete<T = unknown>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api${path}`, {
      ...this.requestOptions(),
      method: "DELETE",
      headers: this.headers(),
    });
    return this.parseResponse<T>(res);
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    return unwrapApiResponse<T>(res);
  }
}
