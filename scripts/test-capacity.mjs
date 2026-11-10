// End-to-end burst check on disposable JSON + mock catalogue. Native Postgres
// concurrency is covered separately by check:database. No external services.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { startIsolatedPortal } from "./isolated-portal.mjs";
const portal = await startIsolatedPortal();
const timings = [];
async function call(cookie,url,body,expected=200) {
  const response=await fetch(portal.url+url,{method:body?"POST":"GET",headers:{cookie,"x-op-client":"portal","content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
  const payload=await response.json(); assert.equal(response.status,expected,payload.error);
  return {payload,cookie:response.headers.get("set-cookie")?.split(";")[0]||cookie};
}
async function burst(name,entries,work) {
  const started=performance.now(),latencies=[];
  const results=await Promise.allSettled(entries.map(async(entry,index)=>{const begin=performance.now();try{return await work(entry,index);}finally{latencies.push(performance.now()-begin);}}));
  const failed=results.filter(result=>result.status==="rejected"); if(failed.length)throw new AggregateError(failed.map(result=>result.reason),`${name}: ${failed.length} failed`);
  latencies.sort((a,b)=>a-b);timings.push({name,requests:entries.length,elapsedMs:Math.round(performance.now()-started),p95Ms:Math.round(latencies[Math.ceil(latencies.length*.95)-1])});
  return results.map(result=>result.value);
}
try {
  const admin=await call("","/api/auth/admin-login",{username:"admin",password:"admin"});
  const usersPath=path.join(portal.directory,"data/users.json"),saved=JSON.parse(await readFile(usersPath,"utf8"));
  const demo=saved.users.find(user=>user.role==="customer");
  const actors=Array.from({length:200},(_,index)=>({...structuredClone(demo),id:`capacity-${index}`,username:`capacity-${index}`,email:`capacity-${index}@portal.test`,emailVerifiedAddress:`capacity-${index}@portal.test`,emailVerifiedAt:new Date().toISOString()}));
  saved.users.push(...actors);await writeFile(usersPath,JSON.stringify(saved));
  const sessions=await burst("200 simultaneous customer logins",actors,actor=>call("","/api/auth/login",{login:actor.username,password:"user"}));
  const catalogues=await burst("200 simultaneous catalogue reads",sessions,session=>call(session.cookie,"/api/catalog"));
  const product=catalogues[0].payload.products.find(entry=>entry.variant?.inStock);
  assert.ok(product);assert.ok(catalogues.every(result=>result.payload.products.length===catalogues[0].payload.products.length));
  const inputs=sessions.map((session,index)=>({session,body:{idempotencyKey:`capacity-order-${index}`,items:[{variantId:product.variant.id,quantity:1}],delivery:{notes:`Fixture ${index}`}}}));
  const submissions=await burst("400 order submissions with duplicate retries",inputs.flatMap(entry=>[entry,entry]),entry=>call(entry.session.cookie,"/api/orders",entry.body,201));
  assert.equal(new Set(submissions.map(result=>result.payload.order.id)).size,200);
  const orders=JSON.parse(await readFile(path.join(portal.directory,"data/orders.json"),"utf8")).orders;
  assert.equal(orders.length,200);assert.ok(orders.every(order=>order.paymentStatus==="pending"&&!order.shopifyOrder?.id));
  const own=orders.find(order=>order.customer.id===actors[0].id),peer=orders.find(order=>order.customer.id!==actors[0].id);
  await call(sessions[0].cookie,`/api/orders/${own.id}`);await call(sessions[0].cookie,`/api/orders/${peer.id}`,null,404);
  const report=await call(admin.cookie,"/api/admin/dashboard?period=all");assert.equal(report.payload.orders.total,200);assert.equal(report.payload.orders.unprocessed,200);
  for(const timing of timings)console.log(JSON.stringify(timing));
  console.log("Capacity burst passed: 200 isolated accounts, 200 logins/catalogue reads, 400 submissions -> 200 pending orders, correct ownership, no Shopify mutations. Local timings are not a hosted SLA.");
} finally {await portal.close();}
