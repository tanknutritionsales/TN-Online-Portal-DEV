// Exercise a production-shaped bundled handler against an owned local database.
// No Netlify credentials, local .env, hosted HTTP or Shopify calls are permitted.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { startIsolatedPostgres } from "./isolated-postgres.mjs";

const directory = await mkdtemp(path.join(tmpdir(), "op-bundle-"));
let database;
try {
  const bundle = await build({
    absWorkingDir: path.resolve(import.meta.dirname,".."), tsconfigRaw: {},
    entryPoints: { app: "netlify/functions/app.mjs", notifications: "netlify/functions/customer-notifications.mjs" },
    outdir: directory, outExtension: { ".js": ".mjs" }, bundle: true,
    platform: "node", target: "node22", format: "esm", metafile: true, logLevel: "silent",
    external: ["pg-native"],
    banner: { js: "import {createRequire as __portalCreateRequire} from 'node:module'; const require=__portalCreateRequire(import.meta.url);" },
  });
  assert.ok(Object.keys(bundle.metafile.inputs).every(input => !/(?:^|\/)(?:data|\.env)(?:\/|$)|embedded-postgres/.test(input.replaceAll("\\","/"))), "Function bundles must exclude private data and development database binaries.");
  database = await startIsolatedPostgres();
  await writeFile(path.join(directory,"verify.mjs"), `
    import assert from 'node:assert/strict';
    globalThis.fetch = async () => { throw new Error('Outbound HTTP is forbidden in bundle QA'); };
    const {default:handler}=await import('./app.mjs');
    const pending=[];
    const context={deploy:{context:'production',id:'isolated-bundle-qa'},ip:'192.0.2.200',waitUntil:promise=>pending.push(promise)};
    let cookie='';
    async function call(path,body,status=200,extraHeaders={}){
      const response=await handler(new Request('https://portal-qa.invalid'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-op-client':'portal','cookie':cookie,'x-nf-client-connection-ip':'192.0.2.200',...extraHeaders},...(body?{body:JSON.stringify(body)}:{})}),context);
      if(response.headers.get('set-cookie')){const raw=response.headers.get('set-cookie');assert.ok(raw.includes('HttpOnly')&&raw.includes('Secure')&&raw.includes('SameSite=Lax'));cookie=raw.split(';')[0];}
      const value=await response.json();assert.equal(response.status,status,value.error);return value;
    }
    const logged=await call('/api/auth/admin-login',{username:'bundle-admin',password:process.env.ADMIN_PASSWORD});
    assert.equal(logged.admin.username,'bundle-admin');
    const accounts=await call('/api/admin/accounts?limit=1');
    assert.equal(accounts.accounts.length,1);assert.equal(accounts.accounts[0].username,'bundle-admin');
    const orders=await call('/api/admin/orders');assert.deepEqual(orders.orders,[]);
    const history=await call('/api/admin/notifications');assert.deepEqual(history.emails,[]);
    const callback=await handler(new Request('https://portal-qa.invalid/api/webhooks/resend',{method:'POST',body:'{}'}),context);
    assert.equal(callback.status,400,'Unsigned callbacks must fail before portal availability or database reads.');
    await call('/api/catalog',null,503);
    const pausedCheck=await call('/api/portal-status',null,503);
    assert.ok(!JSON.stringify(pausedCheck).includes(process.env.DATABASE_URL));
    for(let index=0;index<31;index++) await call('/api/auth/password/request',{email:'unknown-'+index+'@portal.test'},index===30?429:202,{'x-nf-client-connection-ip':'198.51.100.'+index,'x-forwarded-for':'203.0.113.'+index});
    await Promise.all(pending);
    console.log('Production-shaped ESM bundle passed: PostgreSQL schema/auth/pagination, secure cookies, no private data, no sample fallback, blocked outbound HTTP.');
    process.exit(0);
  `);
  const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(path|pathext|systemroot|windir|comspec|temp|tmp)$/i.test(key)));
  Object.assign(environment,{NODE_ENV:"production",DATA_STORAGE_MODE:"postgres",DATABASE_URL:database.url,ADMIN_USERNAME:"bundle-admin",ADMIN_PASSWORD:randomBytes(24).toString("hex"),SESSION_SECRET:randomBytes(32).toString("hex"),INTERNAL_API_TOKEN:randomBytes(32).toString("hex"),RESEND_WEBHOOK_SECRET:'whsec_'+randomBytes(32).toString('base64'),SHOPIFY_ORDER_SYNC_ENABLED:"false"});
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(directory,"verify.mjs")],{cwd:directory,env:environment,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let output="";
    child.stdout.on("data",data=>{output+=String(data);});
    child.stderr.on("data",data=>{output+=String(data);});
    const timer=setTimeout(()=>{child.kill();reject(new Error("Bundled handler QA timed out."));},30_000);
    child.once("error",error=>{clearTimeout(timer);reject(error);});
    child.once("exit",code=>{clearTimeout(timer);resolve({code,output});});
  });
  const safeOutput=result.output.replaceAll(database.url,"[isolated database]").replaceAll(environment.ADMIN_PASSWORD,"[test password]").replaceAll(environment.SESSION_SECRET,"[test session key]").replaceAll(environment.INTERNAL_API_TOKEN,"[test internal key]");
  assert.equal(result.code,0,safeOutput);
  console.log(safeOutput.trim());
  console.log(`Both function bundles built successfully; ${Object.keys(bundle.metafile.inputs).length} source/dependency modules, no runtime data files.`);
} finally {
  try { if(database) await database.close(); }
  finally {
    if(path.dirname(directory)!==path.resolve(tmpdir())||!path.basename(directory).startsWith("op-bundle-"))throw new Error("Unexpected bundle cleanup path.");
    await rm(directory,{recursive:true,force:true});
  }
}
