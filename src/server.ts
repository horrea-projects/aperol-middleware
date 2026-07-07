import "./utils/loadEnvFile";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import type {
  Handler,
  HandlerContext,
  HandlerEvent,
  HandlerResponse,
} from "@netlify/functions";

type HandlerModuleLoader = () => Promise<{ handler: Handler }>;

const publicDir = path.resolve(process.cwd(), "public");

const functionLoaders: Record<string, HandlerModuleLoader> = {
  "daily-slack-digest": () => import("../netlify/functions/daily-slack-digest"),
  "daily-slack-digest-manual": () =>
    import("../netlify/functions/daily-slack-digest-manual"),
  "dashboard-auth": () => import("../netlify/functions/dashboard-auth"),
  "dashboard-auth-info": () => import("../netlify/functions/dashboard-auth-info"),
  "dashboard-debug": () => import("../netlify/functions/dashboard-debug"),
  "dashboard-logout": () => import("../netlify/functions/dashboard-logout"),
  "dashboard-overview": () => import("../netlify/functions/dashboard-overview"),
  "shopify-config-snapshot": () =>
    import("../netlify/functions/shopify-config-snapshot"),
  "site-meta": () => import("../netlify/functions/site-meta"),
  "slack-settings": () => import("../netlify/functions/slack-settings"),
  "stock-comparison": () => import("../netlify/functions/stock-comparison"),
  "sync-exclusions-settings": () =>
    import("../netlify/functions/sync-exclusions-settings"),
  "sync-runs": () => import("../netlify/functions/sync-runs"),
  "sync-schedule-settings": () =>
    import("../netlify/functions/sync-schedule-settings"),
  "sync-uk": () => import("../netlify/functions/sync-uk"),
  "sync-uk-now": () => import("../netlify/functions/sync-uk-now"),
  "sync-uk-staging": () => import("../netlify/functions/sync-uk-staging"),
  "sync-uk-stock-now": () => import("../netlify/functions/sync-uk-stock-now"),
  "sync-uk-stock-sku-now": () =>
    import("../netlify/functions/sync-uk-stock-sku-now"),
};

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function collectMultiValueHeaders(req: IncomingMessage): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const key = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1] ?? "";
    const existing = out[key] ?? [];
    existing.push(value);
    out[key] = existing;
  }
  return out;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function toHandlerEvent(req: IncomingMessage): Promise<HandlerEvent> {
  const origin = `http://${req.headers.host ?? "localhost"}`;
  const url = new URL(req.url ?? "/", origin);
  const body =
    req.method === "GET" || req.method === "HEAD" ? null : await readRequestBody(req);
  const queryStringParameters: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    queryStringParameters[key] = value;
  });

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers[key] = value.join(", ");
    else if (typeof value === "string") headers[key] = value;
  }

  return {
    rawUrl: url.toString(),
    rawQuery: url.searchParams.toString(),
    path: url.pathname,
    httpMethod: req.method ?? "GET",
    headers,
    multiValueHeaders: collectMultiValueHeaders(req),
    queryStringParameters,
    multiValueQueryStringParameters: null,
    body,
    isBase64Encoded: false,
  };
}

function writeHandlerResponse(res: ServerResponse, response: HandlerResponse): void {
  const statusCode = response.statusCode || 200;
  const headers = response.headers ?? {};
  for (const [key, value] of Object.entries(headers)) {
    if (value != null) res.setHeader(key, String(value));
  }
  const mvh = response.multiValueHeaders ?? {};
  for (const [key, values] of Object.entries(mvh)) {
    res.setHeader(
      key,
      values.map((value) => String(value)),
    );
  }
  const body = response.body ?? "";
  if (!res.hasHeader("Content-Type")) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
  }
  res.statusCode = statusCode;
  if (response.isBase64Encoded) {
    res.end(Buffer.from(body, "base64"));
    return;
  }
  res.end(body);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const relativePath = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(publicDir, "." + relativePath);
  if (!resolved.startsWith(publicDir + path.sep) && resolved !== path.join(publicDir, "index.html")) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }
  try {
    const data = await readFile(resolved);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypeFor(resolved));
    res.end(data);
  } catch {
    if (pathname !== "/" && pathname !== "/index.html") {
      await serveStatic(req, res, "/");
      return;
    }
    res.statusCode = 404;
    res.end("Not found");
  }
}

async function invokeFunction(
  functionName: string,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const load = functionLoaders[functionName];
  if (!load) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Function not found", functionName }));
    return;
  }
  try {
    const mod = await load();
    const event = await toHandlerEvent(req);
    const context = {} as HandlerContext;
    const response = await mod.handler(event, context, () => {});
    if (!response) {
      throw new Error(`Function ${functionName} returned no response`);
    }
    writeHandlerResponse(res, response);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: "server_function_error",
        functionName,
        message: String(error),
      }),
    );
  }
}

const server = createServer(async (req, res) => {
  const origin = `http://${req.headers.host ?? "localhost"}`;
  const url = new URL(req.url ?? "/", origin);
  if (url.pathname === "/healthz") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  const prefix = "/.netlify/functions/";
  if (url.pathname.startsWith(prefix)) {
    const functionName = url.pathname.slice(prefix.length);
    await invokeFunction(functionName, req, res);
    return;
  }
  await serveStatic(req, res, url.pathname);
});

const port = Number(process.env.PORT || 3000);
server.listen(port, "0.0.0.0", () => {
  console.log(`[coolify] middleware listening on :${port}`);
});

