import assert from "node:assert/strict";
import { findOfficeShortfalls } from "../lib/fulfillment-stock.mjs";

const rows = [
  { variantId: "a", officeAvailable: 3, officeOnHand: 4, storageOnHand: 5 },
  { variantId: "b", officeAvailable: 0, officeOnHand: 0, storageOnHand: 10 },
];

assert.deepEqual(findOfficeShortfalls([{ variantId: "a", productTitle: "A", quantity: 3 }], rows), []);
assert.deepEqual(findOfficeShortfalls([{ variantId: "a", productTitle: "A", quantity: 8 }], rows), [
  { productTitle: "A", required: 8, officeAvailable: 3 },
]);
assert.deepEqual(findOfficeShortfalls([{ variantId: "b", productTitle: "B", quantity: 2 }], rows), [
  { productTitle: "B", required: 2, officeAvailable: 0 },
]);
assert.throws(() => findOfficeShortfalls([{ variantId: "missing", productTitle: "Missing", quantity: 1 }], rows), /could not be verified/);
assert.throws(() => findOfficeShortfalls([{ variantId: "a", productTitle: "A", quantity: 1 }], [{ variantId: "a", officeAvailable: null }]), /could not be verified/);

console.log("fulfillment stock checks passed");
