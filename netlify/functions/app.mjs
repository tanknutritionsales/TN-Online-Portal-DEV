import { Readable } from "node:stream";
import { handleRequest } from "../../server.js";

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

  toNetlifyResponse() {
    const body = Buffer.concat(this.chunks);
    const contentType = String(this.headers["content-type"] || "");
    const isBinary = !contentType.startsWith("text/") && !contentType.includes("json") && body.length > 0;
    return {
      statusCode: this.statusCode,
      headers: this.headers,
      body: isBinary ? body.toString("base64") : body.toString("utf8"),
      isBase64Encoded: isBinary,
    };
  }
}

function requestUrl(event) {
  const rawPath = event.path || "/";
  const path = rawPath.replace(/^\/\.netlify\/functions\/app/, "") || "/";
  const query = event.rawQuery ? `?${event.rawQuery}` : "";
  return `${path}${query}`;
}

export async function handler(event) {
  const body = event.body
    ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8")
    : Buffer.alloc(0);
  const req = Readable.from(body.length ? [body] : []);
  req.method = event.httpMethod || "GET";
  req.url = requestUrl(event);
  req.headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));

  const res = new FunctionResponse();
  await handleRequest(req, res);
  return res.toNetlifyResponse();
}
