import { RespanClient } from '@respan/respan-api';

const DEFAULT_BASE_URL = "https://api.respan.ai/api";
const REQUEST_TIMEOUT_MS = 180_000;

export interface AuthConfig {
  token: string;
  baseUrl: string;
}

export interface ToolDeps {
  client: RespanClient | null;
  auth: AuthConfig | null;
}

export function createClient(auth: AuthConfig): RespanClient {
  return new RespanClient({
    token: auth.token,
    ...(auth.baseUrl !== DEFAULT_BASE_URL ? { environment: auth.baseUrl } : {}),
  });
}

export function resolveAuthFromEnv(): AuthConfig | null {
  const token = process.env.RESPAN_API_KEY;
  if (!token) return null;
  return {
    token,
    baseUrl: process.env.RESPAN_API_BASE_URL || DEFAULT_BASE_URL,
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

/**
 * Validate that a path parameter is safe (alphanumeric, hyphens, underscores, dots, @).
 * Prevents path traversal attacks via user-supplied IDs.
 */
export function validatePathParam(value: string, name: string): string {
  if (!/^[\w.@-]+$/.test(value)) {
    throw new Error(`Invalid ${name}: contains disallowed characters`);
  }
  return value;
}

/**
 * Direct HTTP request helper for API endpoints not covered by the SDK.
 */
export async function respanRequest(
  endpoint: string,
  auth: AuthConfig,
  options: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    queryParams?: Record<string, any>;
    body?: any;
  } = {}
) {
  const { method = "GET", queryParams = {}, body } = options;

  const filteredParams = Object.fromEntries(
    Object.entries(queryParams).filter(([_, v]) => v !== undefined)
  );

  const queryString = new URLSearchParams(filteredParams).toString();
  const url = `${auth.baseUrl}/${endpoint}${queryString ? `?${queryString}` : ""}`;

  const response = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${auth.token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`API Error: ${response.status} - ${JSON.stringify(err)}`);
  }

  return await response.json();
}
