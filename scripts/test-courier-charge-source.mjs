import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const serverSource = await readFile(path.resolve(import.meta.dirname, "..", "server.js"), "utf8");
const appSource = await readFile(path.resolve(import.meta.dirname, "..", "public", "app.js"), "utf8");

assert.match(serverSource, /courier:\s*\{[\s\S]*amount:\s*150/, "Courier settings should default to R150.");
assert.match(serverSource, /function normalizeCourierSettings/, "Courier charge should be settings-backed.");
assert.match(serverSource, /const deliveryFee = courierLine \? money\(courierLine\.price\) : 0;/, "Server must own the courier fee.");
assert.match(serverSource, /function resolveCourierLine/, "Server should resolve the Shopify Courier product line.");
assert.match(serverSource, /function fetchShopifyProductByHandle/, "Server should fetch the unlisted Shopify Courier product by handle.");
assert.match(serverSource, /productQuery:\s*"pudo-courier"/, "Courier settings should point at the Shopify unlisted Courier product handle.");
assert.match(serverSource, /function shopifyCourierLineItem/, "Shopify orders should include a Courier product line.");
assert.match(serverSource, /priceSet:\s*moneyBag\(order\.deliveryFee\)/, "Courier line should use the configured OP fee amount.");
assert.match(serverSource, /resolveCourierProduct\(\[product\], courier\)\?\.id !== product\.id/, "Public catalog should filter the Courier product.");

assert.match(appSource, /<span>Courier<\/span>|<span>Courier<\/span>|courierAmount/, "Admin UI should expose courier settings.");
assert.match(appSource, /class="cart-line system-line"/, "Customer cart should show the required courier charge.");
assert.doesNotMatch(appSource, /data-remove=.*courier/i, "Customer UI must not render a remove action for courier.");

console.log("courier charge source checks passed");
