// Disposable, credential-free preview for QA. Never loads this checkout's .env or data.
import { mkdtemp, cp, symlink, writeFile, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function startIsolatedPortal({ photos = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "op-experience-"));
  const publicLink = path.join(directory, "public");
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  let child;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (child && child.exitCode === null) {
      const stopped = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await stopped;
    }
    // Verify the exact temporary target before recursive removal; unlink the junction first.
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("op-experience-")) throw new Error("Unexpected temporary path.");
    await unlink(publicLink).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await cp(path.join(root, "server.js"), path.join(directory, "server.js"));
    await cp(path.join(root, "package.json"), path.join(directory, "package.json"));
    await cp(path.join(root, "lib"), path.join(directory, "lib"), { recursive: true });
    await symlink(path.join(root, "public"), publicLink, process.platform === "win32" ? "junction" : "dir");
    await writeFile(path.join(directory, "preview.mjs"), `
      import http from 'node:http';
      import { handleRequest } from './server.js';
      http.createServer((req,res) => {
        if (${Boolean(photos)} && req.url === '/api/catalog') {
          const end = res.end.bind(res);
          res.end = (body,...args) => {
            try {
              const payload = JSON.parse(body);
              for (const product of payload.products || []) {
                if (product.id === 'mock-hd-reta') {
                  product.image = '/product-images/hd-5001.png';
                  product.images = [{url: product.image,alt: 'Local QA photo'}, {url: product.image+'?photo=2',alt: 'Local QA gallery test'}];
                }
              }
              body = JSON.stringify(payload);
            } catch {}
            return end(body,...args);
          };
        }
        handleRequest(req,res);
      }).listen(${port},'127.0.0.1',() => console.log('READY'));
    `);
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SHOPIFY_|RETAIL_SHARK_|NETLIFY|DATABASE|RESEND|EMAIL_|PORTAL_PUBLIC_URL|ADMIN_|SESSION_|INTERNAL_API|DATA_|PROOF_|NODE_ENV|CONTEXT|URL$)/i.test(key)));
    Object.assign(environment, { NODE_ENV: "test", PORT: String(port), DATA_STORAGE_MODE: "local", PROOF_STORAGE_MODE: "local", SHOPIFY_ORDER_SYNC_ENABLED: "false", INTERNAL_API_TOKEN: "dev-internal-token", SESSION_SECRET: "isolated-local-session", ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "admin" });
    child = spawn(process.execPath, ["preview.mjs"], { cwd: directory, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Isolated portal did not start.")), 10_000);
      child.stdout.on("data", (data) => { if (String(data).includes("READY")) { clearTimeout(timer); resolve(); } });
      child.stderr.on("data", (data) => { output += String(data); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Isolated portal exited ${code}: ${output}`)); });
    });
    return { url: `http://127.0.0.1:${port}`, directory, close };
  } catch (error) { await close(); throw error; }
}

if (process.argv.includes("--serve")) {
  const preview = await startIsolatedPortal({ photos: true });
  console.log(`Disposable local QA preview: ${preview.url}`);
  process.once("SIGINT", async () => { await preview.close(); process.exit(); });
  process.once("SIGTERM", async () => { await preview.close(); process.exit(); });
  setInterval(() => {}, 60_000);
}
