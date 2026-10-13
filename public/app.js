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
  specialOrderItems: [],
  specialProductSearch: "",
  selectedSpecialProductId: "",
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
  adminOrderSearch: "",
  adminOrderFilter: "all",
};

const productTypes = [
  { id: "vial", label: "Vials", tokens: ["vial", "vials"] },
  { id: "oral", label: "Orals", tokens: ["oral", "orals", "tablet", "tablets", "tabs", "caps", "capsules"] },
  { id: "pen", label: "Pens", tokens: ["pen", "pens", "kwikpen"] },
  { id: "nasal", label: "Nasal", tokens: ["nasal"] },
];

const termsVersion = "research-use-v1-2026-10-08";
let pendingRegistrationPayload = null;

const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

function defaultShopSettings() {
  const providers = {
    yoco: {
      enabled: true,
      label: "Yoco payment link",
      customerTitle: "Secure Yoco payment",
      adminTitle: "Yoco payment link",
      payButtonLabel: "Pay now",
      copyLabel: "payment link",
      linkPlaceholder: "https://pay.yoco.com/...",
      customerInstructions: "Use the secure Yoco link below to complete payment.",
      adminInstructions: "Create the payment link in Yoco, then paste it here for the customer.",
      confirmationLabel: "Yoco payment confirmed",
      requireLink: true,
      allowProofUpload: false,
    },
    eft: {
      enabled: false,
      label: "EFT manual payment",
      customerTitle: "EFT payment",
      adminTitle: "EFT payment details",
      payButtonLabel: "View EFT details",
      copyLabel: "EFT details",
      linkPlaceholder: "",
      accountName: "Tank Nutrition",
      bankName: "",
      accountNumber: "",
      branchCode: "",
      customerInstructions: "Use the banking details and order reference below. Our team will verify payment before processing.",
      adminInstructions: "Review availability, then save the EFT details to unlock payment instructions for the customer.",
      confirmationLabel: "EFT payment confirmed",
      requireLink: false,
      allowProofUpload: false,
    },
    manual: {
      enabled: false,
      label: "Manual/custom",
      customerTitle: "Payment instructions",
      adminTitle: "Manual payment instructions",
      payButtonLabel: "View payment instructions",
      copyLabel: "payment instructions",
      linkPlaceholder: "https://",
      customerInstructions: "Follow the payment instructions below. Our team will verify payment before processing.",
      adminInstructions: "Enter the customer-facing payment instruction or optional payment URL.",
      confirmationLabel: "Payment confirmed",
      requireLink: false,
      allowProofUpload: false,
    },
  };
  return {
    featured: {
      mode: "collection",
      title: "Featured Dex",
      subtitle: "Fast access to the products customers ask for most.",
      collectionQuery: "Dex",
      customProductIds: [],
    },
    payment: {
      activeProvider: "yoco",
      reviewWindow: "12-24 hours",
      note: "Once payment has been marked as paid, the order will be verified and tracking details will follow.",
      providers,
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
      "x-op-client": "portal",
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

function newIdempotencyKey(prefix = "op") {
  return `${prefix}-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
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
  await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => null);
  state.cart.clear();
  renderCart();
  showAuth();
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
    try {
      const payload = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ login: loginValue, password }),
      });
      await showApp({ user: payload.user });
    } catch (customerError) {
      try {
        const payload = await api("/api/auth/admin-login", {
          method: "POST",
          body: JSON.stringify({ username: loginValue, password }),
        });
        await showApp({ admin: payload.admin });
      } catch {
        throw customerError;
      }
    }
  } catch (error) {
    toast(error.message);
  }
}

async function register(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  pendingRegistrationPayload = {
    username: form.get("username"),
    name: form.get("name"),
    email: form.get("email"),
    phoneArea: form.get("phoneArea"),
    phoneNumber: form.get("phoneNumber"),
    defaultAddress: addressFromForm(form),
    password: form.get("password"),
  };
  openTermsModal();
}

function openTermsModal() {
  const modal = qs("#termsModal");
  const body = qs("#termsScrollBody");
  const checkbox = qs("#termsAgeConfirm");
  const button = qs("#acceptTermsButton");
  checkbox.checked = false;
  checkbox.disabled = true;
  button.disabled = true;
  body.scrollTop = 0;
  modal.hidden = false;
}

function closeTermsModal() {
  pendingRegistrationPayload = null;
  qs("#termsModal").hidden = true;
}

function updateTermsGate() {
  const body = qs("#termsScrollBody");
  const checkbox = qs("#termsAgeConfirm");
  const button = qs("#acceptTermsButton");
  const hasScrolled = body.scrollTop + body.clientHeight >= body.scrollHeight - 8;
  checkbox.disabled = !hasScrolled;
  button.disabled = !hasScrolled || !checkbox.checked;
}

async function acceptTermsAndRegister() {
  if (!pendingRegistrationPayload) return;
  try {
    const payload = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        ...pendingRegistrationPayload,
        terms: {
          version: termsVersion,
          accepted: true,
          ageConfirmed: true,
        },
      }),
    });
    pendingRegistrationPayload = null;
    qs("#termsModal").hidden = true;
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
    state.shopSettings = mergeShopSettings(settingsPayload.settings || defaultShopSettings());
    state.brandCollections = buildBrandCollections(state.products);
    renderCatalogControls();
    renderFeaturedSlider();
    renderProducts();
  } catch (error) {
    qs("#products").innerHTML = renderLoadError(
      "Products could not load.",
      "Refresh the catalog. If it keeps failing, our team needs to check the Shopify connection.",
      "Retry",
      "retry-catalog",
    );
  }
}

async function loadShopSettings() {
  try {
    return await api("/api/shop-settings");
  } catch {
    return { settings: defaultShopSettings() };
  }
}

function currentShopSettings() {
  return mergeShopSettings(state.shopSettings || defaultShopSettings());
}

function mergeShopSettings(settings = {}) {
  const defaults = defaultShopSettings();
  const payment = settings.payment || {};
  const providers = {
    ...defaults.payment.providers,
    ...(payment.providers || {}),
  };
  return {
    ...defaults,
    ...settings,
    featured: { ...defaults.featured, ...(settings.featured || {}) },
    payment: {
      ...defaults.payment,
      ...payment,
      providers,
    },
    references: { ...defaults.references, ...(settings.references || {}) },
  };
}

function paymentSettings() {
  return currentShopSettings().payment;
}

function paymentProviderOptions() {
  return Object.entries(paymentSettings().providers || defaultShopSettings().payment.providers);
}

function paymentProviderConfig(providerId) {
  const settings = paymentSettings();
  const id = providerId || settings.activeProvider || "yoco";
  return settings.providers?.[id] || settings.providers?.yoco || defaultShopSettings().payment.providers.yoco;
}

function orderProviderConfig(order) {
  return paymentProviderConfig(order?.paymentLink?.provider || order?.paymentProvider || paymentSettings().activeProvider);
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

function renderLoadError(title, message, actionLabel, actionName) {
  return `
    <div class="load-error-panel">
      <strong>${escapeHtml(title)}</strong>
      <p class="muted">${escapeHtml(message)}</p>
      ${actionName ? `<button type="button" data-${escapeHtml(actionName)}>${escapeHtml(actionLabel || "Retry")}</button>` : ""}
    </div>
  `;
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
    idempotencyKey: newIdempotencyKey("standard"),
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
        idempotencyKey: draft.idempotencyKey,
      }),
    });
    if (!draft.specialOrder) state.cart.clear();
    state.pendingOrderDraft = null;
    renderCart();
    await loadCustomerOrders();
    showOrderSubmittedModal(payload.order);
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
  const paymentUnlocked = order.canPay || order.paymentLink || order.paymentStatus === "confirmed";
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
          ? `${paymentInstructions(order)}${order.paymentStatus === "confirmed" ? `<p class="muted">${escapeHtml(order.customerStatus)}</p>` : ""}`
          : `<section class="summary-panel"><p class="eyebrow">Status</p><h3>${escapeHtml(order.customerStatus)}</h3>${order.specialOrder ? renderSpecialOrderStatus(order.specialOrder) : ""}<p class="muted">${escapeHtml(paymentReviewNote(order))}</p></section>`
      }
    </div>
  `;
  qs("#orderFlowActions").innerHTML = `<button class="primary" type="button" data-close-order-flow>Done</button>`;
  qs("#orderFlowModal").hidden = false;
}

function showTrackingModal(order) {
  const shipments = customerShipments(order);
  qs("#orderFlowTitle").textContent = `Track order - ${order.reference}`;
  qs("#orderFlowContent").innerHTML = `
    <div class="summary-stack">
      ${shipments
        .map(
          (shipment, index) => `
            <section class="summary-panel">
              <p class="eyebrow">${shipments.length > 1 ? `Shipment ${index + 1}` : "Shipment"}</p>
              <h3>${escapeHtml(shipment.courier || "Courier")}</h3>
              <p><strong>Tracking Number:</strong> ${escapeHtml(shipment.number || "Not supplied")}</p>
            </section>
          `,
        )
        .join("")}
    </div>
  `;
  qs("#orderFlowActions").innerHTML = `
    <button class="secondary" type="button" data-close-order-flow>Close</button>
    ${shipments.map((shipment, index) => (shipment.url ? `<a class="primary button-link" href="${escapeHtml(shipment.url)}" target="_blank" rel="noopener">${shipments.length > 1 ? `Track shipment ${index + 1}` : "Track shipment"}</a>` : "")).join("")}
  `;
  qs("#orderFlowModal").hidden = false;
}

function customerShipments(order) {
  const shipments = Array.isArray(order.shipments) ? order.shipments : [];
  if (shipments.length) return shipments;
  return order.tracking?.number ? [order.tracking] : [];
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
      <p class="muted">${escapeHtml(paymentReviewNote(order))}</p>
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
  state.specialOrderItems = [];
  state.specialProductSearch = "";
  state.selectedSpecialProductId = "";
  renderSpecialProductOptions();
  renderSpecialAddressOptions();
  renderSpecialOrderItems();
  qs("#specialOrderModal").hidden = false;
}

function closeSpecialOrderModal() {
  qs("#specialOrderModal").hidden = true;
  state.specialOrderItems = [];
  state.specialProductSearch = "";
  state.selectedSpecialProductId = "";
  renderSpecialOrderItems();
}

function renderSpecialProductOptions() {
  const input = qs("#specialProductSearch");
  const hidden = qs("#specialProductId");
  const results = qs("#specialProductResults");
  if (!input || !hidden || !results) return;
  input.value = state.specialProductSearch;
  hidden.value = state.selectedSpecialProductId;
  if (!state.products.length) {
    results.innerHTML = `<p class="muted">Load products from Shop first.</p>`;
    return;
  }
  const query = normalizeSearch(state.specialProductSearch);
  const products = state.products
    .filter((product) => productMatchesSearch(product, query));
  results.innerHTML = products.length
    ? products
        .map((product) => {
          const selected = product.id === state.selectedSpecialProductId;
          const price = product.variant ? money.format(Number(product.variant.price || 0)) : "No price";
          const availability = product.variant?.inStock ? "In stock" : "Out of stock";
          return `
            <button class="special-product-option${selected ? " is-selected" : ""}" type="button" data-special-product-id="${escapeHtml(product.id)}">
              <span>${escapeHtml(product.title)}</span>
              <small>${escapeHtml([product.vendor, product.productType, product.variant?.sku, price, availability].filter(Boolean).join(" - "))}</small>
            </button>
          `;
        })
        .join("")
    : `<p class="muted">No products match that search.</p>`;
}

function renderSpecialAddressOptions() {
  const select = qs("#specialAddressSelect");
  if (!select) return;
  const addresses = userAddresses();
  select.innerHTML = addresses.length
    ? addresses.map((address) => `<option value="${escapeHtml(address.id)}" ${address.id === state.selectedAddressId ? "selected" : ""}>${escapeHtml(addressLabel(address))}</option>`).join("")
    : `<option value="">No saved addresses</option>`;
}

function specialOrderItemFromForm(form) {
  const productId = form.productId.value || state.selectedSpecialProductId;
  const product = state.products.find((entry) => entry.id === productId);
  const quantity = Math.max(1, Math.floor(Number(form.quantity.value || 1)));
  if (!product?.variant) {
    toast("Choose a product.");
    return null;
  }
  return {
    variantId: product.variant.id,
    productTitle: product.title,
    variantTitle: product.variant.title,
    sku: product.variant.sku,
    price: Number(product.variant.price),
    quantity,
  };
}

function addSpecialOrderItem() {
  const form = qs("#specialOrderForm");
  const item = specialOrderItemFromForm(form);
  if (!item) return;
  const existing = state.specialOrderItems.find((entry) => entry.variantId === item.variantId);
  if (existing) existing.quantity += item.quantity;
  else state.specialOrderItems.push(item);
  form.quantity.value = "1";
  state.specialProductSearch = "";
  state.selectedSpecialProductId = "";
  form.productId.value = "";
  renderSpecialProductOptions();
  renderSpecialOrderItems();
}

function removeSpecialOrderItem(variantId) {
  state.specialOrderItems = state.specialOrderItems.filter((item) => item.variantId !== variantId);
  renderSpecialOrderItems();
}

function renderSpecialOrderItems() {
  const container = qs("#specialOrderItems");
  if (!container) return;
  if (!state.specialOrderItems.length) {
    container.className = "special-order-items empty";
    container.innerHTML = `<span>No products added yet.</span>`;
    return;
  }
  container.className = "special-order-items";
  container.innerHTML = state.specialOrderItems
    .map(
      (item) => `
        <div class="special-order-item">
          <div>
            <strong>${escapeHtml(item.productTitle)}</strong>
            <span>${escapeHtml(item.quantity)} x ${money.format(item.price)}</span>
          </div>
          <button type="button" data-remove-special-item="${escapeHtml(item.variantId)}" aria-label="Remove ${escapeHtml(item.productTitle)}">x</button>
        </div>
      `,
    )
    .join("");
}

async function submitSpecialOrder(event) {
  event.preventDefault();
  const form = event.target;
  const address = userAddresses().find((entry) => entry.id === form.addressId.value);
  if (!address) return toast("Choose or add a delivery address.");
  const items = state.specialOrderItems.length ? state.specialOrderItems.map((item) => ({ ...item })) : [specialOrderItemFromForm(form)].filter(Boolean);
  if (!items.length) return;
  state.pendingOrderDraft = {
    idempotencyKey: newIdempotencyKey("special"),
    kind: "special",
    delivery: {
      addressId: address.id,
      address,
      notes: form.deliveryNotes.value,
      method: "Courier",
    },
    items,
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
    state.customerOrders = payload.orders || [];
    container.innerHTML = state.customerOrders.length ? state.customerOrders.map(renderCustomerOrder).join("") : `<p class="muted">No orders yet.</p>`;
  } catch (error) {
    container.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
}

function renderCustomerOrder(order) {
  const shipments = customerShipments(order);
  const tracking = shipments.length
    ? `<p><strong>Tracking Number:</strong> ${escapeHtml(shipments[0].number)}${shipments.length > 1 ? ` + ${shipments.length - 1} more` : ""}</p>`
    : "";
  const trackButton = shipments.length
    ? `<button type="button" data-view-order-tracking="${escapeHtml(order.id)}">Track Order</button>`
    : "";
  const provider = orderProviderConfig(order);
  const paymentActionLabel = order.paymentIssue?.type === "paid_pending" ? "Payment details" : order.canPay ? provider.payButtonLabel || "Payment details" : order.paymentLink ? "Payment details" : "View order";
  const special = order.specialOrder ? renderSpecialOrderStatus(order.specialOrder) : "";
  const reviewNote = !order.paymentLink && order.paymentStatus !== "confirmed" && order.specialOrder?.status !== "declined"
    ? `<p class="muted">${escapeHtml(paymentReviewNote(order))}</p>`
    : "";
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
      ${renderOrderProgress(order)}
      ${special}
      ${reviewNote}
      ${tracking}
      <div class="order-actions">
        <button type="button" data-view-order-payment="${escapeHtml(order.id)}">${paymentActionLabel}</button>
        ${trackButton}
      </div>
    </article>
  `;
}

function renderOrderProgress(order) {
  const steps = orderProgressSteps(order);
  return `
    <div class="order-progress" aria-label="Order progress">
      ${steps
        .map(
          (step) => `
            <span class="progress-step ${step.done ? "is-done" : ""} ${step.active ? "is-active" : ""}">
              <i aria-hidden="true"></i>
              <em>${escapeHtml(step.label)}</em>
            </span>
          `,
        )
        .join("")}
    </div>
  `;
}

function orderProgressSteps(order) {
  const hasPaymentInstructions = Boolean(order.paymentLink);
  const markedPaid = order.paymentIssue?.type === "paid_pending" || order.paymentStatus === "confirmed";
  const confirmed = order.paymentStatus === "confirmed";
  const shipped = order.fulfillmentStatus === "shipped";
  return [
    { label: "Submitted", done: true, active: !hasPaymentInstructions && !markedPaid && !shipped },
    { label: "Payment link sent", done: hasPaymentInstructions || markedPaid || confirmed || shipped, active: hasPaymentInstructions && !markedPaid && !confirmed },
    { label: "Marked as paid", done: markedPaid || confirmed || shipped, active: markedPaid && !confirmed },
    { label: "Processing", done: confirmed || shipped, active: confirmed && !shipped },
    { label: "Shipped", done: shipped, active: shipped },
  ];
}

function paymentReviewNote(order) {
  const reviewWindow = paymentSettings().reviewWindow || "12-24 hours";
  const provider = orderProviderConfig(order);
  const paymentLabel = provider.requireLink ? "payment link" : "payment details";
  if (order.specialOrder) {
    return `Your special order request has been submitted. Our team will review availability and confirm what we can supply, typically within ${reviewWindow}. If approved, your ${paymentLabel} will appear here.`;
  }
  return `Your order has been submitted. Our team will review availability and send your ${paymentLabel}, typically within ${reviewWindow}.`;
}

function paymentIssueLabel(type) {
  const labels = {
    link_not_opening: "Link will not open",
    amount_wrong: "Amount looks wrong",
    payment_failed: "Payment failed",
    paid_pending: "Marked as paid",
    other: "Other payment issue",
  };
  return labels[type] || labels.other;
}

function customerPaymentNotice(order) {
  if (!order.paymentIssue) return "";
  if (order.paymentIssue.type === "paid_pending") {
    return "Order marked as paid. Our team is reviewing the payment.";
  }
  return `Payment support request recorded: ${paymentIssueLabel(order.paymentIssue.type)}`;
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
  const confirmed = order.paymentStatus === "confirmed";
  const paymentLink = order.paymentLink || {};
  const hasPaymentLink = Boolean(order.paymentLink);
  const provider = orderProviderConfig(order);
  const markedPaid = order.paymentIssue?.type === "paid_pending";
  const eftLines = [
    provider.accountName && `Account: ${provider.accountName}`,
    provider.bankName && `Bank: ${provider.bankName}`,
    provider.accountNumber && `Account number: ${provider.accountNumber}`,
    provider.branchCode && `Branch code: ${provider.branchCode}`,
  ].filter(Boolean);
  const paymentLines = [
    `Order reference: ${order.reference}`,
    `Amount: ${money.format(order.total)}`,
    paymentLink.reference && `Payment reference: ${paymentLink.reference}`,
    paymentLink.url && `Payment link: ${paymentLink.url}`,
    ...eftLines,
    paymentLink.note || provider.customerInstructions,
  ].filter(Boolean);
  const paymentActions = !confirmed && hasPaymentLink
    ? `
      <div class="payment-support-actions">
        ${markedPaid ? "" : `<button type="button" data-paid-notice="${escapeHtml(order.id)}">I have paid</button>`}
        <button type="button" data-report-payment-issue="${escapeHtml(order.id)}">${provider.requireLink ? "Payment link not working" : "Payment help"}</button>
      </div>
    `
    : "";
  return `
    <div class="payment-box${confirmed ? " is-confirmed" : ""}">
      <div class="payment-line important">
        <strong>${confirmed ? "Payment confirmed" : escapeHtml(provider.customerTitle || provider.label || "Payment details")}</strong>
        <button type="button" data-copy-value="${escapeHtml(order.reference)}" data-copy-label="order reference">Copy reference</button>
      </div>
      <span>Amount: ${money.format(order.total)}</span>
      ${paymentLink.reference ? `<span>Payment reference: ${escapeHtml(paymentLink.reference)}</span>` : ""}
      ${eftLines.map((line) => `<span>${escapeHtml(line)}</span>`).join("")}
      ${paymentLink.note ? `<span>${escapeHtml(paymentLink.note)}</span>` : provider.customerInstructions ? `<span>${escapeHtml(provider.customerInstructions)}</span>` : ""}
      ${paymentLink.url && !confirmed ? `<a class="primary button-link payment-link-button" href="${escapeHtml(paymentLink.url)}" target="_blank" rel="noopener">${escapeHtml(provider.payButtonLabel || "Pay now")}</a>` : ""}
      ${order.paymentIssue ? `<span class="payment-issue-note">${escapeHtml(customerPaymentNotice(order))}</span>` : ""}
      ${!hasPaymentLink && !confirmed ? `<span>${escapeHtml(paymentReviewNote(order))}</span>` : ""}
      ${paymentActions}
      <div class="payment-copy-actions">
        ${paymentLink.url ? `<button type="button" data-copy-value="${escapeHtml(paymentLink.url)}" data-copy-label="${escapeHtml(provider.copyLabel || "payment link")}">Copy ${escapeHtml(provider.copyLabel || "payment link")}</button>` : ""}
        <button type="button" data-copy-value="${escapeHtml(paymentLines.join("\n"))}" data-copy-label="payment details">Copy payment details</button>
      </div>
    </div>
  `;
}

function showPaymentIssueModal(order) {
  state.activePaymentOrder = order;
  qs("#orderFlowTitle").textContent = `Report payment issue - ${order.reference}`;
  qs("#orderFlowContent").innerHTML = `
    <form id="paymentIssueForm" class="payment-issue-form" data-payment-issue="${escapeHtml(order.id)}">
      <label>Issue type
        <select name="type" required>
          <option value="link_not_opening">Link will not open</option>
          <option value="amount_wrong">Amount looks wrong</option>
          <option value="payment_failed">Payment failed</option>
          <option value="other">Other</option>
        </select>
      </label>
      <label>Message
        <textarea name="message" rows="4" placeholder="Tell us what happened"></textarea>
      </label>
      <p class="muted">This will alert our team to check your payment details and order.</p>
    </form>
  `;
  qs("#orderFlowActions").innerHTML = `
    <button class="secondary" type="button" data-close-order-flow>Cancel</button>
    <button class="primary" type="submit" form="paymentIssueForm">Submit issue</button>
  `;
  qs("#orderFlowModal").hidden = false;
}

async function submitPaymentIssueForm(event) {
  event.preventDefault();
  const form = event.target;
  const orderId = form.dataset.paymentIssue;
  const formData = new FormData(form);
  try {
    const payload = await api(`/api/orders/${encodeURIComponent(orderId)}/payment-issue`, {
      method: "POST",
      body: JSON.stringify({
        type: formData.get("type"),
        message: formData.get("message"),
      }),
    });
    toast("Payment issue reported.");
    await loadCustomerOrders();
    closeOrderFlowModal();
    const updated = payload.order || state.customerOrders.find((order) => order.id === orderId);
    if (updated) showPaymentModal(updated);
  } catch (error) {
    toast(error.message);
  }
}

async function reportPaidNotice(orderId) {
  try {
    const payload = await api(`/api/orders/${encodeURIComponent(orderId)}/paid-notice`, {
      method: "POST",
      body: "{}",
    });
    toast("Order marked as paid. We will verify it shortly.");
    await loadCustomerOrders();
    const updated = payload.order || state.customerOrders.find((order) => order.id === orderId);
    if (updated) showPaymentModal(updated);
  } catch (error) {
    toast(error.message);
  }
}

async function loadAdminOrders() {
  const container = qs("#adminOrders");
  container.innerHTML = `<p class="muted">Loading orders...</p>`;
  try {
    const [payload, settingsPayload] = await Promise.all([api("/api/admin/orders"), loadShopSettings()]);
    state.shopSettings = mergeShopSettings(settingsPayload.settings || defaultShopSettings());
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
  const viewOrders = state.adminOrders.filter((order) => adminOrderView(order) === state.adminView);
  const orders = viewOrders.filter(adminOrderMatchesFilters);
  const labels = {
    pending: "Awaiting confirmation",
    ready: "Ready to pack",
    completed: "Completed",
  };
  qs("#adminOrdersSummary").innerHTML = `
    <span>${labels[state.adminView]} - ${orders.length}${orders.length === viewOrders.length ? "" : ` of ${viewOrders.length}`} order${orders.length === 1 ? "" : "s"}</span>
    <div class="admin-order-tools">
      <input id="adminOrderSearch" type="search" value="${escapeHtml(state.adminOrderSearch)}" placeholder="Search reference, customer, email or product">
      <div class="admin-order-filters" aria-label="Order filters">
        ${adminOrderFilterOptions()
          .map(
            (filter) => `
              <button type="button" class="${state.adminOrderFilter === filter.id ? "is-active" : ""}" data-admin-order-filter="${filter.id}">
                ${escapeHtml(filter.label)}
              </button>
            `,
          )
          .join("")}
      </div>
    </div>
  `;
  const hasActiveOrderFilter = state.adminOrderFilter !== "all" || Boolean(state.adminOrderSearch);
  qs("#adminOrders").innerHTML = orders.length
    ? orders.map(renderAdminOrder).join("")
    : `<p class="muted">${hasActiveOrderFilter ? "No orders match this search or filter." : emptyAdminMessage(state.adminView)}</p>`;
}

function adminOrderFilterOptions() {
  return [
    { id: "all", label: "All" },
    { id: "needs_payment_details", label: "Needs payment details" },
    { id: "payment_to_verify", label: "Payment to verify" },
    { id: "special_review", label: "Special review" },
    { id: "support", label: "Payment support" },
  ];
}

function adminOrderMatchesFilters(order) {
  const query = normalizeSearch(state.adminOrderSearch);
  if (query && !adminOrderSearchText(order).includes(query)) return false;
  if (state.adminOrderFilter === "needs_payment_details") return !order.paymentLink && (!order.specialOrder || ["accepted", "countered"].includes(order.specialOrder.status));
  if (state.adminOrderFilter === "payment_to_verify") return order.paymentIssue?.type === "paid_pending";
  if (state.adminOrderFilter === "special_review") return order.specialOrder?.status === "pending";
  if (state.adminOrderFilter === "support") return order.paymentIssue && order.paymentIssue.status !== "resolved" && order.paymentIssue.type !== "paid_pending";
  return true;
}

function adminOrderSearchText(order) {
  return normalizeSearch(
    [
      order.reference,
      order.customer?.name,
      order.customer?.email,
      order.customer?.phone,
      order.items?.map((item) => `${item.productTitle} ${item.sku || ""}`).join(" "),
      order.paymentLink?.reference,
      order.proof?.note,
    ].join(" "),
  );
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
    state.shopSettings = mergeShopSettings(settingsPayload.settings || defaultShopSettings());
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

function renderPaymentProviderSettings(payment) {
  const activeProvider = payment.activeProvider || "yoco";
  const providers = payment.providers || defaultShopSettings().payment.providers;
  const providerFields = Object.entries(providers)
    .map(([id, provider]) => {
      const isEft = id === "eft";
      return `
        <details class="settings-subaccordion" ${id === activeProvider ? "open" : ""}>
          <summary>
            <span>${escapeHtml(provider.label || titleFromId(id))}</span>
            <small>${id === activeProvider ? "Active provider" : "Optional provider"}</small>
          </summary>
          <section class="settings-grid">
            <label>Admin title
              <input name="${escapeHtml(id)}AdminTitle" maxlength="120" value="${escapeHtml(provider.adminTitle || "")}">
            </label>
            <label>Customer title
              <input name="${escapeHtml(id)}CustomerTitle" maxlength="120" value="${escapeHtml(provider.customerTitle || "")}">
            </label>
            <label>Button label
              <input name="${escapeHtml(id)}PayButtonLabel" maxlength="80" value="${escapeHtml(provider.payButtonLabel || "")}">
            </label>
            <label>Copy label
              <input name="${escapeHtml(id)}CopyLabel" maxlength="80" value="${escapeHtml(provider.copyLabel || "")}">
            </label>
            <label class="wide">Admin confirmation label
              <input name="${escapeHtml(id)}ConfirmationLabel" maxlength="120" value="${escapeHtml(provider.confirmationLabel || "")}">
            </label>
            <label class="wide">Admin instructions
              <textarea name="${escapeHtml(id)}AdminInstructions" rows="2" maxlength="500">${escapeHtml(provider.adminInstructions || "")}</textarea>
            </label>
            <label class="wide">Customer instructions
              <textarea name="${escapeHtml(id)}CustomerInstructions" rows="2" maxlength="700">${escapeHtml(provider.customerInstructions || "")}</textarea>
            </label>
            ${
              isEft
                ? `
                  <label>Account name
                    <input name="${escapeHtml(id)}AccountName" maxlength="120" value="${escapeHtml(provider.accountName || "")}">
                  </label>
                  <label>Bank name
                    <input name="${escapeHtml(id)}BankName" maxlength="120" value="${escapeHtml(provider.bankName || "")}">
                  </label>
                  <label>Account number
                    <input name="${escapeHtml(id)}AccountNumber" maxlength="80" value="${escapeHtml(provider.accountNumber || "")}">
                  </label>
                  <label>Branch code
                    <input name="${escapeHtml(id)}BranchCode" maxlength="80" value="${escapeHtml(provider.branchCode || "")}">
                  </label>
                `
                : `
                  <label class="wide">Payment URL placeholder
                    <input name="${escapeHtml(id)}LinkPlaceholder" maxlength="180" value="${escapeHtml(provider.linkPlaceholder || "")}">
                  </label>
                `
            }
          </section>
        </details>
      `;
    })
    .join("");
  return `
    <section class="settings-grid">
      <label>Active payment provider
        <select name="activeProvider">
          ${Object.entries(providers)
            .map(([id, provider]) => `<option value="${escapeHtml(id)}" ${id === activeProvider ? "selected" : ""}>${escapeHtml(provider.label || titleFromId(id))}</option>`)
            .join("")}
        </select>
      </label>
      <label>Review window
        <input name="paymentReviewWindow" maxlength="80" value="${escapeHtml(payment.reviewWindow || "12-24 hours")}">
      </label>
      <label class="wide">Default customer note
        <textarea name="paymentNote" rows="3" maxlength="500">${escapeHtml(payment.note || "")}</textarea>
      </label>
    </section>
    <div class="provider-settings-list">
      ${providerFields}
    </div>
  `;
}

function collectPaymentSettings(formData) {
  const defaults = paymentSettings();
  const providers = {};
  const field = (name, fallback = "") => (formData.has(name) ? String(formData.get(name) || "") : fallback);
  for (const [id, provider] of Object.entries(defaults.providers || defaultShopSettings().payment.providers)) {
    providers[id] = {
      ...provider,
      label: provider.label || titleFromId(id),
      enabled: id === formData.get("activeProvider") || Boolean(provider.enabled),
      adminTitle: field(`${id}AdminTitle`, provider.adminTitle || ""),
      customerTitle: field(`${id}CustomerTitle`, provider.customerTitle || ""),
      payButtonLabel: field(`${id}PayButtonLabel`, provider.payButtonLabel || ""),
      copyLabel: field(`${id}CopyLabel`, provider.copyLabel || ""),
      confirmationLabel: field(`${id}ConfirmationLabel`, provider.confirmationLabel || ""),
      adminInstructions: field(`${id}AdminInstructions`, provider.adminInstructions || ""),
      customerInstructions: field(`${id}CustomerInstructions`, provider.customerInstructions || ""),
      linkPlaceholder: field(`${id}LinkPlaceholder`, provider.linkPlaceholder || ""),
      accountName: field(`${id}AccountName`, provider.accountName || ""),
      bankName: field(`${id}BankName`, provider.bankName || ""),
      accountNumber: field(`${id}AccountNumber`, provider.accountNumber || ""),
      branchCode: field(`${id}BranchCode`, provider.branchCode || ""),
    };
  }
  return {
    ...defaults,
    activeProvider: formData.get("activeProvider") || defaults.activeProvider || "yoco",
    reviewWindow: formData.get("paymentReviewWindow") || defaults.reviewWindow || "12-24 hours",
    note: formData.get("paymentNote") || defaults.note || "",
    providers,
  };
}

function renderAdminShopSettings() {
  qsa("[data-admin-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.adminView === state.adminView));
  const allSettings = currentShopSettings();
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
        <summary><span>Payments</span><small>Provider module, customer instructions and future webhook readiness</small></summary>
        ${renderPaymentProviderSettings(payment)}
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
        payment: collectPaymentSettings(formData),
        references: {
          standardFormat: formData.get("standardFormat"),
          specialFormat: formData.get("specialFormat"),
        },
      }),
    });
    state.shopSettings = mergeShopSettings(payload.settings);
    toast("Shop settings saved.");
    renderAdminShopSettings();
  } catch (error) {
    toast(error.message);
  }
}

function adminOrderStatusLabel(order) {
  if (order.fulfillmentStatus === "shipped") return "Completed";
  if (order.specialOrder?.status === "declined") return "Declined";
  if (order.paymentStatus === "confirmed") {
    if (order.shopifySync?.status === "storage_pending") return "Storage transfer required";
    if (order.fulfillmentStatus === "back_order") return "Back order";
    return "Ready to pack";
  }
  if (order.paymentIssue?.type === "paid_pending") return "Payment to verify";
  if (order.paymentIssue && order.paymentIssue.status !== "resolved") return "Payment support";
  if (order.specialOrder?.status === "pending") return "Review required";
  if (order.specialOrder?.status === "countered") return "Counter sent";
  if (order.paymentLink) return "Payment required";
  return "Awaiting confirmation";
}

function renderAdminOrder(order) {
  const readyForPayment = !order.specialOrder || ["accepted", "countered"].includes(order.specialOrder.status);
  const hasPaymentEvidence = Boolean(order.paymentLink || order.proof);
  const canConfirm = order.paymentStatus !== "confirmed" && readyForPayment && hasPaymentEvidence;
  const hasShopifyRelevantItems = !order.specialOrder || (order.officeItems || []).length > 0;
  const canCheckStockTransfer =
    hasShopifyRelevantItems && order.paymentStatus === "confirmed" && !order.shopifyOrder?.id && order.shopifySync?.status === "storage_pending";
  const view = adminOrderView(order);
  const hasManualItems = Boolean((order.externalItems || []).length);
  const workflowNote =
    view === "ready"
      ? `<p class="muted">${escapeHtml(readyWorkflowMessage(order, hasShopifyRelevantItems, hasManualItems))}</p>`
      : view === "completed"
        ? `<p class="muted">Fulfilled and completed.</p>`
        : "";
  const paymentNote = order.proof?.note ? `<p class="muted"><strong>Payment note:</strong> ${escapeHtml(order.proof.note)}</p>` : "";
  const paymentLinkForm = renderAdminPaymentLinkForm(order, readyForPayment);
  const paymentIssue = renderAdminPaymentIssue(order);
  const specialReview = order.specialOrder ? renderAdminSpecialOrder(order) : "";
  const manualTracking = renderManualTrackingForm(order);
  const shopifySync = renderShopifySync(order);
  const storageTransferNote = (order.items || []).some((item) => Number(item.storageBackedQuantity || 0) > 0)
    ? `<p class="muted"><strong>Stock transfer:</strong> This order is paused until the required units have been moved to Office. Use the check button after the transfer has been completed.</p>`
    : "";
  const statusLabel = adminOrderStatusLabel(order);
  return `
    <details class="order-card admin-order-card" data-admin-order-id="${escapeHtml(order.id)}">
      <summary class="admin-order-summary">
        <div>
          <strong>${escapeHtml(order.reference)}</strong>
          <p class="muted">${escapeHtml(order.customer.name)} - ${escapeHtml(order.customer.email)}</p>
        </div>
        <span class="status-badge">${escapeHtml(statusLabel)}</span>
      </summary>
      <div class="admin-order-details">
        <ul>${order.items.map((item) => `<li>${item.quantity} x ${escapeHtml(item.productTitle)}</li>`).join("")}</ul>
        <p><strong>Total:</strong> ${money.format(order.total)}</p>
        ${workflowNote}
        ${storageTransferNote}
        ${specialReview}
        ${paymentIssue}
        ${paymentLinkForm}
        ${manualTracking}
        ${
          order.proof
            ? `<p class="muted">Legacy proof file: <a href="/api/admin/orders/${encodeURIComponent(order.id)}/proof" target="_blank" rel="noopener">${escapeHtml(order.proof.filename)}</a></p>`
            : ""
        }
        ${paymentNote}
        ${shopifySync}
        ${
          canConfirm || canCheckStockTransfer
            ? `<div class="order-actions">
                ${canConfirm ? `<button type="button" data-confirm="${order.id}">Confirm payment</button>` : ""}
                ${canCheckStockTransfer ? `<button type="button" data-check-stock-transfer="${order.id}">Check stock transfer</button>` : ""}
              </div>`
            : ""
        }
      </div>
    </details>
  `;
}

function renderAdminPaymentIssue(order) {
  const issue = order.paymentIssue;
  if (!issue || issue.status === "resolved") return "";
  return `
    <div class="payment-issue-panel">
      <div>
        <strong>${escapeHtml(paymentIssueLabel(issue.type))}</strong>
        <span>Reported ${issue.reportedAt ? new Date(issue.reportedAt).toLocaleString() : "by customer"}</span>
      </div>
      ${issue.message ? `<p>${escapeHtml(issue.message)}</p>` : ""}
      <button type="button" data-resolve-payment-issue="${escapeHtml(order.id)}">Mark resolved</button>
    </div>
  `;
}

function renderAdminPaymentLinkForm(order, readyForPayment) {
  const providerId = order.paymentLink?.provider || order.paymentProvider || paymentSettings().activeProvider || "yoco";
  const provider = paymentProviderConfig(providerId);
  if (order.paymentStatus === "confirmed") {
    return order.paymentLink
      ? `<div class="payment-link-panel"><strong>${escapeHtml(provider.label || "Payment")}</strong>${order.paymentLink.url ? `<a href="${escapeHtml(order.paymentLink.url)}" target="_blank" rel="noopener">${escapeHtml(order.paymentLink.reference || order.reference)}</a>` : `<span>${escapeHtml(order.paymentLink.reference || order.reference)}</span>`}<span>Confirmed</span></div>`
      : "";
  }
  if (!readyForPayment) {
    return `<div class="payment-link-panel"><strong>${escapeHtml(provider.adminTitle || "Payment details")}</strong><span>Review this order before attaching payment details.</span></div>`;
  }
  const link = order.paymentLink || {};
  const providerChoices = paymentProviderOptions()
    .map(([id, option]) => `<option value="${escapeHtml(id)}" ${id === providerId ? "selected" : ""}>${escapeHtml(option.label || titleFromId(id))}</option>`)
    .join("");
  return `
    <form class="payment-link-panel" data-payment-link="${escapeHtml(order.id)}">
      <div>
        <strong>${escapeHtml(provider.adminTitle || "Payment details")}</strong>
        <span>${escapeHtml(link.url || link.reference ? "Payment details are attached. Update them only if they change." : provider.adminInstructions || "Attach the payment details for the customer.")}</span>
      </div>
      <label>Provider
        <select name="provider">
          ${providerChoices}
        </select>
      </label>
      <label class="wide">Payment link
        <input name="url" type="url" value="${escapeHtml(link.url || "")}" placeholder="${escapeHtml(provider.linkPlaceholder || "https://")}">
      </label>
      <label>Reference <input name="reference" value="${escapeHtml(link.reference || order.reference)}" placeholder="${escapeHtml(order.reference)}"></label>
      <label>Note <input name="note" value="${escapeHtml(link.note || provider.customerInstructions || "")}" placeholder="Customer-facing payment note"></label>
      <button type="submit">${link.url || link.reference ? "Update payment details" : "Attach payment details"}</button>
    </form>
  `;
}

function readyWorkflowMessage(order, hasShopifyRelevantItems, hasManualItems) {
  if (order.specialOrder && hasShopifyRelevantItems && hasManualItems) {
    return "Payment confirmed. Retail Shark will handle its allocation; add external shipment tracking here when available.";
  }
  if (order.specialOrder && hasManualItems) {
    return "Payment confirmed. Add external shipment tracking here when available.";
  }
  return "Payment confirmed. This order is ready for packing and tracking in Retail Shark.";
}

function renderShopifySync(order) {
  const sync = order.shopifySync || {};
  if (order.shopifyOrder?.id) {
    const label = order.shopifyOrder.name || "Shopify order";
    const linked = order.shopifyOrder.adminUrl
      ? `<a href="${escapeHtml(order.shopifyOrder.adminUrl)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`
      : escapeHtml(label);
    return `<p class="muted">Processing: ${linked} (${escapeHtml(order.shopifyOrder.financialStatus || "paid")})</p>`;
  }
  if (!sync.status || sync.status === "not_started") return `<p class="muted">Processing: Not started yet.</p>`;
  const labels = {
    disabled: "Sync disabled",
    external: "Not required",
    storage_pending: "Storage transfer required",
    syncing: "Syncing",
    error: "Sync error",
    synced: "Synced",
  };
  return `<p class="muted">Processing: ${escapeHtml(labels[sync.status] || sync.status)}${sync.message ? ` - ${escapeHtml(sync.message)}` : ""}</p>`;
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
          <form class="counter-form" data-special-review="accept" data-order-id="${escapeHtml(order.id)}">
            <p class="muted">Allocate approved units before payment is unlocked. The combined Retail Shark and external quantity cannot exceed the requested quantity.</p>
            <div class="counter-lines fulfillment-lines">
              ${renderFulfillmentAllocationInputs(order.items)}
            </div>
            <button type="submit">Approve with allocation</button>
          </form>
          <form class="inline-admin-form" data-special-review="decline" data-order-id="${escapeHtml(order.id)}">
            <input name="reason" placeholder="Decline reason">
            <button type="submit">Decline</button>
          </form>
          <form class="counter-form" data-special-review="counter" data-order-id="${escapeHtml(order.id)}">
            <p class="muted">Enter the approved split. Retail Shark plus external quantities become the order total and cannot exceed the requested quantity.</p>
            <div class="counter-lines">
              ${renderCounterAllocationInputs(order.items)}
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
      ${renderAdminFulfillmentSummary(order)}
      ${specialOrder.counterNote ? `<p class="muted">Counter note: ${escapeHtml(specialOrder.counterNote)}</p>` : ""}
      ${specialOrder.declineReason ? `<p class="muted">Decline reason: ${escapeHtml(specialOrder.declineReason)}</p>` : ""}
      ${pendingControls}
    </div>
  `;
}

function renderManualTrackingForm(order) {
  const manualItems = order.externalItems || [];
  if (!order.specialOrder || !manualItems.length) return "";
  const tracking = order.externalTracking || {};
  const items = manualItems.map((item) => `<li>${escapeHtml(item.quantity)} x ${escapeHtml(item.productTitle)}</li>`).join("");
  if (order.paymentStatus !== "confirmed") {
    return `
      <div class="manual-tracking-panel">
        <strong>External shipment tracking</strong>
        <ul>${items}</ul>
        <p class="muted">Tracking can be added after payment is confirmed.</p>
      </div>
    `;
  }
  return `
    <form class="manual-tracking-panel" data-manual-tracking="${escapeHtml(order.id)}">
      <div>
        <strong>External shipment tracking</strong>
        <p class="muted">Add tracking here for the externally fulfilled part of this special order.</p>
      </div>
      <ul>${items}</ul>
      <div class="tracking-grid">
        <label>Courier <input name="courier" value="${escapeHtml(tracking.courier || "")}" placeholder="Courier name"></label>
        <label>Tracking number <input name="number" value="${escapeHtml(tracking.number || "")}" placeholder="Tracking number" required></label>
        <label class="wide">Tracking URL <input name="url" type="url" value="${escapeHtml(tracking.url || "")}" placeholder="https://"></label>
        <label class="wide">Internal note <input name="note" value="${escapeHtml(tracking.note || "")}" placeholder="Optional admin note"></label>
      </div>
      <button type="submit">${tracking.number ? "Update tracking" : "Save tracking"}</button>
    </form>
  `;
}

function renderFulfillmentAllocationInputs(items) {
  return items
    .map(
      (item) => `
        <div class="fulfillment-allocation-row" data-special-allocation-row data-variant-id="${escapeHtml(item.variantId)}" data-total="${escapeHtml(item.quantity)}">
          <strong>${escapeHtml(item.productTitle)}</strong>
          <span>Requested: ${escapeHtml(item.quantity)}</span>
          <label>Retail Shark / Shopify
            <input name="office-${escapeHtml(item.variantId)}" type="number" min="0" max="999" value="${escapeHtml(item.quantity)}">
          </label>
          <label>External
            <input name="external-${escapeHtml(item.variantId)}" type="number" min="0" max="999" value="0">
          </label>
        </div>
      `,
    )
    .join("");
}

function renderCounterAllocationInputs(items) {
  return items
    .map(
      (item) => `
        <div class="fulfillment-allocation-row" data-special-allocation-row data-variant-id="${escapeHtml(item.variantId)}" data-total="${escapeHtml(item.quantity)}">
          <strong>${escapeHtml(item.productTitle)}</strong>
          <span>Requested: ${escapeHtml(item.quantity)}</span>
          <label>Retail Shark / Shopify
            <input name="office-${escapeHtml(item.variantId)}" type="number" min="0" max="999" value="${escapeHtml(item.quantity)}">
          </label>
          <label>External
            <input name="external-${escapeHtml(item.variantId)}" type="number" min="0" max="999" value="0">
          </label>
        </div>
      `,
    )
    .join("");
}

function renderAdminFulfillmentSummary(order) {
  const allocations = order.specialOrder?.fulfillmentAllocations || [];
  if (!allocations.length) return "";
  return `
    <div class="fulfillment-summary">
      <strong>Fulfillment split</strong>
      <ul>
        ${allocations
          .map(
            (item) => `
              <li>
                <span>${escapeHtml(item.productTitle || order.items.find((entry) => entry.variantId === item.variantId)?.productTitle || "Product")}</span>
                <small>Retail Shark: ${escapeHtml(item.officeQuantity || 0)} / External: ${escapeHtml(item.externalQuantity || 0)}</small>
              </li>
            `,
          )
          .join("")}
      </ul>
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
  const allocations = collectSpecialAllocations(form);
  const invalidAllocation = allocations.find((item) => Number(item.officeQuantity || 0) + Number(item.externalQuantity || 0) > Number(item.requestedQuantity || 0));
  if (invalidAllocation) {
    toast("Approved quantity cannot exceed the requested quantity.");
    return;
  }
  if (action === "accept") {
    submitSpecialOrderReview(form.dataset.orderId, "accept", { allocations });
    return;
  }
  const counterItems = allocations.map((item) => ({
    variantId: item.variantId,
    quantity: Number(item.officeQuantity || 0) + Number(item.externalQuantity || 0),
  }));
  submitSpecialOrderReview(form.dataset.orderId, "counter", { counterItems, allocations, note: form.note.value });
}

function collectSpecialAllocations(form) {
  return [...form.querySelectorAll("[data-special-allocation-row]")].map((row) => {
    const variantId = row.dataset.variantId;
    const inputs = [...row.querySelectorAll("input")];
    const officeInput = inputs.find((input) => input.name === `office-${variantId}`);
    const externalInput = inputs.find((input) => input.name === `external-${variantId}`);
    return {
      variantId,
      requestedQuantity: Number(row.dataset.total || 0),
      officeQuantity: officeInput?.value || 0,
      externalQuantity: externalInput?.value || 0,
    };
  });
}

async function confirmPayment(orderId) {
  try {
    const payload = await api(`/api/admin/orders/${encodeURIComponent(orderId)}/confirm-payment`, {
      method: "POST",
      body: JSON.stringify({ confirmedBy: "admin" }),
    });
    const sync = payload.order?.shopifySync;
    if (sync?.status === "storage_pending") toast("Payment confirmed. Stock transfer required before processing can continue.");
    else toast(sync?.status === "error" ? `Payment confirmed. Shopify processing failed: ${sync.message}` : "Payment confirmed.");
    await loadAdminOrders();
  } catch (error) {
    toast(error.message);
  }
}

async function submitPaymentLink(event) {
  event.preventDefault();
  const form = event.target;
  const orderId = form.dataset.paymentLink;
  const formData = new FormData(form);
  try {
    await api(`/api/admin/orders/${encodeURIComponent(orderId)}/payment-link`, {
      method: "POST",
      body: JSON.stringify({
        provider: formData.get("provider"),
        url: formData.get("url"),
        reference: formData.get("reference"),
        note: formData.get("note"),
      }),
    });
    toast("Payment details saved.");
    await loadAdminOrders();
  } catch (error) {
    toast(error.message);
  }
}

async function resolvePaymentIssue(orderId) {
  try {
    await api(`/api/admin/orders/${encodeURIComponent(orderId)}/payment-issue/resolve`, {
      method: "POST",
      body: "{}",
    });
    toast("Payment issue resolved.");
    await loadAdminOrders();
  } catch (error) {
    toast(error.message);
  }
}

async function checkStockTransfer(orderId) {
  try {
    const payload = await api(`/api/admin/orders/${encodeURIComponent(orderId)}/check-stock-transfer`, { method: "POST" });
    if (payload.order?.shopifyOrder?.name) {
      toast(`Stock transfer confirmed. Order ${payload.order.shopifyOrder.name} is ready for Retail Shark.`);
    } else {
      toast(payload.order?.shopifySync?.message || "Stock transfer is still required.");
    }
    await loadAdminOrders();
  } catch (error) {
    toast(error.message);
    await loadAdminOrders();
  }
}

async function submitManualTracking(event) {
  event.preventDefault();
  const form = event.target;
  const orderId = form.dataset.manualTracking;
  const formData = new FormData(form);
  try {
    await api(`/api/admin/orders/${encodeURIComponent(orderId)}/external-tracking`, {
      method: "POST",
      body: JSON.stringify({
        courier: formData.get("courier"),
        number: formData.get("number"),
        url: formData.get("url"),
        note: formData.get("note"),
      }),
    });
    toast("Tracking saved.");
    await loadAdminOrders();
  } catch (error) {
    toast(error.message);
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

function productMatchesSearch(product, query) {
  if (!query) return true;
  const text = searchableProductText(product);
  return query.split(" ").filter(Boolean).every((token) => text.includes(token));
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

async function copyText(value, label = "text") {
  const text = String(value || "");
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const input = document.createElement("textarea");
      input.value = text;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    toast(`Copied ${label}.`);
  } catch {
    toast(`Could not copy ${label}.`);
  }
}

document.addEventListener("click", (event) => {
  const tab = event.target.closest(".tab");
  if (tab) switchView(tab.dataset.view);

  if (event.target.closest("#showCreateAccount")) showScreen("create");
  if (event.target.closest("#backToLogin")) showAuth();
  if (event.target.closest("[data-cancel-terms]")) closeTermsModal();
  if (event.target.closest("#acceptTermsButton")) acceptTermsAndRegister();

  const add = event.target.closest("[data-add-product]");
  if (add) addToCart(add.dataset.addProduct, add.closest(".product"));

  const remove = event.target.closest("[data-remove]");
  if (remove) {
    state.cart.delete(remove.dataset.remove);
    renderCart();
  }

  const confirm = event.target.closest("[data-confirm]");
  if (confirm) confirmPayment(confirm.dataset.confirm);

  const paidNotice = event.target.closest("[data-paid-notice]");
  if (paidNotice) reportPaidNotice(paidNotice.dataset.paidNotice);

  const reportPaymentIssue = event.target.closest("[data-report-payment-issue]");
  if (reportPaymentIssue) {
    const order = state.customerOrders?.find((entry) => entry.id === reportPaymentIssue.dataset.reportPaymentIssue) || state.activePaymentOrder;
    if (order) showPaymentIssueModal(order);
  }

  const resolveIssue = event.target.closest("[data-resolve-payment-issue]");
  if (resolveIssue) resolvePaymentIssue(resolveIssue.dataset.resolvePaymentIssue);

  const stockTransfer = event.target.closest("[data-check-stock-transfer]");
  if (stockTransfer) checkStockTransfer(stockTransfer.dataset.checkStockTransfer);

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
    state.adminOrderFilter = "all";
    state.adminOrderSearch = "";
    if (state.adminView === "shop-settings") loadAdminShopSettings();
    else if (state.adminView === "accounts") loadAdminAccounts();
    else if (state.adminView === "system-status") loadSystemStatus();
    else renderAdminOrders();
  }

  const adminOrderFilter = event.target.closest("[data-admin-order-filter]");
  if (adminOrderFilter) {
    state.adminOrderFilter = adminOrderFilter.dataset.adminOrderFilter || "all";
    renderAdminOrders();
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
  if (event.target.closest("#addSpecialProduct")) addSpecialOrderItem();
  const removeSpecialItem = event.target.closest("[data-remove-special-item]");
  if (removeSpecialItem) removeSpecialOrderItem(removeSpecialItem.dataset.removeSpecialItem);
  const specialProduct = event.target.closest("[data-special-product-id]");
  if (specialProduct) {
    const product = state.products.find((entry) => entry.id === specialProduct.dataset.specialProductId);
    state.selectedSpecialProductId = specialProduct.dataset.specialProductId;
    state.specialProductSearch = product ? `${product.vendor ? `${product.vendor} - ` : ""}${product.title}` : state.specialProductSearch;
    renderSpecialProductOptions();
  }
  const copy = event.target.closest("[data-copy-value]");
  if (copy) copyText(copy.dataset.copyValue, copy.dataset.copyLabel || "text");
  if (event.target.closest("[data-retry-catalog]")) loadCatalog();
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
  if (event.target.matches("#termsAgeConfirm")) {
    updateTermsGate();
  }

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
  if (event.target.matches("#specialProductSearch")) {
    state.specialProductSearch = event.target.value.trim();
    state.selectedSpecialProductId = "";
    qs("#specialProductId").value = "";
    renderSpecialProductOptions();
    const input = qs("#specialProductSearch");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

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

  if (event.target.matches("#adminOrderSearch")) {
    state.adminOrderSearch = event.target.value.trim();
    renderAdminOrders();
    const input = qs("#adminOrderSearch");
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
  if (event.target.matches(".payment-issue-form")) submitPaymentIssueForm(event);
  if (event.target.matches("[data-payment-link]")) submitPaymentLink(event);
  if (event.target.matches("[data-special-review]")) submitSpecialReviewForm(event);
  if (event.target.matches("[data-manual-tracking]")) submitManualTracking(event);
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
qs("#termsScrollBody").addEventListener("scroll", updateTermsGate);
qs("#refreshAdminPanel").addEventListener("click", () => {
  if (state.adminView === "shop-settings") loadAdminShopSettings();
  else if (state.adminView === "accounts") loadAdminAccounts();
  else if (state.adminView === "system-status") loadSystemStatus();
  else loadAdminOrders();
});

installInputMasks();
renderCart();
initSession();
