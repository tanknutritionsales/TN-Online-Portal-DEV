const eventLabels = { order_received: "Order received", payment_ready: "Payment ready", payment_confirmed: "Payment confirmed", shipped: "Shipment update", email_verification: "Email verification", password_reset: "Password reset", password_changed: "Password changed" };
const statusLabels = { pending: "Queued", sending: "Sending", sent: "Sent to email service", delivered: "Delivered", delayed: "Delayed", bounced: "Bounced", complained: "Complaint", suppressed: "Suppressed", failed: "Failed", expired: "Expired", superseded: "No longer required", disabled: "Off", setup_required: "Setup required" };
const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" }) : "—";

export function mountAdminEmail({ root, summary, toolbar, api, toast, active, initialSearch = "", initialStatus = "all" }) {
  let offset = 0, request = 0, alive = true, timer;
  root.innerHTML = `${toolbar}<section class="email-delivery-panel"><div id="emailConnectionStatus" class="email-connection-status" role="status"></div>
    <form id="emailFilters" class="email-filter-bar" role="search"><label>Find email<input name="search" type="search" placeholder="Customer, email or order reference" maxlength="180" value="${escape(initialSearch)}"></label>
    <label>Purpose<select name="event"><option value="all">All emails</option>${Object.entries(eventLabels).map(([key, label]) => `<option value="${key}">${label}</option>`).join("")}</select></label>
    <label>Status<select name="status"><option value="all">All statuses</option><option value="attention" ${initialStatus === "attention" ? "selected" : ""}>Needs attention</option>${Object.entries(statusLabels).map(([key, label]) => `<option value="${key}">${label}</option>`).join("")}</select></label><button class="secondary" type="submit">Search</button></form>
    <p id="emailDeliverySummary" class="muted small"></p><div id="emailDeliveryResults" aria-live="polite"></div>
    <nav class="pagination email-pagination" aria-label="Email pagination"><button class="secondary" type="button" data-email-page="prev">Prev</button><span id="emailPageLabel"></span><button class="secondary" type="button" data-email-page="next">Next</button></nav></section>`;
  const form = root.querySelector("#emailFilters"), results = root.querySelector("#emailDeliveryResults");
  const current = () => alive && active();
  async function load() {
    const revision = ++request, fields = new FormData(form);
    results.innerHTML = '<p class="muted" role="status">Loading email history…</p>';
    root.querySelectorAll("[data-email-page]").forEach(button => { button.disabled = true; });
    try {
      const payload = await api(`/api/admin/notifications?${new URLSearchParams({ search: fields.get("search"), event: fields.get("event"), status: fields.get("status"), limit: "50", offset: String(offset) })}`);
      if (!current() || revision !== request) return;
      const setup = payload.emailSetup;
      root.querySelector("#emailConnectionStatus").innerHTML = `<strong>${setup.configured ? "Email service configured" : "Email setup required"}</strong><span>Order emails: ${setup.enabled ? "On" : "Off"}</span><span>Account emails: ${setup.securityEnabled ? "On" : "Off"}</span><span>Delivery feedback: ${setup.webhookConfigured ? "Configured" : "Awaiting setup"}</span>${setup.missing.length ? `<p>${setup.missing.map(escape).join(" · ")}</p>` : ""}`;
      summary.textContent = "Email delivery";
      root.querySelector("#emailDeliverySummary").textContent = `${payload.counts.total} matching ${payload.counts.total === 1 ? "email" : "emails"} · ${payload.counts.attention} ${payload.counts.attention === 1 ? "needs" : "need"} attention. Delivered means accepted by the recipient’s mail server, not confirmed as read.`;
      results.innerHTML = payload.emails.length ? payload.emails.map(email => `<details class="support-thread email-history-row"><summary><span><strong>${escape(eventLabels[email.event] || email.subject)}</strong><small>${escape(email.to)}${email.category === "order" ? ` · ${escape(email.reference)}` : ""}</small></span><span class="status-badge email-status-${escape(email.displayStatus)}">${escape(statusLabels[email.displayStatus] || email.displayStatus)}</span></summary>
        <div class="support-thread-body"><p><strong>${escape(email.subject)}</strong></p><dl class="email-metadata"><div><dt>Recipient</dt><dd>${escape(email.to)}</dd></div><div><dt>Created</dt><dd>${date(email.createdAt)}</dd></div><div><dt>Sent</dt><dd>${date(email.sentAt)}</dd></div><div><dt>Attempts</dt><dd>${email.attempts}</dd></div></dl>
        ${email.deliveryDetail || email.lastError ? `<p class="email-form-feedback">${escape(email.deliveryDetail || email.lastError)}</p>` : ""}
        ${email.history.length ? `<ol class="email-event-history">${email.history.map(event => `<li><strong>${escape(statusLabels[event.status] || event.status)}</strong><span>${date(event.at)}</span>${event.detail ? `<p>${escape(event.detail)}</p>` : ""}</li>`).join("")}</ol>` : ""}
        ${email.retryable ? `<button class="secondary" type="button" data-email-delivery-retry="${escape(email.id)}" ${setup.configured && setup.enabled ? "" : "disabled"}>Retry delivery</button>` : email.category === "security" ? `<p class="muted small">Security links stay private. Request a fresh verification from Accounts, or use Forgot password on the login page.</p>` : ""}</div></details>`).join("") : '<p class="muted">No emails match these filters.</p>';
      root.querySelector("#emailPageLabel").textContent = `Page ${Math.floor(offset / 50) + 1}`;
      root.querySelector('[data-email-page="prev"]').disabled = offset === 0;
      root.querySelector('[data-email-page="next"]').disabled = !payload.page.hasMore;
      root.querySelector(".email-pagination").hidden = offset === 0 && !payload.page.hasMore;
    } catch (error) { if (current() && revision === request) results.innerHTML = `<p role="status">${escape(error.message)}</p><button class="secondary" type="button" data-email-reload>Try again</button>`; }
  }
  const submit = event => { if (event.target !== form) return; event.preventDefault(); clearTimeout(timer); offset = 0; load(); };
  const change = event => { if (event.target.tagName === "SELECT") { offset = 0; load(); } };
  const input = event => { if (event.target.name === "search") { request++; clearTimeout(timer); offset = 0; timer = setTimeout(load, 350); } };
  const click = async event => {
    const pager = event.target.closest("[data-email-page]");
    if (pager && !pager.disabled) { offset = pager.dataset.emailPage === "next" ? offset + 50 : Math.max(0, offset - 50); load(); }
    if (event.target.closest("[data-email-reload]")) load();
    const retry = event.target.closest("[data-email-delivery-retry]");
    if (retry && !retry.disabled) {
      retry.disabled = true;
      try { await api(`/api/admin/notifications/${encodeURIComponent(retry.dataset.emailDeliveryRetry)}/retry`, { method: "POST", body: "{}" }); if (current()) { toast("Delivery status updated."); load(); } }
      catch (error) { if (current()) { toast(error.message); retry.disabled = false; } }
    }
  };
  root.addEventListener("submit", submit); form.addEventListener("change", change); form.addEventListener("input", input); root.addEventListener("click", click); load();
  return () => { alive = false; request++; clearTimeout(timer); root.removeEventListener("submit", submit); form.removeEventListener("change", change); form.removeEventListener("input", input); root.removeEventListener("click", click); };
}
