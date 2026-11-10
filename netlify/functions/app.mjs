import { Readable } from "node:stream";
import { isIP } from "node:net";
import { createPortalRuntimeLoader } from "../../lib/netlify-runtime.mjs";
import { securityHeaders } from "../../lib/security-headers.mjs";

const loadPortal = createPortalRuntimeLoader();

class FunctionResponse {
  statusCode = 200;
  headers = {};
  chunks = [];

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [key, value] of Object.entries(headers)) {
      this.headers[key.toLowerCase()] = value;
    }
  }

  setHeader(key, value) {
    this.headers[key.toLowerCase()] = value;
  }

  end(body = "") {
    if (body) this.chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
  }

  toWebResponse() {
    const body = Buffer.concat(this.chunks);
    const contentType = String(this.headers["content-type"] || "");
    const isBinary = !contentType.startsWith("text/") && !contentType.includes("json") && body.length > 0;

    return new Response(isBinary ? body : body.toString("utf8"), {
      status: this.statusCode,
      headers: { ...securityHeaders, ...this.headers },
    });
  }
}

function requestUrl(request) {
  const url = new URL(request.url);
  const rawPath = url.pathname || "/";
  const path = rawPath.replace(/^\/\.netlify\/functions\/app/, "") || "/";
  return `${path}${url.search}`;
}

export default async function handler(request, context) {
  const { handleRequest } = await loadPortal(context);
  const limit = Math.min(7_000_000, Number(process.env.MAX_JSON_BODY_BYTES) || 7_000_000);
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          return Response.json({ ok: false, error: "This file or request is too large." }, { status: 413, headers: { ...securityHeaders, "cache-control": "no-store" } });
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
  }
  const body = Buffer.concat(chunks, size);
  const req = Readable.from(body.length ? [body] : []);
  req.method = request.method || "GET";
  req.url = requestUrl(request);
  req.headers = Object.fromEntries([...request.headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
  req.trustedClientIp = typeof context?.ip === "string" && isIP(context.ip) ? context.ip : null;
  if (typeof context?.waitUntil === "function") req.waitUntil = promise => context.waitUntil(promise);

  const res = new FunctionResponse();
  await handleRequest(req, res);
  return res.toWebResponse();
}
