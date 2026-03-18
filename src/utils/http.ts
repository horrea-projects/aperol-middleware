import fetch from "cross-fetch";
import { logger } from "./logger";

export interface HttpRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  body?: any;
  retryCount?: number;
  retryDelayMs?: number;
}

export async function httpRequest<T = any>(url: string, options: HttpRequestOptions = {}): Promise<T> {
  const {
    method = "GET",
    headers = {},
    body,
    retryCount = 3,
    retryDelayMs = 300
  } = options;

  let attempt = 0;
  let lastError: unknown;

  while (attempt < retryCount) {
    try {
      const resp = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers
        },
        body: body ? JSON.stringify(body) : undefined
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`HTTP ${resp.status} - ${resp.statusText} - ${text}`);
      }

      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        return (await resp.json()) as T;
      }
      // @ts-expect-error T peut être string ici
      return (await resp.text()) as T;
    } catch (err) {
      lastError = err;
      attempt++;
      logger.warn("http_request_failed", { url, attempt, error: String(err) });
      if (attempt >= retryCount) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  logger.error("http_request_exhausted", { url, error: String(lastError) });
  throw lastError;
}

