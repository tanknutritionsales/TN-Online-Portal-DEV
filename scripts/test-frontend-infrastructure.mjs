// Reproducible controller/DOM tests. No packages, credentials, screenshots or
// browser are needed: node scripts/test-frontend-infrastructure.mjs
// The DOM below implements the subset used here, including mounted replacement,
// focus, form fields, delegated events and dialog close listeners. It does not
// emulate layout, image decoding, CSP enforcement or a browser's event loop.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { cartStorageKey, readSavedCart, saveCart } from "../public/cart-storage.js";
import { productFacts } from "../public/product-content.js";
import { createCatalogSearch, normalizeSearchSettings, anonymousSearchTerm } from "../public/catalog-search.js";
import { mountAdminSearch } from "../public/admin-search.js";
import { mountAdminDashboard, reportingControls, readReportingControls, toggleCustomDates, periodParams, adminQueueLabels } from "../public/admin-dashboard.js";
import { securityHeaders } from "../lib/security-headers.mjs";
import { startIsolatedPortal } from "./isolated-portal.mjs";

const root = path.resolve(import.meta.dirname, "..");
const source = await readFile(path.join(root, "public/app.js"), "utf8");
const html = await readFile(path.join(root, "public/index.html"), "utf8");
const emailSource = await readFile(path.join(root, "public/account-email.js"), "utf8");
const frontendSource = 'const accountEmailUi = {render(){},openAction(){}};\n' + source.replace(/^import .*;\r?\n/gm, "")
  .replace(/\ninstallInputMasks\(\);[\s\S]*$/, "");
const decode = (text) => String(text).replace(/&(amp|lt|gt|quot|#039|nbsp|middot);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#039": "'", nbsp: " ", middot: "·" })[entity]);
const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

class DomNode {
  constructor(tag, owner, attributes = {}, text = "") {
    this.tagName = tag;
    this.ownerDocument = owner;
    this.attributes = { ...attributes };
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.text = text;
    this.style = {};
    this.scrollLeft = this.scrollTop = 0;
    this.selectionStart = this.selectionEnd = 0;
    this.selectionDirection = "none";
    this._value = attributes.value;
    this.dataset = new Proxy({}, {
      get: (_, key) => this.attributes[`data-${String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`],
      set: (_, key, value) => { this.attributes[`data-${String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`] = String(value); return true; },
    });
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
      toggle: (name, force) => { const on = force ?? !this.classList.contains(name); this.classList[on ? "add" : "remove"](name); return on; },
    };
    return new Proxy(this, { get: (target, key, receiver) => key in target || tag !== "form" ? Reflect.get(target, key, receiver) : target.querySelector(`[name="${String(key)}"]`) });
  }
  get id() { return this.attributes.id || ""; }
  get name() { return this.attributes.name || ""; }
  get className() { return this.attributes.class || ""; }
  set className(value) { this.attributes.class = value; }
  get isConnected() { return this === this.ownerDocument || Boolean(this.parentNode?.isConnected); }
  get hidden() { return this.hasAttribute("hidden"); }
  set hidden(value) { this.toggleAttribute("hidden", value); }
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(value) { this.toggleAttribute("disabled", value); }
  get checked() { return this.hasAttribute("checked"); }
  set checked(value) { this.toggleAttribute("checked", value); }
  get required() { return this.hasAttribute("required"); }
  set required(value) { this.toggleAttribute("required", value); }
  get open() { return this.hasAttribute("open"); }
  set open(value) { this.toggleAttribute("open", value); }
  get value() {
    if (this._value != null) return this._value;
    if (this.tagName === "select") return (this.querySelector("option[selected]") || this.querySelector("option"))?.value || "";
    return this.tagName === "option" ? this.attributes.value ?? this.textContent : "";
  }
  set value(value) { this._value = String(value ?? ""); }
  get elements() { return new Proxy({}, { get: (_, name) => this.querySelector(`[name="${String(name)}"]`) }); }
  get src() { return this.getAttribute("src") || ""; }
  set src(value) { this.setAttribute("src", value); }
  get textContent() { return this.tagName === "#text" ? this.text : this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(new DomNode("#text", this.ownerDocument, {}, String(value))); }
  get innerHTML() { return this._html ?? this.textContent; }
  set innerHTML(value) { this.replaceChildren(); this._html = String(value); parseHtml(this, String(value)); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  toggleAttribute(name, value) { if (value) this.setAttribute(name, ""); else this.removeAttribute(name); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  replaceChildren(...children) {
    if (this.children.some((child) => child.contains(this.ownerDocument.activeElement))) this.ownerDocument.activeElement = this.ownerDocument.body;
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = []; this._html = undefined;
    children.forEach((child) => this.appendChild(child));
  }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  matches(selector) {
    return selector.split(/,\s*/).some((group) => {
      const parts = group.trim().split(/\s+(?![^\[]*\])/);
      const simple = (node, part) => {
        if (!node || node.tagName === "#text") return false;
        const attributes = [...part.matchAll(/\[([^=\]]+)(?:=["']?([^\]"']*)["']?)?\]/g)];
        const bare = part.replace(/\[[^\]]*\]/g, "");
        const tag = bare.match(/^[\w-]+/)?.[0];
        const id = bare.match(/#([\w-]+)/)?.[1];
        const classes = [...bare.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
        return (!tag || node.tagName === tag) && (!id || node.id === id) && classes.every((name) => node.classList.contains(name))
          && attributes.every(([, key, value]) => node.hasAttribute(key) && (value == null || node.getAttribute(key) === value));
      };
      if (!simple(this, parts.pop())) return false;
      let ancestor = this.parentNode;
      while (parts.length) { const part = parts.pop(); while (ancestor && !simple(ancestor, part)) ancestor = ancestor.parentNode; if (!ancestor) return false; ancestor = ancestor.parentNode; }
      return true;
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { return this.descendants().filter((node) => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(callback); }
  removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) || []).filter((entry) => entry !== callback)); }
  dispatchEvent(event) {
    event.target ||= this; event.preventDefault ||= () => { event.defaultPrevented = true; };
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) || []) {
      const result = listener(event);
      if (result?.then) this.ownerDocument.pending.push(result);
    }
    if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  focus() { this.ownerDocument.activeElement = this; }
  setSelectionRange(start, end, direction = "none") { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  showModal() { this.open = true; }
  close() { if (this.open) { this.open = false; this.ownerDocument.tasks.push(() => this.dispatchEvent({ type: "close" })); } }
  reset() { this.querySelectorAll("input, select, textarea").forEach((input) => { input._value = input.attributes.value; }); }
  scrollIntoView() {}
  scrollBy() {}
}

function parseHtml(parent, markup) {
  const stack = [parent];
  for (const [token] of markup.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g)) {
    if (/^<!/.test(token)) continue;
    if (token.startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
    if (token.startsWith("<")) {
      const [, tag, rest] = token.match(/^<([\w-]+)([\s\S]*?)\/?\s*>$/) || [];
      if (!tag) continue;
      const attributes = {};
      for (const [, key, double, single, plain] of rest.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attributes[key] = decode(double ?? single ?? plain ?? "");
      const node = new DomNode(tag.toLowerCase(), parent.ownerDocument, attributes);
      stack.at(-1).appendChild(node);
      if (!voidTags.has(tag) && !token.endsWith("/>")) stack.push(node);
    } else stack.at(-1).appendChild(new DomNode("#text", parent.ownerDocument, {}, decode(token)));
  }
}

function harness() {
  const document = new DomNode("#document", null);
  document.ownerDocument = document; document.pending = []; document.tasks = [];
  parseHtml(document, html);
  document.body = document.querySelector("body"); document.documentElement = document.querySelector("html");
  document.activeElement = document.body; document.visibilityState = "visible";
  const requests = [], timers = new Map(), storage = new Map(); let timerId = 0;
  const sandbox = {
    document, URLSearchParams, AbortSignal, Intl, Map, Set, Date, crypto: { randomUUID }, structuredClone,
    cartStorageKey, readSavedCart, saveCart, productFacts, createCatalogSearch, normalizeSearchSettings, anonymousSearchTerm, mountAdminSearch,
    mountAdminDashboard, reportingControls, readReportingControls, toggleCustomDates, periodParams, adminQueueLabels,
    location: { search: "" }, navigator: {}, window: new DomNode("window", document),
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; }, clearTimeout: (id) => timers.delete(id),
    setInterval: () => ++timerId, clearInterval() {},
    FormData: class { constructor(form) { this.form = form; } get(name) { const field = this.form.querySelector(`[name="${name}"]`); return field?.disabled ? null : field?.value ?? null; } },
  };
  const context = vm.createContext(sandbox);
  const run = (code) => vm.runInContext(code, context);
  const respond = (handler) => { sandbox.fetch = async (url, options) => { requests.push({ url, options }); const result = await handler(url, options); return { status: result.status ?? 200, ok: (result.status ?? 200) < 400, json: async () => result.payload ?? result }; }; };
  respond((url) => url === "/api/shop-settings" ? { ok: true, settings: {} } : { ok: true });
  run(frontendSource);
  return {
    state: run("state"), sandbox, run, requests, timers, respond, document,
    fn: (name) => run(name), query: (selector) => document.querySelector(selector),
    async flush() { for (let count = 0; count < 6; count++) { while (document.tasks.length) document.tasks.shift()(); await Promise.all(document.pending.splice(0)); await Promise.resolve(); } },
    click(node) { node.dispatchEvent({ type: "click", bubbles: true }); },
  };
}

const customer = { id: "customer", name: "Customer", username: "customer", addresses: [{ id: "address", label: "Home", line1: "1 Street", suburb: "Suburb", city: "City", province: "Gauteng", postalCode: "0001", isDefault: true }] };
const product = { id: "product", title: "Product", handle: "product", vendor: "Brand", tags: [], variant: { id: "variant", title: "Default", price: 10, inStock: true } };
const order = (id, extra = {}) => ({ id: String(id), reference: `OP-${id}`, customer, items: [{ variantId: "variant", productTitle: "Product", quantity: 1, price: 10 }], officeItems: [], externalItems: [], total: 160, paymentStatus: "pending", fulfillmentStatus: "not_ready", customerStatus: "Payment pending", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...extra });
const ids = (rows) => Array.from(rows, (entry) => entry.id);
const page = (offset, hasMore) => ({ offset, limit: 50, hasMore });
function signedIn(h) { h.state.user = structuredClone(customer); h.state.products = [structuredClone(product)]; h.state.catalogReady = true; h.state.cartRestoredFor = customer.id; }
function basket(h) { signedIn(h); h.state.cart.set("variant", { variantId: "variant", productTitle: "Product", quantity: 2, price: 10 }); h.fn("renderCart")(); }
const quote = (price = 12, fee = 150, quantity = 2) => ({ ok: true, items: [{ variantId: "variant", price }], subtotal: price * quantity, deliveryFee: fee, total: price * quantity + fee });

test("new passwords have bounds and copy; existing login remains unconstrained", () => {
  const h = harness();
  for (const field of h.document.querySelectorAll('[autocomplete="new-password"]')) {
    assert.equal(field.getAttribute("minlength"), "12"); assert.equal(field.getAttribute("maxlength"), "128");
    assert.match(h.query(`#${field.getAttribute("aria-describedby")}`).textContent, /12–128/);
  }
  assert.equal(h.query('#loginForm input[name="password"]').getAttribute("minlength"), null);
  assert.equal(h.query('#loginForm input[name="password"]').getAttribute("maxlength"), null);
});

test("admin pages send view/filter/search to the server and render collapsed rows and two pagers", async () => {
  const h = harness(); Object.assign(h.state, { admin: { id: "admin" }, adminView: "pending", adminOrderSearch: "A & B", adminOrderFilter: "support", adminOrdersOffset: 50 });
  h.respond((url) => url.startsWith("/api/admin/orders?") ? { ok: true, orders: [order("matching")], page: page(50, true) } : { ok: true, settings: {} });
  await h.fn("loadAdminOrders")();
  const query = new URL(h.requests[0].url, "http://fixture").searchParams;
  for (const [key, value] of Object.entries({ view: "pending", filter: "support", search: "A & B", offset: "50", limit: "50" })) assert.equal(query.get(key), value);
  assert.match(h.query("#adminOrdersSummary").textContent, /1 matching order on this page/);
  assert.equal(h.query(".admin-order-card").open, false);
  for (const pager of ["#adminPagerTop", "#adminPagerBottom"]) assert.equal(h.query(pager).querySelectorAll("button").length, 2);
});

test("dashboard uses complete totals and its cards preserve reporting dates while attention shortcuts include older work", async () => {
  const h = harness(); h.state.admin = { id: "admin", name: "Manager" }; h.state.adminView = "dashboard";
  h.state.adminReportingPeriod = { period: "custom", from: "2026-11-01", to: "2026-11-10" };
  h.respond(url => url.startsWith("/api/admin/dashboard?") ? { ok: true, checkedAt: "2026-11-10T10:00:00Z", shopifySyncEnabled: false,
    period: { label: "Selected period" }, orders: { total: 127, lifetimeTotal: 980, unprocessed: 91, processing: 20, completed: 15, closed: 1, value: 12600, paidValue: 3500, pendingValue: 9100, attention: { verify: 9, review: 0, details: 0, packing: 0 } }, messages: { support: 0, email: 0 }, recent: [] }
    : url === "/api/admin/system-status" ? { ok: true, systems: [] } : url.startsWith("/api/admin/orders?") ? { ok: true, orders: [], total: 91, page: page(0, false) } : { ok: true, settings: {} });
  await h.fn("refreshAdminView")();
  assert.match(h.query(".dashboard-updated").textContent, /980 orders overall/);
  assert.match(h.query('.dashboard-kpi[data-dashboard-queue=""]').textContent, /127/);
  h.click(h.query('.dashboard-kpi[data-dashboard-queue="unprocessed"]')); await h.flush();
  let query = new URL(h.requests.find(request => request.url.startsWith("/api/admin/orders?")).url, "http://fixture").searchParams;
  assert.equal(query.get("queue"), "unprocessed"); assert.equal(query.get("period"), "custom"); assert.equal(query.get("from"), "2026-11-01");
  await h.fn("navigateAdmin")({ view: "dashboard" }); await h.flush();
  h.click(h.query('[data-dashboard-attention="verify"]')); await h.flush();
  query = new URL(h.requests.filter(request => request.url.startsWith("/api/admin/orders?")).at(-1).url, "http://fixture").searchParams;
  assert.equal(query.get("queue"), "verify"); assert.equal(query.get("period"), "all");
});

test("late dashboard and health responses cannot replace the admin's next page", async () => {
  const h = harness(); h.state.admin = { id: "admin" }; h.state.adminView = "dashboard";
  let release;
  h.respond(url => url.startsWith("/api/admin/dashboard?") ? new Promise(resolve => { release = resolve; }) : url === "/api/admin/system-status" ? { ok: true, systems: [] } : url.startsWith("/api/admin/orders?") ? { ok: true, orders: [], total: 0, page: page(0, false) } : { ok: true, settings: {} });
  const pending = h.fn("refreshAdminView")();
  assert.match(h.query(".dashboard-loading").textContent, /Loading/);
  await h.fn("navigateAdmin")({ view: "all" }); await h.flush();
  release({ ok: true, orders: { total: 999 }, recent: [] }); await pending;
  assert.equal(h.query(".admin-overview"), null); assert.match(h.query("#adminOrdersSummary").textContent, /0 matching orders/);
});

test("verification responses cannot restore a previous customer after logout and another sign-in", async () => {
  const h=harness();h.state.user={id:"first",email:"first@portal.test"};
  h.sandbox.window.location={hash:"",pathname:"/",search:""};h.sandbox.window.history={replaceState(){}};
  h.run(emailSource.replace(/^export /gm,""));
  h.run('const actualEmailUi = mountAccountEmail({api,toast,showScreen,showLogin:showAuth,getUser:()=>state.user,getSessionRevision:()=>sessionRevision,updateUser:user=>{state.user=user;}}); actualEmailUi.render();');
  let release;h.respond(()=>new Promise(resolve=>{release=resolve;}));
  h.click(h.query('[data-refresh-verification]'));
  h.run('sessionRevision++;state.user={id:"second",email:"second@portal.test"};actualEmailUi.render();');
  release({ok:true,user:{id:"first",email:"first@portal.test",emailVerified:true}});await h.flush();
  assert.equal(h.state.user.id,"second");assert.equal(h.state.user.emailVerified,undefined);
  assert.equal(h.query('[data-refresh-verification]').disabled,false);
});

test("support filters and pagination load server pages rather than hiding older requests", async () => {
  const h=harness();h.state.admin={id:"admin"};h.state.adminView="customer-care";
  h.respond(url=>{const params=new URL(url,"http://fixture").searchParams;return {ok:true,requests:[{id:"support-fixture",status:"open",topic:"Delivery",customerName:"Fixture",customerEmail:"fixture@portal.test",message:"Fixture",createdAt:"2026-11-10T10:00:00Z",replies:[]}],counts:{open:225,total:250},page:{offset:Number(params.get("offset")),limit:50,hasMore:true}};});
  await h.fn("loadAdminCustomerCare")();assert.match(h.query("#adminOrdersSummary").textContent,/225 open/);
  h.click(h.query('[data-support-page="next"]'));await h.flush();
  assert.equal(new URL(h.requests.at(-1).url,"http://fixture").searchParams.get("offset"),"50");
  h.click(h.query('[data-support-filter="all"]'));await h.flush();
  const params=new URL(h.requests.at(-1).url,"http://fixture").searchParams;
  assert.equal(params.get("offset"),"0");assert.equal(params.get("status"),"all");
});

test("search debounce resets offset, replaces the mounted input and preserves its live selection", async () => {
  const h = harness(); h.state.admin = { id: "admin" }; h.state.adminView = "pending"; h.fn("renderAdminOrders")();
  const original = h.query("#adminOrderSearch"); original.value = "updated query"; original.focus(); original.setSelectionRange(2, 6, "backward"); original.scrollLeft = 7;
  h.state.adminOrdersOffset = 100;
  original.dispatchEvent({ type: "input", bubbles: true });
  assert.equal(h.state.adminOrdersOffset, 0); assert.equal(h.requests.length, 0);
  const timer = [...h.timers.values()].find((entry) => entry.delay === 300); assert.ok(timer);
  h.respond((url) => url.startsWith("/api/admin/orders?") ? { ok: true, orders: [], page: page(0, false) } : { ok: true, settings: {} });
  await timer.callback();
  const replacement = h.query("#adminOrderSearch");
  assert.notEqual(replacement, original); assert.equal(original.isConnected, false); assert.equal(h.document.activeElement, replacement);
  assert.deepEqual([replacement.selectionStart, replacement.selectionEnd, replacement.selectionDirection, replacement.scrollLeft], [2, 6, "backward", 7]);
});

test("late admin responses cannot replace a different view", async () => {
  const h = harness(); h.state.admin = { id: "admin" }; h.state.adminView = "pending"; let release;
  h.respond((url) => url.startsWith("/api/admin/orders?") ? new Promise((resolve) => { release = resolve; }) : { ok: true, settings: {} });
  const task = h.fn("loadAdminOrders")(); h.state.adminView = "completed";
  release({ ok: true, orders: [order("stale")], page: page(0, false) }); await task;
  assert.equal(h.query('[data-admin-order-id="stale"]'), null);
});

test("both list pagers hide on a single page and remain available on multi-page lists", () => {
  const h = harness(); h.state.admin = { id: "admin" }; h.state.adminView = "pending";
  for (const kind of ["orders", "accounts"]) {
    const key = kind === "accounts" ? "adminAccounts" : "adminOrders";
    for (const [offset, hasMore, hidden] of [[0, false, true], [0, true, false], [50, false, false]]) {
      h.state[`${key}Offset`] = offset; h.state[`${key}Page`] = page(offset, hasMore);
      h.fn("renderAdminPagination")(kind);
      for (const selector of ["#adminPagerTop", "#adminPagerBottom"]) {
        assert.equal(h.query(selector).hidden, hidden, `${kind} ${offset} ${hasMore}`);
        assert.equal(h.query(selector).querySelectorAll("button").length, hidden ? 0 : 2);
      }
    }
  }
  h.state.adminOrdersOffset = 0; h.state.adminOrdersPage = page(0, false); h.fn("renderAdminOrders")();
  assert.match(h.query("#adminOrdersSummary").textContent, /No orders/);
});

test("account roles are server filters; totals are omitted unless supplied", async () => {
  const h = harness(); Object.assign(h.state, { admin: { id: "admin" }, adminView: "accounts", adminAccountFilter: "admin", adminAccountsOffset: 50 });
  h.respond(() => ({ ok: true, accounts: [{ id: "admin", name: "Admin", username: "admin", role: "admin" }], page: page(50, false) }));
  await h.fn("loadAdminAccounts")(); assert.match(h.requests[0].url, /role=admin/); assert.match(h.requests[0].url, /offset=50/);
  assert.equal(h.query('[data-account-filter="all"] span'), null);
  h.state.adminAccountsCounts = { all: 152, admin: 51, customer: 101 }; h.fn("renderAdminAccounts")();
  assert.equal(h.query('[data-account-filter="all"] span').textContent, "152");
});

test("older customer history stays ordered/deduplicated while only offset zero is polled", async () => {
  const h = harness(); signedIn(h); let turn = 0;
  const first = Array.from({ length: 50 }, (_, index) => order(100 - index));
  const older = Array.from({ length: 50 }, (_, index) => order(50 - index));
  h.respond((url) => { turn++; return { ok: true, orders: turn === 1 ? first : turn === 2 ? older : [order(101), ...first.slice(0, 49)], activeOrders: [order("old-active", { canPay: true })], page: page(Number(new URL(url, "http://fixture").searchParams.get("offset")), turn === 1) }; });
  await h.fn("loadCustomerOrders")(); await h.fn("loadCustomerOrders")({ loadMore: true }); const before = ids(h.state.customerOrders);
  await h.fn("loadCustomerOrders")({ quiet: true });
  assert.deepEqual(ids(h.state.customerOrders).slice(1), before); assert.equal(h.state.customerOrders.length, 101); assert.equal(h.state.customerOrdersNextOffset, 101);
  assert.equal(h.requests[2].url, "/api/orders?limit=50&offset=0"); assert.deepEqual(ids(h.state.customerHomeOrders), ["old-active"]);
  assert.equal(h.query('[data-view-order-payment="old-active"]').textContent, "View payment");
  assert.equal(h.state.customerOrders.some((entry) => entry.id === "old-active"), false);
});

test("linked old orders use the owner endpoint without inserting into history", async () => {
  const h = harness(); signedIn(h); h.sandbox.location.search = "?order=old-link";
  h.respond((url) => url === "/api/orders/old-link" ? { ok: true, order: order("old-link") } : url.startsWith("/api/orders?") ? { ok: true, orders: [], activeOrders: [], page: page(0, false) } : { ok: true, settings: {} });
  await h.fn("loadCustomerOrders")(); await h.flush();
  assert.ok(h.requests.some((request) => request.url === "/api/orders/old-link")); assert.equal(h.state.customerLinkedOrder.id, "old-link");
  assert.equal(h.state.customerOrders.length, 0); assert.match(h.query("#orderFlowContent").textContent, /OP-old-link/);
});

test("receipt candidates include active orders outside loaded history", () => {
  const h = harness(); signedIn(h);
  h.state.customerHomeOrders = [order("old-receipt", { deliveryReceipt: { promptDue: true, canConfirm: true, promptAfter: "2026-01-01" } })];
  h.fn("openDeliveryReceipt")("old-receipt"); assert.equal(h.query("#deliveryReceiptDialog").open, true); assert.equal(h.state.receiptOrderId, "old-receipt");
});

test("live prices update product/cart DOM and the normal review carries the verified total", async () => {
  const h = harness(); basket(h); h.respond(() => quote(13, 80));
  await h.fn("submitOrder")({ preventDefault() {}, target: h.query("#orderForm") });
  assert.equal(h.state.products[0].variant.price, 13); assert.equal(h.state.cart.get("variant").price, 13);
  assert.equal(h.state.pendingOrderDraft.expectedTotal, 106); assert.equal(h.state.pendingOrderDraft.deliveryFee, 80);
  assert.match(h.query("#cartTotal").textContent, /106/); assert.match(h.query("#orderFlowContent").textContent, /Prices have been updated/);
  assert.ok(h.requests[0].options.signal instanceof AbortSignal);
});

test("missing price verification blocks checkout", async () => {
  const h = harness(); basket(h); h.respond(() => ({ ok: true, items: [] }));
  await h.fn("submitOrder")({ preventDefault() {}, target: h.query("#orderForm") });
  assert.equal(h.state.pendingOrderDraft, null); assert.match(h.query("#cartNotice").textContent, /prices could not be checked/);
});

test("special-order review checks current prices and total", async () => {
  const h = harness(); signedIn(h); h.state.specialOrderItems = [{ variantId: "variant", productTitle: "Product", price: 10, quantity: 2 }];
  h.fn("renderSpecialAddressOptions")(); h.respond(() => quote(20, 80));
  await h.fn("submitSpecialOrder")({ preventDefault() {}, target: h.query("#specialOrderForm") });
  assert.equal(h.state.pendingOrderDraft.specialOrder, true); assert.equal(h.state.pendingOrderDraft.expectedTotal, 120);
  assert.equal(h.state.pendingOrderDraft.items[0].price, 20); assert.equal(JSON.parse(h.requests[0].options.body).specialOrder, true);
});

test("a price conflict preserves the basket, refreshes and reviews again without resubmitting", async () => {
  const h = harness(); basket(h);
  h.state.pendingOrderDraft = { items: [...h.state.cart.values()], delivery: { address: customer.addresses[0] }, idempotencyKey: "same-key", expectedTotal: 170 };
  h.respond((url) => url === "/api/orders" ? { status: 409, payload: { ok: false, error: "Prices have changed. Review your basket before submitting." } } : url === "/api/catalog" ? { ok: true, products: [product] } : url === "/api/shop-settings" ? { ok: true, settings: {} } : quote(15, 150));
  await h.fn("confirmPendingOrder")();
  assert.equal(JSON.parse(h.requests[0].options.body).expectedTotal, 170); assert.equal(h.requests.filter((request) => request.url === "/api/orders").length, 1);
  assert.ok(h.requests.some((request) => request.url === "/api/catalog")); assert.equal(h.state.cart.size, 1);
  assert.equal(h.state.pendingOrderDraft.expectedTotal, 180); assert.equal(h.query("#orderFlowModal").hidden, false);
});

test("401 clears data, closes dialogs/backdrops and releases body modal flags", async () => {
  const h = harness(); basket(h); h.state.customerOrders = [order("private")]; h.state.adminAccounts = [{ id: "private-account" }];
  h.fn("openProductQuickView")("product"); h.query("#customerSupportDialog").showModal(); h.document.body.classList.add("customer-support-open");
  h.query("#orderFlowModal").hidden = false;
  h.respond(() => ({ status: 401, payload: { ok: false, error: "Sign in again." } }));
  await assert.rejects(h.fn("api")("/api/orders"), /session has expired/); await h.flush();
  assert.equal(h.state.user, null); assert.equal(h.state.customerOrders.length, 0); assert.equal(h.state.adminAccounts.length, 0); assert.equal(h.state.cart.size, 0);
  assert.equal(h.query("dialog[open]"), null); assert.equal(h.query("#orderFlowModal").hidden, true); assert.equal(h.query("#loginScreen").hidden, false);
  for (const name of ["product-quick-view-open", "customer-support-open", "research-notice-open", "delivery-receipt-open"]) assert.equal(h.document.body.classList.contains(name), false);
});

test("a failed customer login can fall back to a named admin; failed credentials keep login fields", async () => {
  const h = harness(); h.query('#loginForm input[name="login"]').value = "manager"; h.query('#loginForm input[name="password"]').value = "correct-password";
  h.respond((url) => url === "/api/auth/login" ? { status: 401, payload: { ok: false, error: "Wrong customer credentials." } } : url === "/api/auth/admin-login" ? { ok: true, admin: { id: "manager", name: "Manager" } } : url === "/api/admin/portal-control" ? { ok: true, control: { paused: false } } : url.startsWith("/api/admin/orders?") ? { ok: true, orders: [], page: page(0, false) } : { ok: true, settings: {} });
  await h.fn("login")({ preventDefault() {}, target: h.query("#loginForm") }); assert.equal(h.state.admin.id, "manager"); assert.equal(h.query("#appScreen").hidden, false);
  const failed = harness(); failed.query('#loginForm input[name="login"]').value = "wrong"; failed.query('#loginForm input[name="password"]').value = "wrong-password";
  failed.respond(() => ({ status: 401, payload: { ok: false, error: "Wrong credentials." } }));
  await failed.fn("login")({ preventDefault() {}, target: failed.query("#loginForm") }); assert.equal(failed.query('#loginForm input[name="password"]').value, "wrong-password"); assert.equal(failed.query("#researchNotice").open, false);
});

test("non-JSON failures and timeouts are friendly and do not retry writes", async () => {
  const h = harness(); let requests = 0;
  h.sandbox.fetch = async () => { requests++; return { ok: false, status: 503, json: async () => { throw new SyntaxError("HTML server detail"); } }; };
  await assert.rejects(h.fn("api")("/api/orders", { method: "POST" }), /request could not be completed/); assert.equal(requests, 1);
  h.sandbox.fetch = async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); };
  await assert.rejects(h.fn("api")("/api/orders"), /taking longer than expected/);
});

test("uncertain Shopify outcomes show the check action; cache refresh is deliberate and admin-only", async () => {
  const h = harness(); const copy = h.fn("renderShopifySync")(order("uncertain", { paymentStatus: "confirmed", shopifySync: { status: "reconciliation_required", message: "Internal response" } }));
  assert.match(copy, /Check Shopify order/); assert.match(copy, /No new order will be created automatically/); assert.doesNotMatch(copy, /Internal response/);
  h.state.admin = { id: "admin" }; h.state.adminView = "system-status";
  h.state.systemStatus = { systems: [{ label: "Catalogue cache", state: "online" }] }; h.fn("renderSystemStatus")();
  assert.equal(h.requests.length, 0);
  h.respond((url) => url === "/api/admin/catalog/refresh" ? { ok: true, products: 422, cache: {} } : { ok: true, systems: [{ label: "Catalogue cache", state: "online" }] });
  await h.fn("refreshAdminCatalog")(h.query("#adminRefresh")); assert.equal(h.requests[0].options.method, "POST"); assert.match(h.query("#toast").textContent, /422 products/);
  const ordinary = harness(); signedIn(ordinary); await ordinary.fn("refreshAdminCatalog")({ disabled: false }); assert.equal(ordinary.requests.length, 0);
});

test("manuals use existing local images/PDFs and zoom assets fit the shared CSP", async () => {
  const h = harness();
  for (const manual of ["peptides", "performance"]) {
    h.state.manualId = manual; h.fn("renderManual")();
    const image = h.query("#manualPageImage").src;
    assert.ok(image.startsWith("/manuals/pages/")); assert.equal(h.query("#manualPageImage").tagName, "img");
    assert.ok((await stat(path.join(root, "public", image))).isFile()); assert.ok((await stat(path.join(root, "public", h.query("#manualOpen").href))).isFile());
  }
  const csp = securityHeaders["content-security-policy"];
  assert.match(csp, /script-src 'self'/); assert.match(csp, /img-src 'self' data: https:\/\/cdn\.shopify\.com https:\/\/\*\.shopify\.com/);
  assert.ok((await stat(path.join(root, "public/vendor/panzoom/panzoom.es.js"))).isFile());
  assert.match(source, /import\("\/vendor\/panzoom\/panzoom\.es\.js"\)/);
  assert.ok((await readFile(path.join(root, "netlify.toml"), "utf8")).includes(csp));
});

// Regression coverage for the session/modal and retained-history review findings.
test("session expiry during post-submission refresh must not reopen a private order modal", async () => {
  const h = harness(); basket(h); h.state.pendingOrderDraft = { items: [...h.state.cart.values()], expectedTotal: 170, delivery: { address: customer.addresses[0] }, idempotencyKey: "submitted" };
  h.respond((url) => url === "/api/orders" ? { ok: true, order: order("private-submitted") } : { status: 401, payload: { ok: false, error: "Session expired." } });
  await h.fn("confirmPendingOrder")(); await h.flush();
  assert.equal(h.state.user, null); assert.equal(h.query("#orderFlowModal").hidden, true, "The submitted modal must stay closed over the login screen.");
  assert.equal(h.state.activePaymentOrder, null);
});

test("session expiry during paid-notice refresh must not reopen the payment modal", async () => {
  const h = harness(); signedIn(h);
  h.respond((url) => url.endsWith("/paid-notice") ? { ok: true, order: order("private-paid") } : { status: 401, payload: { ok: false, error: "Session expired." } });
  await h.fn("reportPaidNotice")("private-paid"); await h.flush();
  assert.equal(h.state.user, null); assert.equal(h.query("#orderFlowModal").hidden, true, "The payment modal must stay closed over the login screen.");
});

test("session expiry during payment-issue refresh must not reopen the payment modal", async () => {
  const h = harness(); signedIn(h);
  h.fn("showPaymentIssueModal")(order("private-issue"));
  h.respond((url) => url.endsWith("/payment-issue") ? { ok: true, order: order("private-issue") } : { status: 401, payload: { ok: false, error: "Session expired." } });
  await h.fn("submitPaymentIssueForm")({ preventDefault() {}, target: h.query(".payment-issue-form") }); await h.flush();
  assert.equal(h.state.user, null); assert.equal(h.query("#orderFlowModal").hidden, true);
  assert.equal(h.state.activePaymentOrder, null);
});

test("a receipt confirmed elsewhere must not be prompted from retained older history", async () => {
  const h = harness(); signedIn(h); h.state.customerOrdersLoaded = true; h.state.receiptAutoPrompted = true;
  const old = order("old-delivery", { fulfillmentStatus: "shipped", deliveryReceipt: { canConfirm: true, promptDue: true, promptAfter: "2026-01-01" } });
  const recent = Array.from({ length: 50 }, (_, index) => order(`recent-${index}`, { deliveryReceipt: { receivedAt: "2026-11-01" } }));
  h.state.customerOrders = [...recent, old]; h.state.customerHomeOrders = [old];
  h.respond((url) => url === "/api/orders/old-delivery" ? { ok: true, order: { ...old, deliveryReceipt: { receivedAt: "2026-11-09", canConfirm: false, promptDue: false } } } : { ok: true, orders: recent, activeOrders: [], page: page(0, true) });
  await h.fn("loadCustomerOrders")({ quiet: true });
  h.state.receiptAutoPrompted = false; await h.fn("maybePromptDeliveryReceipt")(); await h.flush();
  assert.equal(h.query("#deliveryReceiptDialog").open, false, "An older order removed from active results must be checked before prompting again.");
  assert.equal(h.fn("customerOrderById")("old-delivery").deliveryReceipt.receivedAt, "2026-11-09");
  assert.equal(h.requests.filter((request) => request.url === "/api/orders/old-delivery").length, 1);
});

test("a still-due receipt is checked once, updates history and opens one prompt", async () => {
  const h = harness(); signedIn(h); h.state.customerOrdersLoaded = true;
  const old = order("still-due", { fulfillmentStatus: "shipped", deliveryReceipt: { canConfirm: true, promptDue: true, promptAfter: "2026-01-01" } });
  h.state.customerHomeOrders = [old]; h.state.customerOrders = [old]; let release;
  h.respond(() => new Promise((resolve) => { release = resolve; }));
  const first = h.fn("maybePromptDeliveryReceipt")(), second = h.fn("maybePromptDeliveryReceipt")();
  assert.equal(h.requests.length, 1);
  release({ ok: true, order: { ...old, updatedAt: "2026-11-09T10:00:00Z" } });
  await Promise.all([first, second]); await h.flush();
  assert.equal(h.query("#deliveryReceiptDialog").open, true); assert.equal(h.state.receiptOrderId, "still-due");
  assert.equal(h.state.receiptAutoPrompted, true); assert.equal(h.state.customerOrders[0].updatedAt, "2026-11-09T10:00:00Z");
  await h.fn("maybePromptDeliveryReceipt")(); assert.equal(h.requests.length, 1);
});

test("an unavailable receipt check opens no stale prompt and permits a later check", async () => {
  const h = harness(); signedIn(h); h.state.customerOrdersLoaded = true;
  const old = order("retry-receipt", { fulfillmentStatus: "shipped", deliveryReceipt: { canConfirm: true, promptDue: true, promptAfter: "2026-01-01" } });
  h.state.customerOrders = [old]; h.respond(() => ({ status: 503, payload: { ok: false, error: "Try later." } }));
  await h.fn("maybePromptDeliveryReceipt")();
  assert.equal(h.query("#deliveryReceiptDialog").open, false); assert.equal(h.state.receiptAutoPrompted, false);
  h.respond(() => ({ ok: true, order: old })); await h.fn("maybePromptDeliveryReceipt")();
  assert.equal(h.query("#deliveryReceiptDialog").open, true); assert.equal(h.requests.length, 2);
});

test("real isolated APIs agree with frontend page/filter/owner/cache and checkout contracts", async () => {
  const portal = await startIsolatedPortal();
  try {
    const servedHtml = await (await fetch(portal.url)).text();
    for (const asset of ["app.js", "styles.css"]) {
      const assetUrl = new RegExp(`(?:src|href)="(/${asset.replace(".", "\\.")}\\?v=[^"]+)"`).exec(servedHtml)?.[1];
      assert.ok(assetUrl, `The entry page must version ${asset}.`);
      assert.equal(await (await fetch(portal.url + assetUrl)).text(), await readFile(path.join(root, "public", asset), "utf8"));
    }
    const session = () => {
      let cookie = "";
      return async (url, body, expectedStatus = 200) => {
        const response = await fetch(portal.url + url, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-op-client": "portal", cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
        const result = await response.json(); assert.equal(response.status, expectedStatus, `${url}: ${JSON.stringify(result)}`); return result;
      };
    };
    const admin = session(), owner = session(), anonymous = session();
    await admin("/api/auth/admin-login", { username: "admin", password: "admin" });
    const user = (await owner("/api/auth/login", { login: "user", password: "user" })).user;
    const catalog = await owner("/api/catalog"); const variantId = catalog.products[0].variant.id;
    await admin("/api/admin/shop-settings", { courier: { amount: 87 } });
    const checked = await owner("/api/cart/check", { items: [{ variantId, quantity: 1 }] }); assert.equal(checked.deliveryFee, 87);
    const created = (await owner("/api/orders", { items: [{ variantId, quantity: 1 }], idempotencyKey: randomUUID(), expectedTotal: checked.total }, 201)).order;
    assert.equal(created.total, checked.total);
    await admin("/api/admin/shop-settings", { courier: { amount: 89 } });
    await owner("/api/orders", { items: [{ variantId, quantity: 1 }], idempotencyKey: randomUUID(), expectedTotal: checked.total }, 409);
    const refreshed = await owner("/api/cart/check", { items: [{ variantId, quantity: 1 }] });
    assert.equal(refreshed.total, checked.total + 2);
    await admin("/api/admin/shop-settings", { courier: { amount: 87 } });
    await owner("/api/orders", { items: [{ variantId, quantity: 1 }], idempotencyKey: randomUUID(), expectedTotal: checked.total + 1 }, 409);
    const saved = JSON.parse(await readFile(path.join(portal.directory, "data/orders.json"), "utf8")).orders[0];
    const rows = Array.from({ length: 70 }, (_, index) => ({ ...saved, id: `fixture-${String(index).padStart(3, "0")}`, reference: `FIX-${String(index).padStart(3, "0")}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), fulfillmentStatus: "shipped", paymentStatus: "confirmed" }));
    rows.push({ ...saved, id: "old-active", reference: "OLD-ACTIVE", createdAt: "2025-01-01T00:00:00Z", fulfillmentReview: { status: "pending" } });
    rows.push({ ...saved, id: "private-peer", reference: "PRIVATE-PEER", customer: { ...saved.customer, id: "someone-else" } });
    await writeFile(path.join(portal.directory, "data/orders.json"), JSON.stringify({ orders: rows }));
    await writeFile(path.join(portal.directory, "data/customer-messages.json"), JSON.stringify({ messages: rows.slice(0, 70).map((entry) => ({ id: `receipt:${entry.id}`, kind: "delivery_receipt", orderId: entry.id, customerId: user.id, status: "received", receivedAt: "2026-11-01T00:00:00Z" })) }));
    const history = await owner("/api/orders?limit=50&offset=0"); assert.equal(history.orders.length, 50); assert.equal(history.page.hasMore, true); assert.deepEqual(history.activeOrders.map((entry) => entry.id), ["old-active"]);
    assert.equal((await owner("/api/orders?limit=50&offset=50")).orders.length, 21);
    assert.equal((await owner("/api/orders/old-active")).order.id, "old-active"); await owner("/api/orders/private-peer", null, 404); await anonymous("/api/orders/old-active", null, 401);
    const filtered = await admin("/api/admin/orders?view=pending&filter=fulfillment_review&search=OLD-ACTIVE&limit=50&offset=0"); assert.deepEqual(filtered.orders.map((entry) => entry.id), ["old-active"]);
    const completed = await admin("/api/admin/orders?view=completed&filter=all&limit=50&offset=50"); assert.equal(completed.orders.length, 20); assert.equal(completed.page.hasMore, false);
    const accounts = await admin("/api/admin/accounts?role=admin&limit=50&offset=0"); assert.ok(accounts.accounts.every((entry) => entry.role === "admin")); assert.equal(accounts.counts.admin, accounts.accounts.length);
    await owner("/api/admin/catalog/refresh", {}, 401); assert.equal((await admin("/api/admin/catalog/refresh", {})).cache.fresh, true);
    await admin("/api/admin/orders/old-active/fulfillment", { allocations: [{ variantId, officeQuantity: 1, externalQuantity: 0 }] });
    await admin("/api/admin/orders/old-active/payment-link", { provider: "yoco", url: "https://pay.yoco.com/local-frontend-fixture" });
    await admin("/api/admin/orders/old-active/confirm-payment", {});
    const internal = async (action, body, expectedStatus = 200) => {
      const response = await fetch(`${portal.url}/api/internal/orders/old-active/${action}`, { method: "POST", headers: { "content-type": "application/json", "x-internal-token": "dev-internal-token" }, body: JSON.stringify(body) });
      const result = await response.json(); assert.equal(response.status, expectedStatus, JSON.stringify(result));
    };
    await internal("ship", {}, 409);
    await internal("tracking", { number: "QA-TRACK", url: "http://example.com/track" }, 400);
    await internal("tracking", { courier: "Courier", number: "QA-TRACK", url: "https://example.com/track" });
    await internal("ship", {});
    const shipped = (await owner("/api/orders/old-active")).order;
    assert.equal(shipped.fulfillmentStatus, "shipped");
    const h = harness(); h.fn("showTrackingModal")(shipped);
    assert.equal(h.query('#orderFlowActions a').getAttribute("href"), "https://example.com/track");
  } finally { await portal.close(); }
});
