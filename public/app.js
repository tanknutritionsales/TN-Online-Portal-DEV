const money = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" });

const state = {
  user: null,
  admin: null,
  products: [],
  filters: { groups: [], tags: [], vendors: [], productTypes: [] },
  brandCollections: [],
  selectedBrand: "",
  selectedTypes: new Set(),
  inStockOnly: false,
  search: "",
  theme: "light",
  productPage: 1,
  productsPerPage: 30,
  shopSettings: null,
  adminProductSearch: "",
  adminOrders: [],
  customerOrders: [],
  adminView: "pending",
  adminAccounts: [],
  adminAccountFilter: "all",
  editingAdminAccountId: "",
  systemStatus: null,
  pendingAccountRemoval: null,
  pendingAddressRemoval: null,
  editingAddressId: null,
  addressModalSource: "account",
  selectedAddressId: "",
  pendingOrderDraft: null,
  activePaymentOrder: null,
  cart: new Map(),
  banking: null,
};

const productTypes = [
  { id: "vial", label: "Vials", tokens: ["vial", "vials"] },
  { id: "oral", label: "Orals", tokens: ["oral", "orals", "tablet", "tablets", "tabs", "caps", "capsules"] },
  { id: "pen", label: "Pens", tokens: ["pen", "pens", "kwikpen"] },
  { id: "nasal", label: "Nasal", tokens: ["nasal"] },
];

const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

function defaultShopSettings() {
  return {
    featured: {
      mode: "collection",
      title: "Featured Dex",
      subtitle: "Fast access to the products customers ask for most.",
      collectionQuery: "Dex",
      customProductIds: [],
    },
    payment: {
      accountName: "Tank Nutrition",
      bankName: "",
      accountNumber: "",
      branchCode: "",
      note: "Once POP has been uploaded, the order will be verified and tracking details will follow.",
    },
    references: {
      standardFormat: "OP-{YYYY}{MM}{DD}-{RAND4}",
      specialFormat: "SO-{YYYY}{MM}{DD}-{RAND4}",
    },
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || "Request failed.");
  return payload;
}

function toast(message) {
  const el = qs("#toast");
  el.textContent = message;
  el.classList.add("is-visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("is-visible"), 3200);
}

function showScreen(screen) {
  qs("#loginScreen").hidden = screen !== "login";
  qs("#createAccountScreen").hidden = screen !== "create";
  qs("#appScreen").hidden = screen !== "app";
}

function showAuth() {
  state.user = null;
  state.admin = null;
  applyTheme("light");
  showScreen("login");
}

async function showApp(session) {
  state.user = session.user || null;
  state.admin = session.admin || null;
  showScreen("app");
  qsa(".customer-tab").forEach((tab) => {
    tab.hidden = Boolean(state.admin);
  });
  qs(".admin-tab").hidden = !state.admin;
  qs("#themeToggle").hidden = false;
  qs("#accountName").textContent = state.admin ? state.admin.name || state.admin.username || "Admin" : state.user.name;
  applyTheme(state.admin?.preferences?.theme || state.user?.preferences?.theme || "light");
  switchView(state.admin ? "admin" : "order");
  if (state.admin) {
    await loadAdminOrders();
    return;
  }
  state.selectedAddressId = defaultUserAddress()?.id || "";
  fillDeliveryForm(selectedCheckoutAddress() || state.user.defaultAddress);
  renderAccount();
  renderCheckoutAddresses();
  await loadCatalog();
  await loadCustomerOrders();
}

function switchView(view) {
  qsa(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === view));
  qsa(".view").forEach((panel) => panel.classList.toggle("is-active", panel.id === `view-${view}`));
  const titles = {
    order: "Shop",
    cart: "Cart",
    orders: "My orders",
    account: "My account",
    admin: "Admin",
  };
  qs("#screenTitle").textContent = titles[view] || "Shop";
  if (view === "orders" && state.user) loadCustomerOrders();
  if (view === "account" && state.user) renderAccount();
  if (view === "admin" && state.admin) loadAdminOrders();
}

async function initSession() {
  try {
    const session = await api("/api/auth/me");
    if (session.user || session.admin) await showApp(session);
    else showAuth();
  } catch {
    showAuth();
  }
}

async function login(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const loginValue = String(form.get("login") || "").trim();
  const password = String(form.get("password") || "");
  try {
    if (loginValue.toLowerCase() === "admin") {
      const payload = await api("/api/auth/admin-login", {
        method: "POST",
        body: JSON.stringify({ username: loginValue, password }),
      });
      await showApp({ admin: payload.admin });
      return;
    }
    const payload = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ login: loginValue, password }),
    });
    await showApp({ user: payload.user });
  } catch (error) {
    toast(error.message);
  }
}

async function register(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    const payload = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        username: form.get("username"),
        name: form.get("name"),
        email: form.get("email"),
        phoneArea: form.get("phoneArea"),
        phoneNumber: form.get("phoneNumber"),
        defaultAddress: addressFromForm(form),
        password: form.get("password"),
      }),
    });
    toast("Account created.");
    await showApp({ user: payload.user });
  } catch (error) {
    toast(error.message);
  }
}

async function logout() {
  await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => null);
  state.cart.clear();
  renderCart();
  showAuth();
}

function applyTheme(theme) {
  state.theme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = state.theme;
  const toggle = qs("#themeToggle");
  if (!toggle) return;
  const next = state.theme === "dark" ? "light" : "dark";
  toggle.setAttribute("aria-label", `Switch to ${next} mode`);
  toggle.title = `Switch to ${next} mode`;
}

async function toggleTheme() {
  if (!state.user && !state.admin) return;
  const nextTheme = state.theme === "dark" ? "light" : "dark";
  const previousTheme = state.theme;
  applyTheme(nextTheme);
  try {
    const payload = await api("/api/account/preferences", {
      method: "POST",
      body: JSON.stringify({ theme: nextTheme }),
    });
    if (payload.user) state.user = payload.user;
    if (payload.admin) state.admin = payload.admin;
    applyTheme(state.admin?.preferences?.theme || state.user?.preferences?.theme || nextTheme);
  } catch (error) {
    applyTheme(previousTheme);
    toast(error.message);
  }
}

function addressFromForm(form) {
  return {
    line1: form.get("line1"),
    line2: form.get("line2"),
    suburb: form.get("suburb"),
    city: form.get("city"),
    province: form.get("province"),
    postalCode: form.get("postalCode"),
    country: "South Africa",
  };
}

function fillDeliveryForm(address = {}) {
  const form = qs("#orderForm");
  for (const key of ["line1", "line2", "suburb", "city", "province", "postalCode"]) {
    if (form.elements[key]) form.elements[key].value = address?.[key] || "";
  }
}

function lockDeliveryFields(locked) {
  const form = qs("#orderForm");
  for (const key of ["line1", "line2", "suburb", "city", "postalCode"]) {
    if (form.elements[key]) form.elements[key].readOnly = locked;
  }
  if (form.elements.province) form.elements.province.disabled = locked;
}

function userAddresses() {
  return Array.isArray(state.user?.addresses) ? state.user.addresses : [];
}

function defaultUserAddress() {
  return userAddresses().find((address) => address.isDefault) || userAddresses()[0] || null;
}

function selectedCheckoutAddress() {
  return userAddresses().find((address) => address.id === state.selectedAddressId) || defaultUserAddress();
}

function addressLines(address = {}) {
  return [address.line1, address.line2, address.suburb, address.city, address.province, address.postalCode, address.country].filter(Boolean);
}

function addressLabel(address = {}) {
  const label = address.label || "Delivery address";
  const suburb = address.suburb ? ` - ${address.suburb}` : "";
  return `${label}${suburb}`;
}

function renderCheckoutAddresses() {
  const panel = qs("#checkoutAddressPanel");
  if (!panel || !state.user) return;
  const addresses = userAddresses();
  if (!state.selectedAddressId) state.selectedAddressId = defaultUserAddress()?.id || "";
  panel.innerHTML = `
    <div class="checkout-address-head">
      <label>Delivery address
        <select id="checkoutAddressSelect" name="addressId" ${addresses.length ? "" : "disabled"}>
          ${
            addresses.length
              ? addresses
                  .map(
                    (address) => `<option value="${escapeHtml(address.id)}" ${address.id === state.selectedAddressId ? "selected" : ""}>${escapeHtml(addressLabel(address))}</option>`,
                  )
                  .join("")
              : `<option value="">No saved addresses</option>`
          }
        </select>
      </label>
      <button id="addCheckoutAddress" class="secondary" type="button">Add address</button>
    </div>
  `;
}

async function loadCatalog() {
  qs("#products").innerHTML = `<p class="muted">Loading products...</p>`;
  try {
    const [payload, settingsPayload] = await Promise.all([api("/api/catalog"), loadShopSettings()]);
    state.products = payload.products || [];
    state.filters = payload.filters || deriveFilters(state.products);
    state.shopSettings = settingsPayload.settings || defaultShopSettings();
    state.brandCollections = buildBrandCollections(state.products);
    renderCatalogControls();
    renderFeaturedSlider();
    renderProducts();
  } catch (error) {
    qs("#products").innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
}

async function loadShopSettings() {
  try {
    return await api("/api/shop-settings");
  } catch {
    return { settings: defaultShopSettings() };
  }
}

function renderCatalogControls() {
  renderBrandCollections();
  updateFilterControls();
}

function renderBrandCollections() {
  const container = qs("#brandCollections");
  if (!container) return;
  container.innerHTML = state.brandCollections.length
    ? state.brandCollections
        .map(
          (brand) => `
            <button class="brand-tile" type="button" data-brand-filter="${escapeHtml(brand.vendor)}">
              <span class="brand-image">
                ${
                  brand.image
                    ? `<img src="${escapeHtml(brand.image)}" alt="${escapeHtml(brand.imageAlt || brand.vendor)}">`
                    : `<span>${escapeHtml(brand.initials)}</span>`
                }
              </span>
              <span class="brand-copy">
                <strong>${escapeHtml(brand.vendor)}</strong>
                <small>${brand.count} product${brand.count === 1 ? "" : "s"}</small>
              </span>
            </button>
          `,
        )
        .join("")
    : `<p class="muted small">No brands found.</p>`;
}

function renderProducts() {
  const container = qs("#products");
  const products = filteredProducts();
  updateFilterControls();
  renderCatalogSummary(products.length);
  if (!products.length) {
    renderProductPager("productsTopPager", 0);
    renderProductPager("productsBottomPager", 0);
    container.innerHTML = `<p class="muted">No products found.</p>`;
    return;
  }
  const totalPages = Math.max(1, Math.ceil(products.length / state.productsPerPage));
  state.productPage = Math.min(Math.max(1, state.productPage), totalPages);
  const start = (state.productPage - 1) * state.productsPerPage;
  const pageProducts = products.slice(start, start + state.productsPerPage);
  renderProductPager("productsTopPager", products.length);
  renderProductPager("productsBottomPager", products.length);
  container.innerHTML = pageProducts.map((product) => renderProductCard(product)).join("");
}

function renderProductCard(product, extraClass = "") {
  const variant = product.variant;
  const available = Boolean(variant?.inStock);
  const canAdd = available;
  const availabilityLabel = available ? "In stock" : "Out of stock";
  return `
    <article class="product ${escapeHtml(extraClass)}">
      <div class="product-image">
        ${
          product.image
            ? `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.imageAlt || product.title)}">`
            : `<div class="image-fallback">${escapeHtml(fallbackLabel(product))}</div>`
        }
      </div>
      <div class="product-image-divider" aria-hidden="true"></div>
      <div class="product-body">
        <p class="eyebrow">${escapeHtml(product.vendor)}</p>
        <h3>${escapeHtml(product.title)}</h3>
        <div class="product-facts">
          <span>${money.format(variant?.price || 0)}</span>
          <span class="availability ${available ? "in-stock" : "out-stock"}">${availabilityLabel}</span>
        </div>
        <div class="add-row">
          <label>Qty<input type="number" min="1" max="999" value="1" ${canAdd ? "" : "disabled"}></label>
          <button type="button" data-add-product="${product.id}" ${canAdd ? "" : "disabled"}>${available ? "Add" : "Out"}</button>
        </div>
      </div>
    </article>
  `;
}

function renderProductPager(targetId, totalProducts) {
  const pager = qs(`#${targetId}`);
  if (!pager) return;
  if (!totalProducts) {
    pager.innerHTML = "";
    return;
  }
  const totalPages = Math.max(1, Math.ceil(totalProducts / state.productsPerPage));
  const start = (state.productPage - 1) * state.productsPerPage + 1;
  const end = Math.min(totalProducts, state.productPage * state.productsPerPage);
  pager.innerHTML = `
    <span>Showing ${start}-${end} of ${totalProducts}</span>
    <div>
      <button type="button" data-page-action="prev" ${state.productPage <= 1 ? "disabled" : ""}>Prev</button>
      <strong>Page ${state.productPage} of ${totalPages}</strong>
      <button type="button" data-page-action="next" ${state.productPage >= totalPages ? "disabled" : ""}>Next</button>
    </div>
  `;
}

function renderFeaturedSlider() {
  const section = qs("#featuredSection");
  const slider = qs("#featuredSlider");
  if (!section || !slider) return;
  const settings = (state.shopSettings || defaultShopSettings()).featured;
  const products = featuredProducts(settings);
  section.hidden = products.length === 0;
  if (!products.length) {
    slider.innerHTML = "";
    return;
  }
  qs("#featuredTitle").textContent = settings.title || "Featured Dex";
  qs("#featuredSubtitle").textContent = settings.subtitle || "";
  slider.innerHTML = products.slice(0, 18).map((product) => renderProductCard(product, "featured-product")).join("");
}

function featuredProducts(settings) {
  if (!state.products.length) return [];
  if (settings?.mode === "custom" && settings.customProductIds?.length) {
    const order = new Map(settings.customProductIds.map((id, index) => [id, index]));
    return state.products
      .filter((product) => order.has(product.id))
      .sort((a, b) => order.get(a.id) - order.get(b.id));
  }
  const query = normalizeSearch(settings?.collectionQuery || "Dex");
  if (!query) return state.products.filter((product) => product.variant?.inStock).slice(0, 10);
  return state.products.filter((product) => searchableProductText(product).includes(query));
}

function filteredProducts() {
  const query = normalizeSearch(state.search);
  return state.products.filter((product) => {
    if (state.selectedBrand && normalizeSearch(product.vendor) !== normalizeSearch(state.selectedBrand)) return false;
    if (state.inStockOnly && !product.variant?.inStock) return false;
    if (state.selectedTypes.size && !matchesSelectedTypes(product)) return false;
    if (!query) return true;
    return searchableProductText(product).includes(query);
  });
}

function matchesSelectedTypes(product) {
  const text = searchableProductText(product);
  return [...state.selectedTypes].some((typeId) => {
    const type = productTypes.find((entry) => entry.id === typeId);
    return type?.tokens.some((token) => text.includes(normalizeSearch(token)));
  });
}

function setSelectedBrand(vendor) {
  state.selectedBrand = vendor || "";
  state.productPage = 1;
  renderProducts();
}

function updateFilterControls() {
  qsa("[data-brand-filter]").forEach((button) => {
    button.classList.toggle("is-active", normalizeSearch(button.dataset.brandFilter) === normalizeSearch(state.selectedBrand));
  });
  qs("#clearBrandFilter")?.classList.toggle("is-active", !state.selectedBrand);
  qsa("[data-type-filter]").forEach((input) => {
    input.checked = state.selectedTypes.has(input.dataset.typeFilter);
  });
  const inStockFilter = qs("#inStockFilter");
  if (inStockFilter) inStockFilter.checked = state.inStockOnly;
}

function renderCatalogSummary(count) {
  const parts = [state.selectedBrand || "All brands"];
  if (state.selectedTypes.size) parts.push([...state.selectedTypes].map(typeLabel).join(", "));
  if (state.inStockOnly) parts.push("In stock");
  if (state.search) parts.push(`matching "${state.search}"`);
  qs("#catalogSummary").innerHTML = `<span>${escapeHtml(parts.join(" - "))} - ${count} product${count === 1 ? "" : "s"}</span>`;
}

async function addToCart(productId, card) {
  const product = state.products.find((entry) => entry.id === productId);
  const variant = product?.variant;
  if (!product || !variant) return;
  if (!variant.inStock) return toast("Use Special order for out-of-stock or larger requests.");
  const requested = Math.max(1, Number(qs('input[type="number"]', card).value || 1));
  const quantity = Math.min(requested, 999);
  const existing = state.cart.get(variant.id);
  const nextItem = {
    variantId: variant.id,
    productTitle: product.title,
    variantTitle: variant.title,
    sku: variant.sku,
    price: Number(variant.price),
    quantity: (existing?.quantity || 0) + quantity,
  };
  const nextCart = new Map(state.cart);
  nextCart.set(variant.id, nextItem);
  try {
    await checkCart([...nextCart.values()], false);
  } catch (error) {
    toast(error.message);
    return;
  }
  state.cart = nextCart;
  renderCart();
  toast("Added to cart.");
}

async function checkCart(items, specialOrder) {
  return api("/api/cart/check", {
    method: "POST",
    body: JSON.stringify({ items, specialOrder }),
  });
}

function renderCart() {
  renderCheckoutAddresses();
  const items = [...state.cart.values()];
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  qs("#cartCount").textContent = `${totalQuantity} item${totalQuantity === 1 ? "" : "s"}`;
  qs("#cartTotal").textContent = money.format(total);
  const bubble = qs("#cartBubble");
  if (bubble) {
    bubble.textContent = totalQuantity > 99 ? "99+" : String(totalQuantity);
    bubble.hidden = totalQuantity === 0;
  }
  const container = qs("#cartItems");
  if (!items.length) {
    container.className = "cart-items empty";
    container.textContent = "No products selected.";
    return;
  }
  container.className = "cart-items";
  container.innerHTML = items
    .map(
      (item) => `
        <div class="cart-line">
          <div>
            <strong>${escapeHtml(item.productTitle)}</strong>
            <span>${item.quantity} x ${money.format(item.price)}</span>
          </div>
          <button type="button" data-remove="${escapeHtml(item.variantId)}" aria-label="Remove ${escapeHtml(item.productTitle)}">x</button>
        </div>
      `,
    )
    .join("");
}

async function submitOrder(event) {
  event.preventDefault();
  const items = [...state.cart.values()];
  if (!items.length) return toast("Add at least one product first.");
  const selectedAddress = selectedCheckoutAddress();
  if (!selectedAddress) return toast("Add a delivery address first.");
  const form = new FormData(event.target);
  state.pendingOrderDraft = {
    kind: "standard",
    delivery: {
      addressId: form.get("addressId") || selectedAddress.id,
      address: selectedAddress,
      notes: form.get("notes"),
      method: "Courier",
    },
    items,
    specialOrder: false,
  };
  openOrderSummaryModal(state.pendingOrderDraft);
}

async function confirmPendingOrder() {
  const draft = state.pendingOrderDraft;
  if (!draft) return;
  try {
    const payload = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        delivery: draft.delivery,
        items: draft.items,
        specialOrder: Boolean(draft.specialOrder),
        specialOrderNote: draft.specialOrderNote || "",
      }),
    });
    if (!draft.specialOrder) state.cart.clear();
    state.pendingOrderDraft = null;
    state.banking = payload.banking || state.banking;
    renderCart();
    await loadCustomerOrders();
    if (payload.order.canUploadProof) showPaymentModal(payload.order);
    else showOrderSubmittedModal(payload.order);
  } catch (error) {
    toast(error.message);
  }
}

function openOrderSummaryModal(draft) {
  const modal = qs("#orderFlowModal");
  const title = draft.specialOrder ? "Special order summary" : "Order summary";
  qs("#orderFlowTitle").textContent = title;
  qs("#orderFlowContent").innerHTML = `
    <div class="summary-stack">
      <section class="summary-panel">
        <p class="eyebrow">Products</p>
        <ul class="summary-lines">${draft.items.map((item) => `<li><span>${escapeHtml(item.productTitle)}</span><strong>${item.quantity} x ${money.format(item.price)}</strong></li>`).join("")}</ul>
      </section>
      <section class="summary-panel">
        <p class="eyebrow">Delivery address</p>
        ${renderAddressBlock(draft.delivery.address)}
      </section>
      ${draft.specialOrderNote ? `<section class="summary-panel"><p class="eyebrow">Request note</p><p>${escapeHtml(draft.specialOrderNote)}</p></section>` : ""}
      <div class="summary-total"><span>Total</span><strong>${money.format(orderDraftTotal(draft))}</strong></div>
    </div>
  `;
  qs("#orderFlowActions").innerHTML = `
    <button class="secondary" type="button" data-close-order-flow>Cancel</button>
    <button class="primary" type="button" data-confirm-order>${draft.specialOrder ? "Submit special order" : "Confirm order"}</button>
  `;
  modal.hidden = false;
}

function showPaymentModal(order) {
  state.activePaymentOrder = order;
  const paymentUnlocked = order.canUploadProof || order.proof || order.paymentStatus === "confirmed";
  qs("#orderFlowTitle").textContent = `${paymentUnlocked ? "Payment details" : "Order details"} - ${order.reference}`;
  qs("#orderFlowContent").innerHTML = `
    <div class="summary-stack">
      <section class="summary-panel">
        <p class="eyebrow">Order</p>
        <ul class="summary-lines">${order.items.map((item) => `<li><span>${escapeHtml(item.productTitle)}</span><strong>${item.quantity}</strong></li>`).join("")}</ul>
        <div class="summary-total compact"><span>Total</span><strong>${money.format(order.total)}</strong></div>
      </section>
      ${
        paymentUnlocked
          ? `${paymentInstructions(order)}${order.proof ? `<p class="muted">POP uploaded: ${escapeHtml(order.proof.filename)}</p>` : order.canUploadProof ? proofForm(order.id) : `<p class="muted">${escapeHtml(order.customerStatus)}</p>`}`
          : `<section class="summary-panel"><p class="eyebrow">Status</p><h3>${escapeHtml(order.customerStatus)}</h3>${order.specialOrder ? renderSpecialOrderStatus(order.specialOrder) : ""}</section>`
      }
    </div>
  `;
  qs("#orderFlowActions").innerHTML = `<button class="primary" type="button" data-close-order-flow>Done</button>`;
  qs("#orderFlowModal").hidden = false;
}

function showTrackingModal(order) {
  const tracking = order.tracking || {};
  qs("#orderFlowTitle").textContent = `Track order - ${order.reference}`;
  qs("#orderFlowContent").innerHTML = `
    <div class="summary-stack">
      <section class="summary-panel">
        <p class="eyebrow">Shipment</p>
        <h3>${escapeHtml(tracking.courier || "Courier")}</h3>
        <p><strong>Tracking Number:</strong> ${escapeHtml(tracking.number || "Not supplied")}</p>
      </section>
    </div>
  `;
  qs("#orderFlowActions").innerHTML = `
    <button class="secondary" type="button" data-close-order-flow>Close</button>
    ${tracking.url ? `<a class="primary button-link" href="${escapeHtml(tracking.url)}" target="_blank" rel="noopener">Track shipment</a>` : ""}
  `;
  qs("#orderFlowModal").hidden = false;
}

function showOrderSubmittedModal(order) {
  state.activePaymentOrder = order;
  qs("#orderFlowTitle").textContent = `${order.specialOrder ? "Special order" : "Order"} submitted`;
  qs("#orderFlowContent").innerHTML = `
    <div class="summary-stack">
      <section class="summary-panel">
        <p class="eyebrow">Reference</p>
        <h3>${escapeHtml(order.reference)}</h3>
        <p class="muted">${escapeHtml(order.customerStatus)}</p>
      </section>
      <p class="muted">${order.specialOrder ? "We will review this request and unlock payment details if it is approved or countered." : "Your order has been submitted."}</p>
    </div>
  `;
  qs("#orderFlowActions").innerHTML = `<button class="primary" type="button" data-close-order-flow>Done</button>`;
  qs("#orderFlowModal").hidden = false;
}

function closeOrderFlowModal() {
  state.pendingOrderDraft = null;
  state.activePaymentOrder = null;
  qs("#orderFlowModal").hidden = true;
}

function orderDraftTotal(draft) {
  return draft.items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
}

function renderAddressBlock(address) {
  return `<address class="summary-address">${addressLines(address).map((line) => `<span>${escapeHtml(line)}</span>`).join("")}</address>`;
}

function openSpecialOrderModal() {
  const form = qs("#specialOrderForm");
  form.reset();
  renderSpecialProductOptions();
  renderSpecialAddressOptions();
  qs("#specialOrderModal").hidden = false;
}

function closeSpecialOrderModal() {
  qs("#specialOrderModal").hidden = true;
}

function renderSpecialProductOptions() {
  const select = qs("#specialProductSelect");
  if (!select) return;
  select.innerHTML = state.products.length
    ? state.products
        .map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.vendor ? `${product.vendor} - ${product.title}` : product.title)}</option>`)
        .join("")
    : `<option value="">Load products from Shop first</option>`;
}

function renderSpecialAddressOptions() {
  const select = qs("#specialAddressSelect");
  if (!select) return;
  const addresses = userAddresses();
  select.innerHTML = addresses.length
    ? addresses.map((address) => `<option value="${escapeHtml(address.id)}" ${address.id === state.selectedAddressId ? "selected" : ""}>${escapeHtml(addressLabel(address))}</option>`).join("")
    : `<option value="">No saved addresses</option>`;
}

async function submitSpecialOrder(event) {
  event.preventDefault();
  const form = event.target;
  const product = state.products.find((entry) => entry.id === form.productId.value);
  const address = userAddresses().find((entry) => entry.id === form.addressId.value);
  const quantity = Math.max(1, Math.floor(Number(form.quantity.value || 1)));
  if (!product?.variant) return toast("Choose a product.");
  if (!address) return toast("Choose or add a delivery address.");
  state.pendingOrderDraft = {
    kind: "special",
    delivery: {
      addressId: address.id,
      address,
      notes: form.deliveryNotes.value,
      method: "Courier",
    },
    items: [
      {
        variantId: product.variant.id,
        productTitle: product.title,
        variantTitle: product.variant.title,
        sku: product.variant.sku,
        price: Number(product.variant.price),
        quantity,
      },
    ],
    specialOrder: true,
    specialOrderNote: form.specialOrderNote.value,
  };
  closeSpecialOrderModal();
  openOrderSummaryModal(state.pendingOrderDraft);
}

function renderAccount() {
  const container = qs("#accountDetails");
  if (!container || !state.user) return;
  const addresses = userAddresses();
  container.innerHTML = `
    <section class="account-summary profile-summary">
      <div>
        <p class="eyebrow">Profile</p>
        <h3>${escapeHtml(state.user.name)}</h3>
      </div>
      <dl>
        <div><dt>Username</dt><dd>${escapeHtml(state.user.username)}</dd></div>
        <div><dt>Email</dt><dd>${escapeHtml(state.user.email)}</dd></div>
        <div><dt>Phone</dt><dd>${escapeHtml(state.user.phone || `${state.user.phoneArea || ""} ${state.user.phoneNumber || ""}`.trim())}</dd></div>
      </dl>
    </section>
    <section class="account-summary">
      <div class="account-section-head">
        <div>
          <p class="eyebrow">Delivery</p>
          <h3>Saved addresses</h3>
        </div>
        <button id="addAccountAddress" class="secondary" type="button">Add address</button>
      </div>
      <div class="saved-address-list">
        ${
          addresses.length
            ? addresses.map(renderSavedAddress).join("")
            : `<p class="muted">No delivery addresses saved yet.</p>`
        }
      </div>
    </section>
  `;
}

function renderSavedAddress(address) {
  const canRemove = userAddresses().length > 1;
  return `
    <article class="saved-address-card">
      <div>
        <strong>${escapeHtml(address.label || "Delivery address")}${address.isDefault ? ` <span>Default</span>` : ""}</strong>
        <address>${addressLines(address).map((line) => `<em>${escapeHtml(line)}</em>`).join("")}</address>
      </div>
      <div class="address-card-actions">
        ${address.isDefault ? "" : `<button class="secondary" type="button" data-default-address="${escapeHtml(address.id)}">Make default</button>`}
        <button type="button" data-edit-address="${escapeHtml(address.id)}">Edit</button>
        ${canRemove ? `<button class="danger-button" type="button" data-remove-address="${escapeHtml(address.id)}">Remove</button>` : ""}
      </div>
    </article>
  `;
}

function openAddressModal(source = "account", addressId = "") {
  const address = addressId ? userAddresses().find((entry) => entry.id === addressId) : null;
  state.editingAddressId = address?.id || "";
  state.addressModalSource = source;
  const form = qs("#addressForm");
  form.reset();
  qs("#addressModalTitle").textContent = address ? "Edit delivery address" : "Add delivery address";
  form.elements.label.value = address?.label || (userAddresses().length ? "" : "Main address");
  form.elements.line1.value = address?.line1 || "";
  form.elements.line2.value = address?.line2 || "";
  form.elements.suburb.value = address?.suburb || "";
  form.elements.city.value = address?.city || "";
  form.elements.province.value = address?.province || "";
  form.elements.postalCode.value = address?.postalCode || "";
  form.elements.isDefault.checked = Boolean(address?.isDefault || !userAddresses().length);
  qs("#addressModal").hidden = false;
  form.elements.label.focus();
}

function closeAddressModal() {
  state.editingAddressId = null;
  qs("#addressModal").hidden = true;
}

async function submitAddressForm(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const body = {
    label: formData.get("label"),
    ...addressFromForm(formData),
    isDefault: Boolean(formData.get("isDefault")),
  };
  const editingId = state.editingAddressId;
  try {
    const payload = await api(editingId ? `/api/account/addresses/${encodeURIComponent(editingId)}` : "/api/account/addresses", {
      method: editingId ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    state.user = payload.user;
    state.selectedAddressId = payload.address?.id || defaultUserAddress()?.id || "";
    renderAccount();
    renderCheckoutAddresses();
    renderSpecialAddressOptions();
    closeAddressModal();
    toast(editingId ? "Address updated." : "Address added.");
  } catch (error) {
    toast(error.message);
  }
}

async function setDefaultAddress(addressId) {
  try {
    const payload = await api(`/api/account/addresses/${encodeURIComponent(addressId)}/default`, {
      method: "POST",
      body: "{}",
    });
    state.user = payload.user;
    state.selectedAddressId = payload.address?.id || defaultUserAddress()?.id || "";
    renderAccount();
    renderCheckoutAddresses();
    toast("Default address updated.");
  } catch (error) {
    toast(error.message);
  }
}

function openRemoveAddressModal(addressId) {
  const address = userAddresses().find((entry) => entry.id === addressId);
  if (!address) return;
  state.pendingAddressRemoval = address;
  qs("#removeAddressText").textContent = `Remove ${address.label || "this delivery address"}? You must keep at least one valid saved delivery address.`;
  qs("#confirmAddressRemove").hidden = false;
}

function closeRemoveAddressModal() {
  state.pendingAddressRemoval = null;
  qs("#confirmAddressRemove").hidden = true;
}

async function confirmRemoveAddress(event) {
  event.preventDefault();
  const address = state.pendingAddressRemoval;
  if (!address) return;
  try {
    const payload = await api(`/api/account/addresses/${encodeURIComponent(address.id)}`, {
      method: "DELETE",
      body: "{}",
    });
    state.user = payload.user;
    state.selectedAddressId = defaultUserAddress()?.id || "";
    renderAccount();
    renderCheckoutAddresses();
    renderSpecialAddressOptions();
    closeRemoveAddressModal();
    toast("Address removed.");
  } catch (error) {
    toast(error.message);
  }
}

async function loadCustomerOrders() {
  const container = qs("#statusOrders");
  container.innerHTML = `<p class="muted">Loading orders...</p>`;
  try {
    const payload = await api("/api/orders");
    state.banking = payload.banking || state.banking;
    state.customerOrders = payload.orders || [];
    container.innerHTML = state.customerOrders.length ? state.customerOrders.map(renderCustomerOrder).join("") : `<p class="muted">No orders yet.</p>`;
  } catch (error) {
    container.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
}

function renderCustomerOrder(order) {
  const proof = order.proof ? `<p class="muted">POP uploaded: ${escapeHtml(order.proof.filename)}</p>` : "";
  const tracking = order.tracking?.number
    ? `<p><strong>Tracking Number:</strong> ${escapeHtml(order.tracking.number)}</p>`
    : "";
  const trackButton = order.fulfillmentStatus === "shipped" && order.tracking?.number
    ? `<button type="button" data-view-order-tracking="${escapeHtml(order.id)}">Track Order</button>`
    : "";
  const special = order.specialOrder ? renderSpecialOrderStatus(order.specialOrder) : "";
  return `
    <article class="order-card" data-order-id="${order.id}">
      <header>
        <div>
          <strong>${escapeHtml(order.reference)}</strong>
          <p class="muted">${new Date(order.createdAt).toLocaleString()}</p>
        </div>
        <span class="status-badge">${escapeHtml(order.customerStatus)}</span>
      </header>
      <ul>${order.items.map((item) => `<li>${item.quantity} x ${escapeHtml(item.productTitle)}</li>`).join("")}</ul>
      <p><strong>Total:</strong> ${money.format(order.total)}</p>
      ${special}
      ${tracking}
      ${proof}
      <div class="order-actions">
        <button type="button" data-view-order-payment="${escapeHtml(order.id)}">${order.canUploadProof ? "Payment details" : "View order"}</button>
        ${trackButton}
      </div>
    </article>
  `;
}

function renderSpecialOrderStatus(specialOrder) {
  const labels = {
    pending: "Awaiting review",
    accepted: "Approved",
    declined: "Declined",
    countered: "Countered",
  };
  const note = specialOrder.counterNote || specialOrder.declineReason || specialOrder.note || "";
  return `
    <div class="special-status">
      <strong>Special order: ${escapeHtml(labels[specialOrder.status] || specialOrder.status)}</strong>
      ${note ? `<span>${escapeHtml(note)}</span>` : ""}
    </div>
  `;
}

function paymentInstructions(order) {
  const banking = state.banking || {};
  const confirmed = order.paymentStatus === "confirmed";
  const bankLines = [
    banking.accountName && `<span>Account: ${escapeHtml(banking.accountName)}</span>`,
    banking.bankName && `<span>Bank: ${escapeHtml(banking.bankName)}</span>`,
    banking.accountNumber && `<span>Number: ${escapeHtml(banking.accountNumber)}</span>`,
    banking.branchCode && `<span>Branch: ${escapeHtml(banking.branchCode)}</span>`,
  ].filter(Boolean);
  return `
    <div class="payment-box${confirmed ? " is-confirmed" : ""}">
      <strong>EFT reference: ${escapeHtml(order.reference)}</strong>
      <span>Amount: ${money.format(order.total)}</span>
      ${bankLines.length ? bankLines.join("") : `<span>Banking details will be supplied before production testing.</span>`}
      ${banking.note ? `<span>${escapeHtml(banking.note)}</span>` : ""}
    </div>
  `;
}

function proofForm(orderId) {
  return `
    <form class="proof-form" data-proof-order="${orderId}">
      <label>Proof of payment<input name="proof" type="file" accept="image/*,.pdf"></label>
      <label>Payment note<input name="note" placeholder="Bank reference or payment note"></label>
      <button type="submit">Upload POP</button>
    </form>
  `;
}

async function uploadProof(event) {
  event.preventDefault();
  const form = event.target;
  const file = form.proof.files[0];
  if (!file) return toast("Choose a POP file.");
  const dataUrl = await fileToDataUrl(file);
  try {
    await api(`/api/orders/${encodeURIComponent(form.dataset.proofOrder)}/proof`, {
      method: "POST",
      body: JSON.stringify({ filename: file.name, dataUrl, note: form.note.value }),
    });
    toast("POP uploaded.");
    await loadCustomerOrders();
    const updated = state.customerOrders.find((order) => order.id === form.dataset.proofOrder);
    if (updated) showPaymentModal(updated);
  } catch (error) {
    toast(error.message);
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

async function loadAdminOrders() {
  const container = qs("#adminOrders");
  container.innerHTML = `<p class="muted">Loading orders...</p>`;
  try {
    const payload = await api("/api/admin/orders");
    state.adminOrders = payload.orders || [];
    renderAdminOrders();
  } catch (error) {
    container.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
}

function renderAdminOrders() {
  qsa("[data-admin-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.adminView === state.adminView));
  if (state.adminView === "shop-settings") {
    renderAdminShopSettings();
    return;
  }
  if (state.adminView === "accounts") {
    renderAdminAccounts();
    return;
  }
  if (state.adminView === "system-status") {
    renderSystemStatus();
    return;
  }
  const orders = state.adminOrders.filter((order) => adminOrderView(order) === state.adminView);
  const labels = {
    pending: "Awaiting confirmation",
    ready: "Ready to pack",
    completed: "Completed",
  };
  qs("#adminOrdersSummary").innerHTML = `<span>${labels[state.adminView]} - ${orders.length} order${orders.length === 1 ? "" : "s"}</span>`;
  qs("#adminOrders").innerHTML = orders.length ? orders.map(renderAdminOrder).join("") : `<p class="muted">${emptyAdminMessage(state.adminView)}</p>`;
}

function adminOrderView(order) {
  if (order.fulfillmentStatus === "shipped") return "completed";
  if (order.specialOrder?.status === "declined") return "completed";
  if (order.paymentStatus === "confirmed" && order.fulfillmentStatus === "not_ready") return "ready";
  return "pending";
}

function emptyAdminMessage(view) {
  if (view === "ready") return "No paid orders are ready to pack.";
  if (view === "completed") return "No completed orders yet.";
  return "No orders are waiting for payment confirmation.";
}

async function loadAdminShopSettings() {
  qs("#adminOrdersSummary").innerHTML = `<span>Shop settings</span>`;
  qs("#adminOrders").innerHTML = `<p class="muted">Loading shop settings...</p>`;
  try {
    const [settingsPayload, catalogPayload] = await Promise.all([loadShopSettings(), api("/api/catalog")]);
    state.shopSettings = settingsPayload.settings || defaultShopSettings();
    state.products = catalogPayload.products || state.products;
    renderAdminShopSettings();
  } catch (error) {
    qs("#adminOrders").innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
}

async function loadAdminAccounts() {
  qs("#adminOrdersSummary").innerHTML = `<span>Accounts</span>`;
  qs("#adminOrders").innerHTML = `<p class="muted">Loading accounts...</p>`;
  try {
    const payload = await api("/api/admin/accounts");
    state.adminAccounts = payload.accounts || [];
    renderAdminAccounts();
  } catch (error) {
    qs("#adminOrders").innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
}

function renderAdminAccounts() {
  qsa("[data-admin-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.adminView === state.adminView));
  const accounts = state.adminAccounts || [];
  const visible = accounts.filter((account) => state.adminAccountFilter === "all" || account.role === state.adminAccountFilter);
  const counts = {
    all: accounts.length,
    admin: accounts.filter((account) => account.role === "admin").length,
    customer: accounts.filter((account) => account.role !== "admin").length,
  };
  qs("#adminOrdersSummary").innerHTML = `<span>Accounts - ${visible.length}${visible.length === accounts.length ? "" : ` of ${accounts.length}`}</span>`;
  qs("#adminOrders").innerHTML = `
    <section class="admin-account-shell">
      <div class="account-filter-bar" aria-label="Account filters">
        ${["all", "customer", "admin"]
          .map(
            (role) => `
              <button class="account-filter${state.adminAccountFilter === role ? " is-active" : ""}" type="button" data-account-filter="${role}">
                ${role === "all" ? "All" : role === "admin" ? "Admins" : "Customers"}
                <span>${counts[role]}</span>
              </button>
            `,
          )
          .join("")}
        <button id="openAdminAccountModal" class="primary slim-action" type="button">Create account</button>
      </div>

      <div class="account-admin-list">
        ${
          visible.length
            ? visible.map(renderAdminAccount).join("")
            : `<p class="muted">No accounts match this filter.</p>`
        }
      </div>
    </section>
  `;
}

function renderAdminAccount(account) {
  const address = account.defaultAddress || {};
  const addressText = [address.line1, address.line2, address.suburb, address.city, address.province, address.postalCode].filter(Boolean).join(", ");
  const isCurrentAdmin = account.id && state.admin?.id === account.id;
  return `
    <article class="account-admin-card">
      <div>
        <strong>${escapeHtml(account.name || account.username)}</strong>
        <p class="muted">${escapeHtml(account.username)} - ${escapeHtml(account.email || "")}</p>
        ${account.role === "customer" ? `<p class="muted">${escapeHtml(account.phone || "No phone")} ${addressText ? `- ${escapeHtml(addressText)}` : ""}</p>` : ""}
      </div>
      <div class="account-admin-actions">
        <span class="role-badge ${escapeHtml(account.role)}">${account.role === "admin" ? "Admin" : "Customer"}</span>
        ${account.role === "admin" ? `<button type="button" data-edit-admin-account="${escapeHtml(account.id)}">Edit</button>` : ""}
        <button class="danger-button" type="button" data-remove-account="${escapeHtml(account.id)}" ${isCurrentAdmin ? "disabled" : ""}>Remove</button>
      </div>
    </article>
  `;
}

async function submitAdminAccount(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const editingId = state.editingAdminAccountId;
  const role = editingId ? "admin" : formData.get("role");
  try {
    const payload = await api(editingId ? `/api/admin/accounts/${encodeURIComponent(editingId)}` : "/api/admin/accounts", {
      method: editingId ? "PUT" : "POST",
      body: JSON.stringify({
        role,
        username: formData.get("username"),
        name: formData.get("name"),
        email: formData.get("email"),
        password: formData.get("password"),
        phoneArea: formData.get("phoneArea"),
        phoneNumber: formData.get("phoneNumber"),
        defaultAddress: addressFromForm(formData),
      }),
    });
    if (payload.admin) state.admin = payload.admin;
    if (payload.admin) qs("#accountName").textContent = payload.admin.name || payload.admin.username || "Admin";
    form.reset();
    closeAdminAccountModal();
    toast(editingId ? "Admin account updated." : "Account created.");
    await loadAdminAccounts();
  } catch (error) {
    toast(error.message);
  }
}

function openAdminAccountModal(accountId = "") {
  const form = qs("#adminAccountForm");
  const account = accountId ? state.adminAccounts.find((entry) => entry.id === accountId) : null;
  state.editingAdminAccountId = account?.id || "";
  form.reset();
  qs("#adminAccountTitle").textContent = account ? "Edit admin account" : "Create account";
  form.elements.role.value = account?.role || "customer";
  form.elements.role.disabled = Boolean(account);
  form.elements.username.value = account?.username || "";
  form.elements.name.value = account?.name || "";
  form.elements.email.value = account?.email && !String(account.email).endsWith("@admin.local") ? account.email : "";
  form.elements.password.required = !account;
  form.elements.password.placeholder = account ? "Leave blank to keep current password" : "";
  toggleAdminAccountFields();
  qs("#adminAccountModal").hidden = false;
  form.elements.username.focus();
}

function closeAdminAccountModal() {
  state.editingAdminAccountId = "";
  const form = qs("#adminAccountForm");
  if (form) {
    form.elements.role.disabled = false;
    form.elements.password.required = true;
  }
  qs("#adminAccountModal").hidden = true;
}

function toggleAdminAccountFields() {
  const form = qs("#adminAccountForm");
  if (!form) return;
  const isAdmin = form.elements.role.value === "admin" || Boolean(state.editingAdminAccountId);
  qsa("[data-admin-customer-field]", form).forEach((field) => {
    field.hidden = isAdmin;
    qsa("input, select, textarea", field).forEach((input) => {
      input.required = !isAdmin && ["email", "phoneNumber", "line1", "suburb", "city", "province", "postalCode"].includes(input.name);
    });
  });
}

function openRemoveAccountModal(accountId) {
  const account = state.adminAccounts.find((entry) => entry.id === accountId);
  if (!account) return;
  state.pendingAccountRemoval = account;
  qs("#removeAccountText").textContent = `Remove ${account.name || account.username}? This prevents future login but keeps existing order history intact.`;
  qs("#removeAccountPassword").value = "";
  qs("#confirmAccountRemove").hidden = false;
  qs("#removeAccountPassword").focus();
}

function closeRemoveAccountModal() {
  state.pendingAccountRemoval = null;
  qs("#confirmAccountRemove").hidden = true;
}

async function submitRemoveAccount(event) {
  event.preventDefault();
  const account = state.pendingAccountRemoval;
  if (!account) return;
  const form = event.target;
  try {
    await api(`/api/admin/accounts/${encodeURIComponent(account.id)}`, {
      method: "DELETE",
      body: JSON.stringify({ password: form.password.value }),
    });
    toast("Account removed.");
    closeRemoveAccountModal();
    await loadAdminAccounts();
  } catch (error) {
    toast(error.message);
  }
}

async function loadSystemStatus() {
  qs("#adminOrdersSummary").innerHTML = `<span>System status</span>`;
  qs("#adminOrders").innerHTML = `<p class="muted">Checking systems...</p>`;
  try {
    const payload = await api("/api/admin/system-status");
    state.systemStatus = payload;
    renderSystemStatus();
  } catch (error) {
    qs("#adminOrders").innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
}

function renderSystemStatus() {
  qsa("[data-admin-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.adminView === state.adminView));
  const payload = state.systemStatus || { systems: [] };
  qs("#adminOrdersSummary").innerHTML = `<span>System status${payload.checkedAt ? ` - checked ${new Date(payload.checkedAt).toLocaleString()}` : ""}</span>`;
  qs("#adminOrders").innerHTML = `
    <section class="system-status-grid">
      ${
        payload.systems?.length
          ? payload.systems.map(renderStatusCard).join("")
          : `<p class="muted">No system checks have run yet.</p>`
      }
    </section>
  `;
}

function renderStatusCard(system) {
  return `
    <article class="system-status-card ${escapeHtml(system.state)}">
      <div class="system-status-topline">
        <strong>${escapeHtml(system.label)}</strong>
        <span>${escapeHtml(statusLabel(system.state))}</span>
      </div>
      <p class="muted">${escapeHtml(system.detail || "")}</p>
    </article>
  `;
}

function statusLabel(status) {
  if (status === "online") return "Online";
  if (status === "error") return "Error";
  return "Offline";
}

function renderAdminShopSettings() {
  qsa("[data-admin-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.adminView === state.adminView));
  const allSettings = state.shopSettings || defaultShopSettings();
  const settings = allSettings.featured;
  const payment = allSettings.payment || defaultShopSettings().payment;
  const references = allSettings.references || defaultShopSettings().references;
  const selected = new Set(settings.customProductIds || []);
  const productSearch = normalizeSearch(state.adminProductSearch);
  const customProducts = state.products
    .filter((product) => !productSearch || searchableProductText(product).includes(productSearch))
    .slice(0, 80);
  qs("#adminOrdersSummary").innerHTML = `<span>Shop settings</span>`;
  qs("#adminOrders").innerHTML = `
    <form class="shop-settings-form" data-mode="${escapeHtml(settings.mode || "collection")}">
      <details class="settings-accordion">
        <summary><span>Slider</span><small>Featured collection and product selection</small></summary>
        <section class="settings-grid">
          <label>Slider title
            <input name="title" maxlength="80" value="${escapeHtml(settings.title || "Featured Dex")}" required>
          </label>
          <label>Collection/tag query
            <input name="collectionQuery" maxlength="80" value="${escapeHtml(settings.collectionQuery || "Dex")}" placeholder="Dex">
          </label>
          <label class="wide">Slider subtitle
            <input name="subtitle" maxlength="180" value="${escapeHtml(settings.subtitle || "")}">
          </label>
        </section>
        <section class="settings-mode">
          <label class="check-option"><input type="radio" name="mode" value="collection" ${settings.mode !== "custom" ? "checked" : ""}> Featured collection / tag</label>
          <label class="check-option"><input type="radio" name="mode" value="custom" ${settings.mode === "custom" ? "checked" : ""}> Custom product selection</label>
        </section>
        <section class="custom-pick-panel">
          <div class="section-heading compact-heading">
            <div>
              <h3>Custom products</h3>
              <p class="muted small">Used only when custom product selection is active.</p>
            </div>
          </div>
          <label>Search product list
            <input id="adminProductPickSearch" type="search" value="${escapeHtml(state.adminProductSearch)}" placeholder="Search titles, tags, SKU or brand">
          </label>
          <div class="product-pick-list">
            ${
              customProducts.length
                ? customProducts
                    .map(
                      (product) => `
                        <label class="product-pick">
                          <input type="checkbox" name="customProductIds" value="${escapeHtml(product.id)}" ${selected.has(product.id) ? "checked" : ""}>
                          <span>${product.image ? `<img src="${escapeHtml(product.image)}" alt="">` : `<strong>${escapeHtml(fallbackLabel(product))}</strong>`}</span>
                          <em>${escapeHtml(product.title)}</em>
                          <small>${escapeHtml(product.vendor)} - ${product.variant?.inStock ? "In stock" : "Out of stock"}</small>
                        </label>
                      `,
                    )
                    .join("")
                : `<p class="muted">No products match that search.</p>`
            }
          </div>
        </section>
      </details>
      <details class="settings-accordion">
        <summary><span>Payments</span><small>EFT details and customer note</small></summary>
        <section class="settings-grid">
          <label>Account name
            <input name="paymentAccountName" maxlength="120" value="${escapeHtml(payment.accountName || "")}">
          </label>
          <label>Bank name
            <input name="paymentBankName" maxlength="120" value="${escapeHtml(payment.bankName || "")}">
          </label>
          <label>Account number
            <input name="paymentAccountNumber" maxlength="80" value="${escapeHtml(payment.accountNumber || "")}">
          </label>
          <label>Branch code
            <input name="paymentBranchCode" maxlength="80" value="${escapeHtml(payment.branchCode || "")}">
          </label>
          <label class="wide">Payment note
            <textarea name="paymentNote" rows="3" maxlength="500">${escapeHtml(payment.note || "")}</textarea>
          </label>
        </section>
      </details>
      <details class="settings-accordion">
        <summary><span>References</span><small>Standard and special order formats</small></summary>
        <section class="settings-grid">
          <label>Standard order format
            <input name="standardFormat" maxlength="80" value="${escapeHtml(references.standardFormat || "OP-{YYYY}{MM}{DD}-{RAND4}")}">
          </label>
          <label>Special order format
            <input name="specialFormat" maxlength="80" value="${escapeHtml(references.specialFormat || "SO-{YYYY}{MM}{DD}-{RAND4}")}">
          </label>
          <p class="muted small wide">Available tokens: {YYYY}, {YY}, {MM}, {DD}, {DATE}, {RAND4}</p>
        </section>
      </details>
      <div class="settings-actions">
        <button class="primary" type="submit">Save shop settings</button>
      </div>
    </form>
  `;
}

function syncDraftCustomSelections() {
  const form = qs(".shop-settings-form");
  if (!form || !state.shopSettings?.featured) return;
  const current = new Set(state.shopSettings.featured.customProductIds || []);
  qsa('input[name="customProductIds"]', form).forEach((input) => {
    if (input.checked) current.add(input.value);
    else current.delete(input.value);
  });
  state.shopSettings.featured.customProductIds = [...current];
}

async function submitShopSettings(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  syncDraftCustomSelections();
  try {
    const payload = await api("/api/admin/shop-settings", {
      method: "POST",
      body: JSON.stringify({
        featured: {
          mode: formData.get("mode"),
          title: formData.get("title"),
          subtitle: formData.get("subtitle"),
          collectionQuery: formData.get("collectionQuery"),
          customProductIds: state.shopSettings?.featured?.customProductIds || formData.getAll("customProductIds"),
        },
        payment: {
          accountName: formData.get("paymentAccountName"),
          bankName: formData.get("paymentBankName"),
          accountNumber: formData.get("paymentAccountNumber"),
          branchCode: formData.get("paymentBranchCode"),
          note: formData.get("paymentNote"),
        },
        references: {
          standardFormat: formData.get("standardFormat"),
          specialFormat: formData.get("specialFormat"),
        },
      }),
    });
    state.shopSettings = payload.settings;
    toast("Shop settings saved.");
    renderAdminShopSettings();
  } catch (error) {
    toast(error.message);
  }
}

function renderAdminOrder(order) {
  const canConfirm = order.paymentStatus !== "confirmed" && (!order.specialOrder || ["accepted", "countered"].includes(order.specialOrder.status));
  const canSyncShopify = order.paymentStatus === "confirmed" && !order.shopifyOrder?.id;
  const view = adminOrderView(order);
  const workflowNote =
    view === "ready"
      ? `<p class="muted">Payment confirmed. This order is ready for packing and tracking in Retail Shark.</p>`
      : view === "completed"
        ? `<p class="muted">Fulfilled and completed.</p>`
        : "";
  const specialReview = order.specialOrder ? renderAdminSpecialOrder(order) : "";
  const shopifySync = renderShopifySync(order);
  return `
    <article class="order-card" data-admin-order-id="${escapeHtml(order.id)}">
      <header>
        <div>
          <strong>${escapeHtml(order.reference)}</strong>
          <p class="muted">${escapeHtml(order.customer.name)} - ${escapeHtml(order.customer.email)}</p>
        </div>
        <span class="status-badge">${escapeHtml(order.paymentStatus)}</span>
      </header>
      <ul>${order.items.map((item) => `<li>${item.quantity} x ${escapeHtml(item.productTitle)}</li>`).join("")}</ul>
      <p><strong>Total:</strong> ${money.format(order.total)}</p>
      ${workflowNote}
      ${specialReview}
      <p class="muted">POP: ${
        order.proof
          ? `<a href="/api/admin/orders/${encodeURIComponent(order.id)}/proof" target="_blank" rel="noopener">${escapeHtml(order.proof.filename)}</a>`
          : "Not uploaded"
      }</p>
      ${shopifySync}
      ${
        canConfirm || canSyncShopify
          ? `<div class="order-actions">
              ${canConfirm ? `<button type="button" data-confirm="${order.id}">Confirm payment</button>` : ""}
              ${canSyncShopify ? `<button type="button" data-sync-shopify="${order.id}">Sync to Shopify</button>` : ""}
            </div>`
          : ""
      }
    </article>
  `;
}

function renderShopifySync(order) {
  const sync = order.shopifySync || {};
  if (order.shopifyOrder?.id) {
    const label = order.shopifyOrder.name || "Shopify order";
    const linked = order.shopifyOrder.adminUrl
      ? `<a href="${escapeHtml(order.shopifyOrder.adminUrl)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`
      : escapeHtml(label);
    return `<p class="muted">Shopify: ${linked} (${escapeHtml(order.shopifyOrder.financialStatus || "paid")})</p>`;
  }
  if (!sync.status || sync.status === "not_started") return `<p class="muted">Shopify: Not synced yet.</p>`;
  const labels = {
    disabled: "Sync disabled",
    syncing: "Syncing",
    error: "Sync error",
    synced: "Synced",
  };
  return `<p class="muted">Shopify: ${escapeHtml(labels[sync.status] || sync.status)}${sync.message ? ` - ${escapeHtml(sync.message)}` : ""}</p>`;
}

function renderAdminSpecialOrder(order) {
  const specialOrder = order.specialOrder;
  const labels = {
    pending: "Review required",
    accepted: "Approved",
    declined: "Declined",
    countered: "Counter sent",
  };
  const originalItems = specialOrder.originalItems || order.items;
  const pendingControls =
    specialOrder.status === "pending"
      ? `
        <div class="special-actions">
          <button type="button" data-special-action="accept" data-order-id="${escapeHtml(order.id)}">Approve request</button>
          <form class="inline-admin-form" data-special-review="decline" data-order-id="${escapeHtml(order.id)}">
            <input name="reason" placeholder="Decline reason">
            <button type="submit">Decline</button>
          </form>
          <form class="counter-form" data-special-review="counter" data-order-id="${escapeHtml(order.id)}">
            <div class="counter-lines">
              ${order.items
                .map(
                  (item) => `
                    <label>${escapeHtml(item.productTitle)}
                      <input name="${escapeHtml(item.variantId)}" type="number" min="0" max="999" value="${item.quantity}">
                    </label>
                  `,
                )
                .join("")}
            </div>
            <input name="note" placeholder="Counter note">
            <button type="submit">Send counter</button>
          </form>
        </div>
      `
      : "";
  return `
    <div class="special-review">
      <div>
        <strong>Special order: ${escapeHtml(labels[specialOrder.status] || specialOrder.status)}</strong>
        ${specialOrder.note ? `<p class="muted">${escapeHtml(specialOrder.note)}</p>` : ""}
      </div>
      <ul>${originalItems.map((item) => `<li>${item.quantity} x ${escapeHtml(item.productTitle)}</li>`).join("")}</ul>
      ${specialOrder.counterNote ? `<p class="muted">Counter note: ${escapeHtml(specialOrder.counterNote)}</p>` : ""}
      ${specialOrder.declineReason ? `<p class="muted">Decline reason: ${escapeHtml(specialOrder.declineReason)}</p>` : ""}
      ${pendingControls}
    </div>
  `;
}

async function submitSpecialOrderReview(orderId, action, input = {}) {
  try {
    await api(`/api/admin/orders/${encodeURIComponent(orderId)}/special-order`, {
      method: "POST",
      body: JSON.stringify({ action, ...input }),
    });
    toast(action === "counter" ? "Counter sent." : action === "decline" ? "Special order declined." : "Special order approved.");
    await loadAdminOrders();
  } catch (error) {
    toast(error.message);
  }
}

function submitSpecialReviewForm(event) {
  event.preventDefault();
  const form = event.target;
  const action = form.dataset.specialReview;
  if (action === "decline") {
    submitSpecialOrderReview(form.dataset.orderId, "decline", { reason: form.reason.value });
    return;
  }
  const counterItems = [...form.querySelectorAll(".counter-lines input")].map((input) => ({
    variantId: input.name,
    quantity: input.value,
  }));
  submitSpecialOrderReview(form.dataset.orderId, "counter", { counterItems, note: form.note.value });
}

async function confirmPayment(orderId) {
  try {
    const payload = await api(`/api/admin/orders/${encodeURIComponent(orderId)}/confirm-payment`, {
      method: "POST",
      body: JSON.stringify({ confirmedBy: "admin" }),
    });
    const sync = payload.order?.shopifySync;
    toast(sync?.status === "error" ? `Payment confirmed. Shopify sync failed: ${sync.message}` : "Payment confirmed.");
    await loadAdminOrders();
  } catch (error) {
    toast(error.message);
  }
}

async function syncShopifyOrder(orderId) {
  try {
    const payload = await api(`/api/admin/orders/${encodeURIComponent(orderId)}/sync-shopify`, { method: "POST" });
    toast(payload.order?.shopifyOrder?.name ? `Synced ${payload.order.shopifyOrder.name} to Shopify.` : "Shopify sync complete.");
    await loadAdminOrders();
  } catch (error) {
    toast(error.message);
    await loadAdminOrders();
  }
}

function installInputMasks() {
  qsa('input[name="phoneNumber"]').forEach((input) => {
    input.addEventListener("input", () => {
      input.value = input.value.replace(/[^\d ]+/g, "").replace(/\s+/g, " ").slice(0, 16);
    });
  });
  qsa('input[name="postalCode"]').forEach((input) => {
    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D+/g, "").slice(0, 4);
    });
  });
}

function deriveFilters(products) {
  const groups = new Map();
  const tags = new Map();
  const vendors = new Map();
  const productTypes = new Map();
  for (const product of products) {
    for (const group of product.groups || []) increment(groups, group);
    for (const tag of product.tags || []) increment(tags, tag);
    if (product.vendor) increment(vendors, product.vendor);
    if (product.productType) increment(productTypes, product.productType);
  }
  return {
    groups: [...groups.entries()].map(([id, count]) => ({ id, label: titleFromId(id), count })),
    tags: countEntries(tags),
    vendors: countEntries(vendors),
    productTypes: countEntries(productTypes),
  };
}

function buildBrandCollections(products) {
  const brands = new Map();
  for (const product of products) {
    if (!product.vendor) continue;
    const current = brands.get(product.vendor) || {
      vendor: product.vendor,
      count: 0,
      image: "",
      imageAlt: product.brandImageAlt || product.vendor,
      initials: fallbackLabel(product),
    };
    current.count += 1;
    if (product.brandImage) {
      current.image = product.brandImage;
      current.imageAlt = product.brandImageAlt || product.vendor;
    } else if (!current.image && product.image) {
      current.image = product.image;
      current.imageAlt = product.vendor;
    }
    brands.set(product.vendor, current);
  }
  return [...brands.values()].sort((a, b) => b.count - a.count || a.vendor.localeCompare(b.vendor));
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function countEntries(map) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => ({ label, count }));
}

function titleFromId(value) {
  return String(value || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function fallbackLabel(product) {
  const words = String(product.vendor || product.title || "TN")
    .split(/\s+/)
    .filter(Boolean);
  const label = words.length > 1 ? `${words[0][0]}${words[1][0]}` : words[0]?.slice(0, 2);
  return String(label || "TN").toUpperCase();
}

function searchableProductText(product) {
  return normalizeSearch([product.title, product.vendor, product.productType, product.variant?.sku, ...(product.tags || [])].join(" "));
}

function typeLabel(typeId) {
  return productTypes.find((type) => type.id === typeId)?.label || titleFromId(typeId);
}

function normalizeSearch(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

document.addEventListener("click", (event) => {
  const tab = event.target.closest(".tab");
  if (tab) switchView(tab.dataset.view);

  if (event.target.closest("#showCreateAccount")) showScreen("create");
  if (event.target.closest("#backToLogin")) showAuth();

  const add = event.target.closest("[data-add-product]");
  if (add) addToCart(add.dataset.addProduct, add.closest(".product"));

  const remove = event.target.closest("[data-remove]");
  if (remove) {
    state.cart.delete(remove.dataset.remove);
    renderCart();
  }

  const confirm = event.target.closest("[data-confirm]");
  if (confirm) confirmPayment(confirm.dataset.confirm);

  const syncShopify = event.target.closest("[data-sync-shopify]");
  if (syncShopify) syncShopifyOrder(syncShopify.dataset.syncShopify);

  const specialAction = event.target.closest("[data-special-action]");
  if (specialAction) submitSpecialOrderReview(specialAction.dataset.orderId, specialAction.dataset.specialAction);

  const brand = event.target.closest("[data-brand-filter]");
  if (brand) setSelectedBrand(brand.dataset.brandFilter || "");

  if (event.target.closest("#clearBrandFilter")) setSelectedBrand("");

  if (event.target.closest("#clearProductFilters")) {
    state.selectedTypes.clear();
    state.inStockOnly = false;
    state.search = "";
    state.productPage = 1;
    qs("#catalogSearch").value = "";
    renderProducts();
  }

  const pageAction = event.target.closest("[data-page-action]");
  if (pageAction) {
    const products = filteredProducts();
    const totalPages = Math.max(1, Math.ceil(products.length / state.productsPerPage));
    state.productPage += pageAction.dataset.pageAction === "next" ? 1 : -1;
    state.productPage = Math.min(Math.max(1, state.productPage), totalPages);
    renderProducts();
    qs("#productsTopPager")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const sliderStep = event.target.closest("[data-slider-step]");
  if (sliderStep) {
    const slider = qs("#featuredSlider");
    const direction = Number(sliderStep.dataset.sliderStep || 1);
    slider?.scrollBy({ left: direction * Math.max(280, slider.clientWidth * 0.82), behavior: "smooth" });
  }

  const adminTab = event.target.closest("[data-admin-view]");
  if (adminTab) {
    state.adminView = adminTab.dataset.adminView;
    if (state.adminView === "shop-settings") loadAdminShopSettings();
    else if (state.adminView === "accounts") loadAdminAccounts();
    else if (state.adminView === "system-status") loadSystemStatus();
    else renderAdminOrders();
  }

  const accountFilter = event.target.closest("[data-account-filter]");
  if (accountFilter) {
    state.adminAccountFilter = accountFilter.dataset.accountFilter || "all";
    renderAdminAccounts();
  }

  const removeAccount = event.target.closest("[data-remove-account]");
  if (removeAccount && !removeAccount.disabled) openRemoveAccountModal(removeAccount.dataset.removeAccount);

  const editAdminAccount = event.target.closest("[data-edit-admin-account]");
  if (editAdminAccount) openAdminAccountModal(editAdminAccount.dataset.editAdminAccount);

  if (event.target.closest("[data-cancel-remove-account]")) closeRemoveAccountModal();
  if (event.target.closest("[data-cancel-remove-address]")) closeRemoveAddressModal();

  if (event.target.closest("#openAdminAccountModal")) openAdminAccountModal();
  if (event.target.closest("[data-cancel-admin-account]")) closeAdminAccountModal();

  if (event.target.closest("#addAccountAddress")) openAddressModal("account");
  if (event.target.closest("#addCheckoutAddress")) openAddressModal("checkout");
  if (event.target.closest("#addSpecialAddress")) openAddressModal("special");
  if (event.target.closest("#openSpecialOrder")) openSpecialOrderModal();
  if (event.target.closest("[data-cancel-special-order]")) closeSpecialOrderModal();
  if (event.target.closest("[data-close-order-flow]")) closeOrderFlowModal();
  if (event.target.closest("[data-confirm-order]")) confirmPendingOrder();

  const editAddress = event.target.closest("[data-edit-address]");
  if (editAddress) openAddressModal("account", editAddress.dataset.editAddress);

  const removeAddress = event.target.closest("[data-remove-address]");
  if (removeAddress) openRemoveAddressModal(removeAddress.dataset.removeAddress);

  const defaultAddress = event.target.closest("[data-default-address]");
  if (defaultAddress) setDefaultAddress(defaultAddress.dataset.defaultAddress);

  if (event.target.closest("[data-cancel-address]")) closeAddressModal();

  const viewPayment = event.target.closest("[data-view-order-payment]");
  if (viewPayment) {
    const order = state.customerOrders?.find((entry) => entry.id === viewPayment.dataset.viewOrderPayment);
    if (order) showPaymentModal(order);
  }

  const viewTracking = event.target.closest("[data-view-order-tracking]");
  if (viewTracking) {
    const order = state.customerOrders?.find((entry) => entry.id === viewTracking.dataset.viewOrderTracking);
    if (order) showTrackingModal(order);
  }
});

document.addEventListener("change", async (event) => {
  const type = event.target.closest("[data-type-filter]");
  if (type) {
    if (type.checked) state.selectedTypes.add(type.dataset.typeFilter);
    else state.selectedTypes.delete(type.dataset.typeFilter);
    state.productPage = 1;
    renderProducts();
  }

  if (event.target.matches("#inStockFilter")) {
    state.inStockOnly = event.target.checked;
    state.productPage = 1;
    renderProducts();
  }

  if (event.target.matches("#checkoutAddressSelect")) {
    state.selectedAddressId = event.target.value;
  }

  if (event.target.matches('input[name="mode"]')) {
    const form = event.target.closest(".shop-settings-form");
    if (form) form.dataset.mode = event.target.value;
  }

  if (event.target.matches('#adminAccountForm select[name="role"]')) {
    toggleAdminAccountFields();
  }
});

qs("#catalogSearch").addEventListener("input", (event) => {
  state.search = event.target.value.trim();
  state.productPage = 1;
  renderProducts();
});

document.addEventListener("input", (event) => {
  if (event.target.matches("#adminProductPickSearch")) {
    syncDraftCustomSelections();
    state.adminProductSearch = event.target.value.trim();
    renderAdminShopSettings();
    const input = qs("#adminProductPickSearch");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
});

document.addEventListener("submit", (event) => {
  if (event.target.matches("#loginForm")) login(event);
  if (event.target.matches("#registerForm")) register(event);
  if (event.target.matches("#orderForm")) submitOrder(event);
  if (event.target.matches(".proof-form")) uploadProof(event);
  if (event.target.matches("[data-special-review]")) submitSpecialReviewForm(event);
  if (event.target.matches(".shop-settings-form")) submitShopSettings(event);
  if (event.target.matches("#adminAccountForm")) submitAdminAccount(event);
  if (event.target.matches("#removeAccountForm")) submitRemoveAccount(event);
  if (event.target.matches("#removeAddressForm")) confirmRemoveAddress(event);
  if (event.target.matches("#addressForm")) submitAddressForm(event);
  if (event.target.matches("#specialOrderForm")) submitSpecialOrder(event);
});

qs("#logoutButton").addEventListener("click", logout);
qs("#themeToggle").addEventListener("click", toggleTheme);
qs("#refreshCatalog").addEventListener("click", loadCatalog);
qs("#refreshOrders").addEventListener("click", loadCustomerOrders);
qs("#refreshAdminPanel").addEventListener("click", () => {
  if (state.adminView === "shop-settings") loadAdminShopSettings();
  else if (state.adminView === "accounts") loadAdminAccounts();
  else if (state.adminView === "system-status") loadSystemStatus();
  else loadAdminOrders();
});

installInputMasks();
renderCart();
initSession();
