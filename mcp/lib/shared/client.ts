import { RespanClient } from '@respan/respan-api';

export interface AuthConfig {
  token: string;
  baseUrl?: string;
}

export function createClient(auth: AuthConfig): RespanClient {
  return new RespanClient({
    token: auth.token,
    ...(auth.baseUrl ? { environment: auth.baseUrl } : {}),
  });
}

export function resolveAuthFromEnv(): AuthConfig | null {
  const token = process.env.RESPAN_API_KEY;
  if (!token) return null;
  return {
    token,
    baseUrl: process.env.RESPAN_API_BASE_URL || undefined,
  };
}

export function requireClient(client: RespanClient | null): RespanClient {
  if (!client) {
    throw new Error(
      'This tool requires authentication. Please set RESPAN_API_KEY to use it.'
    );
  }
  return client;
}
