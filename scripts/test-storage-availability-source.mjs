import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const serverSource = await readFile(path.resolve(import.meta.dirname, "..", "server.js"), "utf8");

assert.match(serverSource, /\/api\/internal\/storage-availability/, "Online Portal should read Retail Shark storage availability.");
assert.match(serverSource, /function mergeStorageAvailability/, "Online Portal should merge Shark storage availability into catalog products.");
assert.match(serverSource, /officeAvailableQuantity:\s*hasQuantity \? Math\.max\(0, inventoryQuantity\) : null/, "Online Portal should preserve Office stock separately.");
assert.match(serverSource, /availableQuantity:\s*Number\.isFinite\(product\.variant\.availableQuantity\)\s*\?\s*officeQuantity \+ storageQuantity\s*:\s*storageQuantity/, "Storage stock should increase server-side cart availability.");
assert.match(serverSource, /inStock:\s*product\.variant\.inStock \|\| storageQuantity > 0/, "Storage stock should make a product customer-visible as in stock.");
assert.match(serverSource, /storageBackedQuantity/, "Storage-backed order quantities should be tagged internally.");
assert.match(serverSource, /storage_pending/, "Storage-backed paid orders should require a staff transfer before automatic Shopify sync.");
assert.match(serverSource, /function checkStorageTransfer/, "Staff should have a stock-transfer check before storage-backed orders continue.");
assert.match(serverSource, /\/check-stock-transfer/, "Online Portal should expose a dedicated stock-transfer check endpoint.");
assert.match(serverSource, /findOfficeShortfalls\(officeFulfillmentItems\(order\), stock\.rows\)/, "Every Office allocation should be checked against current Office availability.");
assert.match(serverSource, /return officeFulfillmentItems\(order\);/, "Shopify order lines should respect the approved Office split.");
assert.match(serverSource, /if \(req\.method === "GET" && adminStockMatch\) \{\s*requireAdmin\(req\);/, "The order stock snapshot must be admin-only.");
assert.match(serverSource, /complete stock transfer and Shopify processing before it can be marked as shipped/, "Storage-backed orders should not be marked shipped before processing completes.");

const publicProductBlock = serverSource.match(/function publicCatalogProduct\(product\) \{[\s\S]*?\n\}/)?.[0] || "";
assert.ok(publicProductBlock.includes("inStock: product.variant.inStock"), "Public catalog should expose only in/out stock status.");
assert.ok(!publicProductBlock.includes("availableQuantity"), "Public catalog must not expose exact availability quantity.");
assert.ok(!publicProductBlock.includes("storageQuantity"), "Public catalog must not expose exact storage quantity.");

const publicOrderItemsBlock = serverSource.match(/function publicOrderItems\(items = \[\]\) \{[\s\S]*?\n\}/)?.[0] || "";
assert.ok(publicOrderItemsBlock, "Public orders should pass through a dedicated item presenter.");
assert.ok(!publicOrderItemsBlock.includes("storageBackedQuantity"), "Customer order payloads must not expose storage allocation markers.");

console.log("storage availability source checks passed");
