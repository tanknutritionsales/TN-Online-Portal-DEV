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

  toWebResponse() {
    const body = Buffer.concat(this.chunks);
    const contentType = String(this.headers["content-type"] || "");
    const isBinary = !contentType.startsWith("text/") && !contentType.includes("json") && body.length > 0;

    return new Response(isBinary ? body : body.toString("utf8"), {
      status: this.statusCode,
      headers: this.headers,
    });
  }
}

function requestUrl(request) {
  const url = new URL(request.url);
  const rawPath = url.pathname || "/";
  const path = rawPath.replace(/^\/\.netlify\/functions\/app/, "") || "/";
  return `${path}${url.search}`;
}

export default async function handler(request) {
  const body = Buffer.from(await request.arrayBuffer());
  const req = Readable.from(body.length ? [body] : []);
  req.method = request.method || "GET";
  req.url = requestUrl(request);
  req.headers = Object.fromEntries([...request.headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));

  const res = new FunctionResponse();
  await handleRequest(req, res);
  return res.toWebResponse();
}
