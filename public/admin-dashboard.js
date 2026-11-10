const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const money = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat("en-ZA");
const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", dateStyle: "medium", timeStyle: "short" }) : "—";
export const adminQueueLabels = { unprocessed: "Unprocessed", processing: "In fulfilment", completed: "Completed", closed: "Declined / rejected", review: "Review orders", details: "Send payment details", awaiting_payment: "Awaiting customer payment", verify: "Verify payments", storage: "Stock transfer required", sync: "Shopify orders to check", tracking: "Office tracking required", packing: "Ready to pack", external: "External tracking required", back_order: "Back orders", payment_support: "Payment support" };
export function periodParams(period) { return { period: period.period || "all", ...(period.period === "custom" ? { from: period.from, to: period.to } : {}) }; }
export function reportingControls(period, id) {
  return `<form class="admin-period-controls" id="${id}" aria-label="Order date range"><label>Order date<select name="period">${[["today","Today"],["7d","Last 7 days"],["30d","Last 30 days"],["90d","Last 90 days"],["all","All time"],["custom","Custom range"]].map(([value,label]) => `<option value="${value}" ${period.period === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><div class="admin-custom-dates" ${period.period !== "custom" ? "hidden" : ""}><label>From<input type="date" name="from" value="${escape(period.from || "")}" ${period.period === "custom" ? "required" : "disabled"}></label><label>To<input type="date" name="to" value="${escape(period.to || "")}" ${period.period === "custom" ? "required" : "disabled"}></label></div><button class="secondary" type="submit">Apply</button></form>`;
}
export function readReportingControls(form) {
  const values = new FormData(form);
  return { period: values.get("period"), from: values.get("from") || "", to: values.get("to") || "" };
}
export function toggleCustomDates(form) {
  const custom = form.elements.period.value === "custom";
  form.querySelector(".admin-custom-dates").hidden = !custom;
  form.querySelectorAll('input[type="date"]').forEach(input => { input.disabled = !custom; input.required = custom; });
}

export function mountAdminDashboard({ root, summary, api, active, getPeriod, setPeriod, navigate, portal, name }) {
  let revision = 0, healthRevision = 0, alive = true, model = null, systems = null, systemsError = false, loadError = "";
  const current = request => alive && active() && request === revision;
  const orderButton = (queue, label, className = "") => `<button type="button" class="${className}" data-dashboard-queue="${queue}">${label}</button>`;
  function render() {
    if (!alive || !active()) return;
    const orders = model?.orders, period = getPeriod();
    summary.innerHTML = "";
    root.innerHTML = `<section class="admin-overview">
      <div class="dashboard-welcome"><div><p class="eyebrow">Operations overview</p><h3>Welcome back${name() ? `, ${escape(name().split(" ")[0])}` : ""}.</h3><p>A clear view of your orders and what needs attention.</p></div><div class="dashboard-access"><span class="dashboard-pill ${!portal() || portal().paused ? "warning" : "good"}">${!portal() ? "Portal status unknown" : portal().paused ? "Portal paused" : "Portal open"}</span>${model && typeof model.shopifySyncEnabled === "boolean" ? `<span class="dashboard-pill ${model.shopifySyncEnabled ? "good" : "neutral"}">Shopify sync ${model.shopifySyncEnabled ? "on" : "off"}</span>` : ""}</div></div>
      <div class="dashboard-report-heading"><div><h3>Order performance</h3><p class="muted small">By date placed · South Africa time</p></div>${reportingControls(period, "dashboardPeriodForm")}</div>
      <p class="dashboard-updated muted small" role="status">${orders ? `${integer.format(orders.lifetimeTotal)} orders overall · ` : ""}${model ? `Updated ${date(model.checkedAt)} · ${escape(model.period?.label || "")}` : "Loading your overview…"}</p>
      ${orders ? `<div class="dashboard-kpis">${[["", "All orders", orders.total, "Every order placed"],["unprocessed", "Unprocessed", orders.unprocessed, "Payment not yet confirmed"],["processing", "In fulfilment", orders.processing, "Paid, awaiting full dispatch"],["completed", "Completed", orders.completed, "All parts dispatched"]].map(([key,label,value,detail]) => orderButton(key, `<span>${label}</span><strong>${integer.format(value)}</strong><small>${detail}</small><span class="dashboard-card-arrow" aria-hidden="true">↗</span>`, `dashboard-kpi ${key === "unprocessed" && value ? "has-work" : ""}`)).join("")}</div>
      <div class="dashboard-finance"><div><span>Order value</span><strong>${money.format(orders.value)}</strong></div><div><span>Payment confirmed</span><strong>${money.format(orders.paidValue)}</strong></div><div><span>Awaiting confirmation</span><strong>${money.format(orders.pendingValue)}</strong></div><div><span>Average order value</span><strong>${money.format(orders.total - orders.closed > 0 ? orders.value / (orders.total - orders.closed) : 0)}</strong></div></div>
      <div class="dashboard-breakdown"><div class="dashboard-progress" aria-hidden="true">${[["unprocessed",orders.unprocessed],["processing",orders.processing],["completed",orders.completed],["closed",orders.closed]].filter(([,n])=>n).map(([key,n]) => `<span class="phase-${key}" style="flex-grow:${n}"></span>`).join("")}</div><p class="muted small">Current status of orders placed in this period. Values include delivery and exclude declined/rejected orders. Completed means dispatched; customer receipt is tracked separately.</p>${orderButton("closed", `${integer.format(orders.closed)} declined / rejected`, "dashboard-text-link")}</div>` : model ? `<div class="dashboard-error" role="status"><strong>Order overview unavailable</strong><p>${escape(loadError || "Counts could not be loaded. Existing orders are still accessible.")}</p><button class="secondary" type="button" data-dashboard-retry>Try again</button></div>` : `<div class="dashboard-loading" role="status">Loading order totals…</div>`}
      <div class="dashboard-main-columns"><section class="dashboard-section"><div class="dashboard-section-heading"><div><p class="eyebrow">Action centre</p><h3>Needs attention</h3></div><span class="dashboard-pill neutral">All dates</span></div><p class="muted small">Open a queue to take action. Split orders can appear in more than one queue.</p>${attention(orders?.attention, model?.messages)}</section>
      <section class="dashboard-section dashboard-systems"><div class="dashboard-section-heading"><div><p class="eyebrow">Connections</p><h3>System health</h3></div><button type="button" class="dashboard-text-link" data-dashboard-system-check ${!systems && !systemsError ? "disabled" : ""}>${!systems && !systemsError ? "Checking…" : "Check now"}</button></div><div id="dashboardHealthContent">${health()}</div><button type="button" class="secondary dashboard-wide" data-dashboard-view="system-status">View system details</button></section></div>
      <section class="dashboard-section"><div class="dashboard-section-heading"><div><p class="eyebrow">Latest activity</p><h3>Recent orders</h3></div><button type="button" class="dashboard-text-link" data-dashboard-queue="">View all orders</button></div>${recent()}</section>
    </section>`;
  }
  function attention(counts, messages) {
    const descriptions = { verify: "Customers have marked their orders as paid", review: "Confirm products, quantities and fulfilment", details: "Review is complete; provide payment instructions", storage: "Move stock to Office, then check availability", sync: "Investigate before continuing fulfilment", tracking: "Assign tracking in Retail Shark", packing: "Tracking assigned; pack and dispatch in Retail Shark", external: "Add tracking in Online Portal", back_order: "Follow up on outstanding paid orders", payment_support: "Customers need help with payment" };
    if (!counts) return `<p class="muted" role="status">${model ? "Order queues could not be loaded." : "Loading work queues…"}</p>`;
    const rows = ["sync","storage","verify","review","details","external","tracking","packing","back_order","payment_support"];
    return `<div class="dashboard-queues">${rows.filter(key => counts[key] || ["verify","review","details","packing"].includes(key)).map(key => `<button type="button" class="dashboard-queue ${counts[key] ? "has-work" : ""}" data-dashboard-attention="${key}"><span><strong>${adminQueueLabels[key]}</strong><small>${descriptions[key]}</small></span><span class="dashboard-queue-count">${integer.format(counts[key] || 0)}</span><span aria-hidden="true">›</span></button>`).join("")}
      ${[["support", "Customer support", "Open customer requests"],["email", "Email needs attention", "Failed, delayed or undeliverable messages"]].map(([key,label,detail]) => `<button type="button" class="dashboard-queue ${messages?.[key] ? "has-work" : ""}" data-dashboard-care="${key}"><span><strong>${label}</strong><small>${detail}</small></span><span class="dashboard-queue-count">${messages ? integer.format(messages[key]) : "—"}</span><span aria-hidden="true">›</span></button>`).join("")}</div>${!messages && model ? '<p class="muted small">Support and email counts are unavailable. Open the relevant view to retry.</p>' : ""}`;
  }
  function health() {
    if (systemsError) return '<p class="dashboard-error" role="status">System checks could not finish. Select Check now to try again.</p>';
    if (!systems) return '<p class="muted" role="status">Checking connections…</p>';
    return `<p class="muted small">Checked ${date(systems.checkedAt)}</p><div class="dashboard-health-list">${(systems.systems || []).map(system => `<div class="dashboard-health-row"><span class="health-dot ${escape(system.state)}" aria-hidden="true"></span><div><strong>${escape(system.label)}</strong><small>${escape(system.detail)}</small></div><span class="dashboard-health-label">${escape({online:"Online",configured:"Configured",offline:"Offline",error:"Error"}[system.state] || "Unknown")}</span></div>`).join("")}</div><div class="dashboard-feature-flags">${[["orderEmailsEnabled","Order emails"],["accountEmailsEnabled","Account emails"]].map(([key,label]) => `<span class="dashboard-pill neutral">${label}: ${systems.capabilities?.[key] == null ? "unknown" : systems.capabilities[key] ? "on" : "off"}</span>`).join("")}</div><p class="muted small">Connection health and sending configuration are separate from enabled features. Check email history for delivery results.</p>`;
  }
  function recent() {
    if (!model) return '<p class="muted">Loading recent orders…</p>';
    if (!model.recent) return '<p class="muted">Recent orders could not load.</p>';
    if (!model.recent.length) return '<div class="dashboard-empty"><strong>No orders in this period</strong><p class="muted">Try a wider date range to see earlier orders.</p></div>';
    return `<div class="dashboard-table-wrap"><table class="dashboard-table"><thead><tr><th>Order / customer</th><th>Placed</th><th>Status</th><th class="numeric">Total</th></tr></thead><tbody>${model.recent.map(order => {
      const label = order.specialStatus === "declined" || order.paymentStatus === "rejected" ? "Declined / rejected" : order.fulfillmentStatus === "shipped" ? "Completed" : order.paymentStatus === "confirmed" ? "In fulfilment" : "Unprocessed";
      return `<tr><td><button type="button" class="dashboard-text-link" data-dashboard-order="${escape(order.reference)}">${escape(order.reference)}</button><small>${escape(order.customerName)}</small></td><td>${date(order.createdAt)}</td><td><span class="dashboard-pill neutral">${label}</span></td><td class="numeric">${money.format(Number(order.total) || 0)}</td></tr>`;
    }).join("")}</tbody></table></div>`;
  }
  async function loadHealth(request) {
    const check = ++healthRevision;
    systems = null; systemsError = false;
    const update = () => { if (current(request) && check === healthRevision) {
      const node = root.querySelector("#dashboardHealthContent"), button = root.querySelector("[data-dashboard-system-check]");
      if (node) node.innerHTML = health();
      if (button) { button.disabled = !systems && !systemsError; button.textContent = button.disabled ? "Checking…" : "Check now"; }
    } };
    update();
    try { const result = await api("/api/admin/system-status"); if (current(request) && check === healthRevision) systems = result; }
    catch { if (current(request) && check === healthRevision) systemsError = true; }
    update();
  }
  async function load({ checkSystems = !systems } = {}) {
    const request = ++revision;
    model = null; loadError = ""; render();
    const healthWork = checkSystems ? loadHealth(request) : Promise.resolve();
    try { const result = await api(`/api/admin/dashboard?${new URLSearchParams(periodParams(getPeriod()))}`); if (current(request)) model = result; }
    catch (error) {
      if (current(request)) { model = { checkedAt: new Date().toISOString(), orders: null, messages: null, recent: null }; loadError = error.message; }
    }
    if (current(request)) render();
    await healthWork;
  }
  const click = event => {
    const target = event.target.closest("button"); if (!target || !alive || !active()) return;
    if (target.hasAttribute("data-dashboard-queue")) navigate({ view: "all", queue: target.dataset.dashboardQueue, period: getPeriod() });
    if (target.dataset.dashboardAttention) navigate({ view: "all", queue: target.dataset.dashboardAttention, period: { period: "all" } });
    if (target.dataset.dashboardView) navigate({ view: target.dataset.dashboardView });
    if (target.dataset.dashboardCare) navigate({ view: "customer-care", care: target.dataset.dashboardCare });
    if (target.dataset.dashboardOrder) navigate({ view: "all", search: target.dataset.dashboardOrder, period: { period: "all" } });
    if (target.hasAttribute("data-dashboard-retry")) load();
    if (target.hasAttribute("data-dashboard-system-check")) loadHealth(revision);
  };
  const change = event => { if (event.target.matches('#dashboardPeriodForm select[name="period"]')) toggleCustomDates(event.target.closest("form")); };
  const submit = event => { if (event.target.id === "dashboardPeriodForm") { event.preventDefault(); setPeriod(readReportingControls(event.target)); load(); } };
  root.addEventListener("click", click); root.addEventListener("change", change); root.addEventListener("submit", submit);
  return { load, destroy() { alive = false; revision++; root.removeEventListener("click", click); root.removeEventListener("change", change); root.removeEventListener("submit", submit); } };
}
