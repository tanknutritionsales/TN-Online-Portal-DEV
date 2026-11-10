import assert from "node:assert/strict";
import test from "node:test";
import { createDatabasePool } from "../lib/database-pool.mjs";
import { createEmailCapacity } from "../lib/email-capacity.mjs";
import { createRateLimiter } from "../lib/security.mjs";
import { deliverQueuedEmail } from "../lib/customer-notifications.mjs";
import { parsePaymentProof } from "../lib/payment-proof.mjs";
import { startIsolatedPortal } from "./isolated-portal.mjs";

test("200 concurrent cold database callers initialize one bounded pool; a failed initialization can retry", async () => {
  let created = 0, loads = 0, ready = true;
  class Pool { constructor(options) { this.options = options; created++; } on() {} }
  const database = createDatabasePool({ connectionString: async () => { loads++; await Promise.resolve(); if (!ready) throw new Error("offline fixture"); return "isolated://fixture"; }, loadDriver: async () => ({ Pool }) });
  const pools = await Promise.all(Array.from({ length: 200 }, () => database()));
  assert.equal(created, 1); assert.equal(loads, 1); assert.equal(new Set(pools).size, 1); assert.equal(pools[0].options.max, 4);
  created = loads = 0; ready = false;
  const retry = createDatabasePool({ connectionString: async () => { loads++; if (!ready) throw new Error("offline fixture"); return "isolated://fixture"; }, loadDriver: async () => ({ Pool }) });
  const failed = await Promise.allSettled(Array.from({length:200},()=>retry()));
  assert.ok(failed.every(result=>result.status==="rejected")); assert.equal(loads, 1); assert.equal(created, 0);
  ready = true; await retry(); assert.equal(created, 1);
});

function storeFor(entries) {
  const messages = new Map(entries.map(entry=>[entry.id,structuredClone(entry)]));
  return { messages, async update(id, transform) { const next = transform(structuredClone(messages.get(id))); if (next) messages.set(id,next); return next; } };
}
const message = id => ({ id,kind:"email",status:"pending",attempts:0,to:"fixture@portal.test",text:"Fixture",html:"Fixture",subject:"Fixture",createdAt:new Date().toISOString(),nextAttemptAt:new Date().toISOString() });

test("a burst of 200 emails is durably deferred without burning retries, then drains through the shared sending limit", async () => {
  let clock = Date.now(), sends = 0;
  const limiter = createRateLimiter({secret:"isolated-email-capacity",now:()=>clock});
  const reserve = createEmailCapacity({limiter,now:()=>clock,sleep:async ms=>{clock+=ms;}});
  const store = storeFor(Array.from({length:200},(_,index)=>message(`fixture-${index}`)));
  clock = Date.now() + 10;
  const config = {reserveSendSlot:reserve,fetchImpl:async()=>Response.json({id:`sent-${++sends}`})};
  await Promise.all([...store.messages.keys()].map(id=>deliverQueuedEmail(store,id,config,clock)));
  assert.equal(sends,1);
  const deferred = [...store.messages.values()].filter(entry=>entry.status==="pending");
  assert.equal(deferred.length,199); assert.ok(deferred.every(entry=>entry.attempts===0));
  clock += 3000;
  for (const entry of deferred) await deliverQueuedEmail(store,entry.id,{...config,waitForCapacity:true},clock);
  assert.equal(sends,200); assert.ok([...store.messages.values()].every(entry=>entry.status==="sent" && entry.attempts===1));
  assert.ok(clock-Date.now()<65000, "200 simulated provider slots drain within the bounded rate; no wall-clock sleeps or emails occur");
});

test("provider throttling respects Retry-After and quota failures remain visible without exhausting retries", async () => {
  const store=storeFor([message("rate"),message("quota")]), before=Date.now();
  await deliverQueuedEmail(store,"rate",{fetchImpl:async()=>Response.json({name:"rate_limit_exceeded"},{status:429,headers:{"retry-after":"120"}})});
  assert.equal(store.messages.get("rate").status,"pending"); assert.equal(store.messages.get("rate").attempts,0);
  assert.ok(Date.parse(store.messages.get("rate").nextAttemptAt)>=before+120000);
  await deliverQueuedEmail(store,"quota",{fetchImpl:async()=>Response.json({name:"daily_quota_exceeded",message:"private-provider-detail"},{status:429})});
  assert.equal(store.messages.get("quota").status,"failed"); assert.equal(store.messages.get("quota").attempts,0);
  assert.match(store.messages.get("quota").lastError,/quota reached/i); assert.ok(!JSON.stringify(store.messages.get("quota")).includes("private-provider-detail"));
});

test("proof uploads reject executable documents, disguised files, malformed encoding and oversized content", () => {
  const data=(type,bytes)=>`data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
  const pdf=Buffer.from("%PDF-1.4\n%%EOF");assert.equal(parsePaymentProof(data("application/pdf",pdf)).contentType,"application/pdf");
  for(const value of [data("text/html","<html>content</html>"),data("application/javascript","alert(1)"),data("image/svg+xml","<svg/>"),data("application/pdf","<html>disguised</html>"),"data:application/pdf;base64,%%%"])
    assert.throws(()=>parsePaymentProof(value),error=>error.status===400);
  assert.throws(()=>parsePaymentProof(data("application/pdf",Buffer.alloc(4000001))),error=>error.status===413);
});

test("proof files are owner-scoped on upload and delivered to admins as sandboxed downloads", async () => {
  const portal=await startIsolatedPortal();
  async function api(cookie,url,body,expected=200) {
    const response=await fetch(portal.url+url,{method:body?"POST":"GET",headers:{cookie,"x-op-client":"portal","content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
    const payload=await response.json();assert.equal(response.status,expected,JSON.stringify(payload));
    return {payload,cookie:response.headers.get("set-cookie")?.split(";")[0]||cookie};
  }
  try {
    const customer=await api("","/api/auth/login",{login:"user",password:"user"});
    const admin=await api("","/api/auth/admin-login",{username:"admin",password:"admin"});
    const catalog=await api(customer.cookie,"/api/catalog");const variantId=catalog.payload.products[0].variant.id;
    const created=await api(customer.cookie,"/api/orders",{items:[{variantId,quantity:1}],idempotencyKey:"safe-proof-upload"},201);
    const route=`/api/orders/${created.payload.order.id}/proof`;
    await api(customer.cookie,route,{filename:"unsafe.html",dataUrl:`data:text/html;base64,${Buffer.from("<html>unsafe</html>").toString("base64")}`},400);
    await api(customer.cookie,route,{filename:"proof.pdf",dataUrl:`data:application/pdf;base64,${Buffer.from("%PDF-1.4\n%%EOF").toString("base64")}`});
    const protectedRoute=`/api/admin/orders/${created.payload.order.id}/proof`;
    await api(customer.cookie,protectedRoute,null,401);
    const download=await fetch(portal.url+protectedRoute,{headers:{cookie:admin.cookie,"x-op-client":"portal"}});
    assert.equal(download.status,200);assert.equal(download.headers.get("content-type"),"application/pdf");
    assert.match(download.headers.get("content-disposition"),/^attachment;/);assert.match(download.headers.get("content-security-policy"),/sandbox/);
  } finally {await portal.close();}
});
