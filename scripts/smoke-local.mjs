const baseUrl = process.env.ONLINE_PORTAL_URL || "http://127.0.0.1:3141";

class Session {
  cookie = "";

  async request(path, options = {}) {
    const headers = {
      "content-type": "application/json",
      ...(this.cookie ? { cookie: this.cookie } : {}),
      ...(options.headers || {}),
    };
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(`${options.method || "GET"} ${path} failed: ${payload.error || response.status}`);
    }
    return payload;
  }
}

const customer = new Session();
const login = await customer.request("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ login: "user", password: "user" }),
});
if (login.user.username !== "user") throw new Error("Customer login did not return demo user.");

const catalog = await customer.request("/api/catalog");
if (!catalog.products.length) throw new Error("Catalog returned no products.");
const product = catalog.products.find((entry) => entry.variant?.inStock);
if (!product) throw new Error("Catalog returned no available products.");
if (JSON.stringify(catalog.products).includes('"stock"')) throw new Error("Catalog leaked customer-facing stock quantities.");
if (JSON.stringify(catalog.products).includes('"availableQuantity"')) throw new Error("Catalog leaked customer-facing inventory quantities.");

const order = await customer.request("/api/orders", {
  method: "POST",
  body: JSON.stringify({
    delivery: {
      method: "Courier",
      notes: "Local smoke test",
      address: {
        line1: "1 Test Road",
        line2: "",
        suburb: "Menlyn",
        city: "Pretoria",
        province: "Gauteng",
        postalCode: "0001",
        country: "South Africa",
      },
    },
    items: [
      {
        variantId: product.variant.id,
        productTitle: product.title,
        variantTitle: product.variant.title,
        sku: product.variant.sku,
        quantity: 1,
        price: product.variant.price,
      },
    ],
  }),
});

await customer.request(`/api/orders/${encodeURIComponent(order.order.id)}/proof`, {
  method: "POST",
  body: JSON.stringify({
    filename: "smoke-pop.txt",
    note: "Smoke test POP",
    dataUrl: "data:text/plain;base64,c21va2UgcG9w",
  }),
});

const admin = new Session();
await admin.request("/api/auth/admin-login", {
  method: "POST",
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
const confirmed = await admin.request(`/api/admin/orders/${encodeURIComponent(order.order.id)}/confirm-payment`, {
  method: "POST",
  body: JSON.stringify({ confirmedBy: "admin" }),
});
if (confirmed.order.paymentStatus !== "confirmed") throw new Error("Admin confirmation did not mark payment confirmed.");

const internal = await fetch(`${baseUrl}/api/internal/orders/confirmed`, {
  headers: { "x-internal-token": process.env.INTERNAL_API_TOKEN || "dev-internal-token" },
}).then((response) => response.json());
if (!internal.ok || !internal.orders.some((entry) => entry.id === order.order.id)) {
  throw new Error("Confirmed order was not visible through the Retail Shark internal endpoint.");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      catalogSource: catalog.source,
      products: catalog.products.length,
      orderReference: order.order.reference,
      confirmedOrdersVisible: internal.orders.length,
    },
    null,
    2,
  ),
);
