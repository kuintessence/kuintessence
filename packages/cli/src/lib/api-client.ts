import { unwrapApiResponse } from "@kuintessence/shared";
import type { CliConfig } from "./config";

export { ApiError } from "@kuintessence/shared";

export class ApiClient {
  constructor(
    private baseUrl: string,
    private token?: string,
  ) {}

  static fromConfig(config: CliConfig): ApiClient {
    return new ApiClient(config.serverUrl, config.token);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(res);
  }

  async get<T = unknown>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api${path}`, {
      headers: this.headers(),
    });
    return this.parseResponse<T>(res);
  }

  async delete<T = unknown>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api${path}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    return this.parseResponse<T>(res);
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    return unwrapApiResponse<T>(res);
  }
}
