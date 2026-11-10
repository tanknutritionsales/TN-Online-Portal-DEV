// Seed ONLY an already-running disposable preview created by isolated-portal.
import { readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { revealEmailContent } from "../lib/email-content.mjs";

const [urlValue, directoryValue] = process.argv.slice(2);
const url = new URL(urlValue), directory = path.resolve(directoryValue);
if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("op-experience-")) throw new Error("Only an owned disposable preview is allowed.");
if ((await realpath(path.join(directory, "public"))).toLowerCase() !== path.resolve(import.meta.dirname, "../public").toLowerCase()) throw new Error("Wrong preview public junction.");
if (!(await readFile(path.join(directory, "preview.mjs"), "utf8")).includes(`.listen(${Number(url.port)},'127.0.0.1'`)) throw new Error("The URL does not belong to this disposable preview.");
let cookie = "";
async function api(route, input) {
  const response = await fetch(new URL(route, url), { method: "POST", headers: { "content-type": "application/json", "x-op-client": "portal", cookie }, body: JSON.stringify(input) });
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
await api("/api/auth/register", { username: "email-preview", name: "Email Preview", email: "preview@portal.test", password: "preview-password-twelve", phoneArea: "+27", phoneNumber: "821234567",
  defaultAddress: { line1: "1 Preview Road", suburb: "Menlyn", city: "Pretoria", province: "Gauteng", postalCode: "0001", country: "South Africa" }, terms: { accepted: true, ageConfirmed: true, version: "research-use-v1-2026-10-08" } });
await api("/api/auth/password/request", { email: "preview@portal.test" });
const file = path.join(directory, "data/customer-messages.json"); let payload;
for (let attempt = 0; attempt < 80; attempt++) {
  try { payload = JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (payload?.messages.some(message => message.event === "password_reset")) break;
  await new Promise(resolve => setTimeout(resolve, 25));
}
if (!payload?.messages.some(message => message.event === "password_reset")) throw new Error("Preview security messages were not recorded.");
const links = Object.fromEntries(payload.messages.filter(message => ["email_verification", "password_reset"].includes(message.event)).map(message => {
  const content = revealEmailContent(message.protectedContent, "isolated-local-session");
  const link = new URL(content.text.match(/https:\/\/\S+/)[0]); return [message.event, `${url.origin}/${link.hash}`];
}));
for (let index = 0; index < 58; index++) {
  const deliveryStatus = ["delivered", "bounced", "delayed", "sent"][index % 4], createdAt = new Date(Date.now() - index * 60000).toISOString();
  payload.messages.push({ id: `email-${String(index).padStart(64, "0")}`, kind: "email", category: "order", event: ["order_received", "payment_ready", "payment_confirmed", "shipped"][index % 4], customerId: "fixture-customer", customerName: "Preview Customer", orderId: `fixture-order-${index}`, reference: `QA-${String(index + 1).padStart(4, "0")}`, to: "customer@portal.test", subject: "Order update", status: "sent", deliveryStatus, deliveryDetail: deliveryStatus === "bounced" ? "This preview mailbox is unavailable." : "", attempts: 1, createdAt, sentAt: createdAt, updatedAt: createdAt, deliveryUpdatedAt: createdAt, deliveryEvents: [{ id: `fixture-event-${index}`, status: deliveryStatus, at: createdAt, detail: "" }] });
}
await writeFile(file, JSON.stringify(payload));
console.log(JSON.stringify({ preview: url.origin, fixtureUser: "email-preview", ...links }));
