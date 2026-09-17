import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const proofsDir = path.join(dataDir, "proofs");
const productImagesDir = path.join(publicDir, "product-images");
const ordersPath = path.join(dataDir, "orders.json");
const usersPath = path.join(dataDir, "users.json");
const shopSettingsPath = path.join(dataDir, "shop-settings.json");

const env = loadDotEnv(path.join(__dirname, ".env"));
const port = Number(process.env.PORT || env.PORT || 3141);
const isProduction = process.env.NETLIFY || process.env.NODE_ENV === "production";
const shopifyStoreSubdomain = process.env.SHOPIFY_STORE_SUBDOMAIN || env.SHOPIFY_STORE_SUBDOMAIN || "";
const shopifyApiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || env.SHOPIFY_ADMIN_API_VERSION || "2026-07";
const shopifyToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || env.SHOPIFY_ADMIN_ACCESS_TOKEN || "";
const shopifyClientId = process.env.SHOPIFY_APP_CLIENT_ID || env.SHOPIFY_APP_CLIENT_ID || "";
const shopifyClientSecret = process.env.SHOPIFY_APP_CLIENT_SECRET || env.SHOPIFY_APP_CLIENT_SECRET || "";
const shopifyOrderSyncEnabled = boolEnv(process.env.SHOPIFY_ORDER_SYNC_ENABLED || env.SHOPIFY_ORDER_SYNC_ENABLED);
const shopifyOrderInventoryBehaviour =
  process.env.SHOPIFY_ORDER_INVENTORY_BEHAVIOUR || env.SHOPIFY_ORDER_INVENTORY_BEHAVIOUR || "DECREMENT_OBEYING_POLICY";
const shopifyOrderSendReceipt = boolEnv(process.env.SHOPIFY_ORDER_SEND_RECEIPT || env.SHOPIFY_ORDER_SEND_RECEIPT);
const internalToken = process.env.INTERNAL_API_TOKEN || env.INTERNAL_API_TOKEN || "dev-internal-token";
const adminUsername = process.env.ADMIN_USERNAME || env.ADMIN_USERNAME || "admin";
const adminPassword = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD || "admin";
const sessionSecret = process.env.SESSION_SECRET || env.SESSION_SECRET || "dev-session-secret-change-before-hosting";
const sessionCookieName = "op_session";
const sessionMaxAge = 60 * 60 * 24 * 7;
const maxJsonBodyBytes = Number(process.env.MAX_JSON_BODY_BYTES || env.MAX_JSON_BODY_BYTES || 7_000_000);
const proofStorageMode = process.env.PROOF_STORAGE_MODE || env.PROOF_STORAGE_MODE || (isProduction ? "blobs" : "local");
const proofBlobStoreName = process.env.PROOF_BLOB_STORE || env.PROOF_BLOB_STORE || "op-payment-proofs";
const retailSharkInternalUrl = process.env.RETAIL_SHARK_INTERNAL_URL || env.RETAIL_SHARK_INTERNAL_URL || "";
const retailSharkInternalToken = process.env.RETAIL_SHARK_INTERNAL_TOKEN || env.RETAIL_SHARK_INTERNAL_TOKEN || "";

let shopifyClientCredentialsToken = null;

validateRuntimeConfig();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

const catalogGroups = [
  {
    id: "injectable-oils",
    label: "Injectable Oils",
    tokens: ["inject", "injectable oils", "injectable oil", "injectables", "oil based", "oil"],
  },
  {
    id: "peptides",
    label: "Peptides",
    tokens: ["peptide", "peptides", "vial", "vials", "reta", "tirz", "bpc", "tb-500", "ghk", "cagri", "mots"],
  },
  {
    id: "pens",
    label: "Pens",
    tokens: ["pen", "pens", "kwikpen", "mounjaro", "ozempic"],
  },
  {
    id: "orals",
    label: "Orals",
    tokens: ["oral", "orals", "tablet", "tablets", "caps", "capsules", "tabs"],
  },
  {
    id: "support",
    label: "Support",
    tokens: ["support", "ancillary", "ancillaries", "pct", "ai", "wellness"],
  },
];

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const result = {};
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals < 0) continue;
    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim().replace(/^["']|["']$/g, "");
    result[key] = value;
  }
  return result;
}

function boolEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function validateRuntimeConfig() {
  if (!isProduction) return;
  const missing = [];
  if (!sessionSecret || sessionSecret === "dev-session-secret-change-before-hosting") missing.push("SESSION_SECRET");
  if (!internalToken || internalToken === "dev-internal-token") missing.push("INTERNAL_API_TOKEN");
  if (!adminPassword || adminPassword === "admin") missing.push("ADMIN_PASSWORD");
  if ((shopifyToken || shopifyClientId || shopifyClientSecret) && !shopifyStoreSubdomain) missing.push("SHOPIFY_STORE_SUBDOMAIN");
  if (missing.length) {
    throw new Error(`Online Portal production config is not safe. Set: ${missing.join(", ")}`);
  }
}

function json(res, status, payload, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    vary: "Cookie",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function text(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
  res.end(body);
}

function cookieHeader(name, value, maxAge) {
  const secure = isProduction ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function cookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function sessionFromRequest(req) {
  const token = cookies(req)[sessionCookieName];
  if (!token) return null;
  return verifySessionToken(token);
}

function createSession(payload) {
  const now = Date.now();
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      iat: now,
      exp: now + sessionMaxAge * 1000,
    }),
  ).toString("base64url");
  const signature = signSessionBody(body);
  return cookieHeader(sessionCookieName, encodeURIComponent(`${body}.${signature}`), sessionMaxAge);
}

function clearSession() {
  return cookieHeader(sessionCookieName, "", 0);
}

function signSessionBody(body) {
  return createHmac("sha256", sessionSecret).update(body).digest("base64url");
}

function verifySessionToken(token) {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature) return null;
  const expected = signSessionBody(body);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxJsonBodyBytes) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("Invalid JSON body."), { status: 400 });
  }
}

async function readOrdersData() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(ordersPath)) return { version: 1, updatedAt: null, orders: [] };
  const data = JSON.parse(await readFile(ordersPath, "utf8"));
  return { version: 1, updatedAt: data.updatedAt || null, orders: Array.isArray(data.orders) ? data.orders : [] };
}

async function writeOrdersData(data) {
  await mkdir(dataDir, { recursive: true });
  const payload = { version: 1, updatedAt: new Date().toISOString(), orders: data.orders || [] };
  await writeFile(ordersPath, JSON.stringify(payload, null, 2));
  return payload;
}

async function readUsersData() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(usersPath)) {
    const seeded = {
      version: 1,
      updatedAt: new Date().toISOString(),
      users: [demoUser(), demoAdmin()],
    };
    await writeFile(usersPath, JSON.stringify(seeded, null, 2));
    return seeded;
  }
  const data = JSON.parse(await readFile(usersPath, "utf8"));
  const normalized = normalizeUsersData(data);
  if (normalized.changed) await writeUsersData(normalized);
  return normalized;
}

async function writeUsersData(data) {
  await mkdir(dataDir, { recursive: true });
  const normalized = normalizeUsersData(data);
  const payload = { version: 1, updatedAt: new Date().toISOString(), users: normalized.users || [] };
  await writeFile(usersPath, JSON.stringify(payload, null, 2));
  return payload;
}

function normalizeUsersData(data = {}) {
  let changed = false;
  const inputUsers = Array.isArray(data.users) ? data.users : [];
  const users = inputUsers.map((user) => {
    const normalized = normalizeStoredUser(user);
    if (JSON.stringify(normalized) !== JSON.stringify(user)) changed = true;
    return normalized;
  });
  if (!users.some((user) => user.role === "admin")) {
    users.push(demoAdmin());
    changed = true;
  }
  return {
    version: 1,
    updatedAt: data.updatedAt || null,
    users,
    changed,
  };
}

function normalizeStoredUser(user = {}) {
  const role = user.role === "admin" ? "admin" : "customer";
  const phoneArea = cleanText(user.phoneArea || "+27", 12);
  const phoneNumber = normalizePhoneNumber(user.phoneNumber || "");
  const storedPhone = cleanText(user.phone, 80);
  const existingDefaultAddress = normalizeAddress(user.defaultAddress);
  const addresses = normalizeAddressList(user.addresses, existingDefaultAddress, role);
  return {
    ...user,
    role,
    username: cleanText(user.username, 80).toLowerCase(),
    email: cleanText(user.email, 180).toLowerCase(),
    name: cleanText(user.name || user.username || "Account", 120),
    phoneArea,
    phoneNumber,
    phone: storedPhone && storedPhone !== phoneArea ? storedPhone : phoneNumber ? `${phoneArea} ${phoneNumber}`.trim() : "",
    defaultAddress: defaultAddressFromList(addresses, existingDefaultAddress),
    addresses,
    preferences: normalizeCustomerPreferences(user.preferences),
  };
}

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
      accountName: process.env.BANK_ACCOUNT_NAME || env.BANK_ACCOUNT_NAME || "Tank Nutrition",
      bankName: process.env.BANK_NAME || env.BANK_NAME || "",
      accountNumber: process.env.BANK_ACCOUNT_NUMBER || env.BANK_ACCOUNT_NUMBER || "",
      branchCode: process.env.BANK_BRANCH_CODE || env.BANK_BRANCH_CODE || "",
      note: "Once POP has been uploaded, the order will be verified and tracking details will follow.",
    },
    references: {
      standardFormat: "OP-{YYYY}{MM}{DD}-{RAND4}",
      specialFormat: "SO-{YYYY}{MM}{DD}-{RAND4}",
    },
  };
}

function normalizeShopSettings(input = {}) {
  const featured = input.featured || input;
  const payment = input.payment || {};
  const references = input.references || {};
  const defaults = defaultShopSettings();
  const mode = cleanText(featured.mode, 20) === "custom" ? "custom" : "collection";
  const customProductIds = Array.isArray(featured.customProductIds)
    ? featured.customProductIds.map((id) => cleanText(id, 180)).filter(Boolean).slice(0, 24)
    : [];
  return {
    featured: {
      mode,
      title: cleanText(featured.title || "Featured Dex", 80),
      subtitle: cleanText(featured.subtitle || "Fast access to the products customers ask for most.", 180),
      collectionQuery: cleanText(featured.collectionQuery || "Dex", 80),
      customProductIds,
    },
    payment: {
      accountName: cleanText(payment.accountName || defaults.payment.accountName, 120),
      bankName: cleanText(payment.bankName || defaults.payment.bankName, 120),
      accountNumber: cleanText(payment.accountNumber || defaults.payment.accountNumber, 80),
      branchCode: cleanText(payment.branchCode || defaults.payment.branchCode, 80),
      note: cleanText(payment.note || defaults.payment.note, 500),
    },
    references: {
      standardFormat: normalizeReferenceFormat(references.standardFormat || defaults.references.standardFormat, defaults.references.standardFormat),
      specialFormat: normalizeReferenceFormat(references.specialFormat || defaults.references.specialFormat, defaults.references.specialFormat),
    },
  };
}

async function readShopSettingsData() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(shopSettingsPath)) return { version: 1, updatedAt: null, settings: defaultShopSettings() };
  const data = JSON.parse(await readFile(shopSettingsPath, "utf8"));
  return { version: 1, updatedAt: data.updatedAt || null, settings: normalizeShopSettings(data.settings || data) };
}

async function writeShopSettingsData(settings) {
  await mkdir(dataDir, { recursive: true });
  const payload = { version: 1, updatedAt: new Date().toISOString(), settings: normalizeShopSettings(settings) };
  await writeFile(shopSettingsPath, JSON.stringify(payload, null, 2));
  return payload;
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function demoUser() {
  return {
    id: "demo-user",
    role: "customer",
    username: "user",
    name: "Test Customer",
    email: "user@example.com",
    phoneArea: "+27",
    phoneNumber: "82 123 4567",
    phone: "+27 82 123 4567",
    defaultAddress: {
      line1: "1 Test Road",
      line2: "",
      suburb: "Menlyn",
      city: "Pretoria",
      province: "Gauteng",
      postalCode: "0001",
      country: "South Africa",
    },
    addresses: [
      {
        id: "demo-user-address",
        label: "Main address",
        line1: "1 Test Road",
        line2: "",
        suburb: "Menlyn",
        city: "Pretoria",
        province: "Gauteng",
        postalCode: "0001",
        country: "South Africa",
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    preferences: { theme: "light" },
    passwordHash: hashPassword("user"),
    createdAt: new Date().toISOString(),
  };
}

function demoAdmin() {
  return {
    id: "demo-admin",
    role: "admin",
    username: adminUsername.toLowerCase(),
    name: "Admin",
    email: "admin@example.com",
    phoneArea: "+27",
    phoneNumber: "",
    phone: "",
    defaultAddress: emptyAddress(),
    addresses: [],
    preferences: { theme: "light" },
    passwordHash: hashPassword(adminPassword),
    createdAt: new Date().toISOString(),
  };
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const actual = Buffer.from(hashPassword(password, salt).split(":")[1], "hex");
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isInsideDirectory(filePath, directory) {
  const relative = path.relative(directory, filePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    role: user.role === "admin" ? "admin" : "customer",
    username: user.username || "",
    name: user.name,
    email: user.email,
    phone: user.phone || "",
    phoneArea: user.phoneArea || "+27",
    phoneNumber: user.phoneNumber || "",
    defaultAddress: normalizeAddress(user.defaultAddress),
    addresses: normalizeAddressList(user.addresses, user.defaultAddress, user.role),
    preferences: normalizeCustomerPreferences(user.preferences),
  };
}

function publicAdmin(user) {
  if (!user) return null;
  return {
    id: user.id,
    role: "admin",
    username: user.username || adminUsername,
    name: user.name || "Admin",
    email: user.email || "",
    preferences: normalizeCustomerPreferences(user.preferences),
  };
}

function publicAccount(user) {
  return {
    ...publicUser(user),
    createdAt: user.createdAt || null,
  };
}

function normalizeCustomerPreferences(input = {}) {
  return {
    theme: input.theme === "dark" ? "dark" : "light",
  };
}

async function registerCustomer(input) {
  const data = await readUsersData();
  const username = cleanText(input.username, 80).toLowerCase();
  const email = cleanText(input.email, 180).toLowerCase();
  const name = cleanText(input.name, 120);
  const phoneArea = cleanText(input.phoneArea || "+27", 12);
  const phoneNumber = normalizePhoneNumber(input.phoneNumber);
  const phone = `${phoneArea} ${phoneNumber}`.trim();
  const defaultAddress = normalizeAddress(input.defaultAddress);
  const password = String(input.password || "");
  if (!username) throw Object.assign(new Error("Username is required."), { status: 400 });
  if (!name) throw Object.assign(new Error("Name is required."), { status: 400 });
  if (!email || !email.includes("@")) throw Object.assign(new Error("Use a valid email address."), { status: 400 });
  if (!phoneNumber) throw Object.assign(new Error("Phone number is required."), { status: 400 });
  if (!addressComplete(defaultAddress)) throw Object.assign(new Error("Complete the required delivery address fields."), { status: 400 });
  if (password.length < 4) throw Object.assign(new Error("Use at least 4 characters for now."), { status: 400 });
  if (data.users.some((user) => user.username === username || user.email === email)) {
    throw Object.assign(new Error("An account already exists for this username or email."), { status: 409 });
  }
  const user = {
    id: randomUUID(),
    role: "customer",
    username,
    name,
    email,
    phoneArea,
    phoneNumber,
    phone,
    defaultAddress,
    addresses: [addressRecord({ ...defaultAddress, label: "Main address", isDefault: true })],
    preferences: { theme: "light" },
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  data.users.push(user);
  await writeUsersData(data);
  return user;
}

async function updateAccountPreferences(input, session) {
  const data = await readUsersData();
  const user = data.users.find((entry) => entry.id === session.userId);
  if (!user) throw Object.assign(new Error("Please log in again."), { status: 401 });
  user.preferences = normalizeCustomerPreferences({ ...user.preferences, ...input });
  await writeUsersData(data);
  return user;
}

async function saveCustomerAddress(currentUser, input, addressId = "") {
  const data = await readUsersData();
  const user = data.users.find((entry) => entry.id === currentUser.id && entry.role !== "admin");
  if (!user) throw Object.assign(new Error("Please log in again."), { status: 401 });
  user.addresses = normalizeAddressList(user.addresses, user.defaultAddress, user.role);
  const existing = addressId ? user.addresses.find((address) => address.id === addressId) : null;
  if (addressId && !existing) throw Object.assign(new Error("Delivery address not found."), { status: 404 });
  const nextAddress = addressRecord(input, existing || {}, { touch: true });
  if (!addressComplete(nextAddress)) throw Object.assign(new Error("Complete the required delivery address fields."), { status: 400 });
  const shouldDefault = Boolean(input.isDefault) || user.addresses.length === 0;
  if (shouldDefault) user.addresses.forEach((address) => (address.isDefault = false));
  nextAddress.isDefault = shouldDefault || Boolean(existing?.isDefault);
  if (existing) {
    user.addresses = user.addresses.map((address) => (address.id === existing.id ? nextAddress : address));
  } else {
    user.addresses.push(nextAddress);
  }
  if (!user.addresses.some((address) => address.isDefault)) user.addresses[0].isDefault = true;
  user.defaultAddress = defaultAddressFromList(user.addresses);
  await writeUsersData(data);
  return { user, address: nextAddress };
}

async function setDefaultCustomerAddress(currentUser, addressId) {
  const data = await readUsersData();
  const user = data.users.find((entry) => entry.id === currentUser.id && entry.role !== "admin");
  if (!user) throw Object.assign(new Error("Please log in again."), { status: 401 });
  user.addresses = normalizeAddressList(user.addresses, user.defaultAddress, user.role);
  const target = user.addresses.find((address) => address.id === addressId);
  if (!target) throw Object.assign(new Error("Delivery address not found."), { status: 404 });
  user.addresses.forEach((address) => {
    address.isDefault = address.id === target.id;
    if (address.isDefault) address.updatedAt = new Date().toISOString();
  });
  user.defaultAddress = defaultAddressFromList(user.addresses);
  await writeUsersData(data);
  return { user, address: target };
}

async function removeCustomerAddress(currentUser, addressId) {
  const data = await readUsersData();
  const user = data.users.find((entry) => entry.id === currentUser.id && entry.role !== "admin");
  if (!user) throw Object.assign(new Error("Please log in again."), { status: 401 });
  user.addresses = normalizeAddressList(user.addresses, user.defaultAddress, user.role);
  if (user.addresses.length <= 1) throw Object.assign(new Error("Keep at least one valid delivery address."), { status: 409 });
  const target = user.addresses.find((address) => address.id === addressId);
  if (!target) throw Object.assign(new Error("Delivery address not found."), { status: 404 });
  user.addresses = user.addresses.filter((address) => address.id !== target.id);
  if (!user.addresses.some((address) => address.isDefault)) user.addresses[0].isDefault = true;
  user.defaultAddress = defaultAddressFromList(user.addresses);
  await writeUsersData(data);
  return { user, address: target };
}

async function loginCustomer(input) {
  const data = await readUsersData();
  const login = cleanText(input.login || input.username || input.email, 180).toLowerCase();
  const user = data.users.find((entry) => (entry.username === login || entry.email === login) && entry.role !== "admin");
  if (!user || !verifyPassword(input.password, user.passwordHash)) {
    throw Object.assign(new Error("Username or password is incorrect."), { status: 401 });
  }
  return user;
}

async function loginAdmin(input) {
  const data = await readUsersData();
  const login = cleanText(input.login || input.username || input.email, 180).toLowerCase();
  const admin = data.users.find((entry) => entry.role === "admin" && (entry.username === login || entry.email === login));
  if (admin && verifyPassword(input.password, admin.passwordHash)) return admin;
  throw Object.assign(new Error("Admin username or password is incorrect."), { status: 401 });
}

async function requireCustomer(req) {
  const session = sessionFromRequest(req);
  if (!session || session.kind !== "customer") throw Object.assign(new Error("Please log in first."), { status: 401 });
  const data = await readUsersData();
  const user = data.users.find((entry) => entry.id === session.userId);
  if (!user) throw Object.assign(new Error("Please log in again."), { status: 401 });
  return user;
}

async function requirePortalAccess(req) {
  const session = sessionFromRequest(req);
  if (!session) throw Object.assign(new Error("Please log in first."), { status: 401 });
  if (session.kind === "admin") return { kind: "admin", username: session.username, userId: session.userId };
  const user = await requireCustomer(req);
  return { kind: "customer", user };
}

function requireAdmin(req) {
  const session = sessionFromRequest(req);
  if (!session || session.kind !== "admin") throw Object.assign(new Error("Admin login is required."), { status: 401 });
  return { username: session.username, userId: session.userId };
}

async function listAccounts() {
  const data = await readUsersData();
  return data.users.map(publicAccount).sort((a, b) => {
    if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
    return String(a.name || a.username).localeCompare(String(b.name || b.username));
  });
}

async function createAccountByAdmin(input) {
  const data = await readUsersData();
  const role = input.role === "admin" ? "admin" : "customer";
  const username = cleanText(input.username, 80).toLowerCase();
  const email = role === "admin" ? cleanText(input.email || `${username}@admin.local`, 180).toLowerCase() : cleanText(input.email, 180).toLowerCase();
  const name = cleanText(input.name, 120);
  const phoneArea = cleanText(input.phoneArea || "+27", 12);
  const phoneNumber = normalizePhoneNumber(input.phoneNumber);
  const phone = `${phoneArea} ${phoneNumber}`.trim();
  const defaultAddress = normalizeAddress(input.defaultAddress);
  const password = String(input.password || "");
  if (!username) throw Object.assign(new Error("Username is required."), { status: 400 });
  if (!name) throw Object.assign(new Error("Name is required."), { status: 400 });
  if (role === "customer" && (!email || !email.includes("@"))) throw Object.assign(new Error("Use a valid email address."), { status: 400 });
  if (role === "customer" && !phoneNumber) throw Object.assign(new Error("Customer phone number is required."), { status: 400 });
  if (role === "customer" && !addressComplete(defaultAddress)) {
    throw Object.assign(new Error("Customer delivery address is required."), { status: 400 });
  }
  if (password.length < 4) throw Object.assign(new Error("Use at least 4 characters for now."), { status: 400 });
  if (data.users.some((user) => user.username === username || user.email === email)) {
    throw Object.assign(new Error("An account already exists for this username or email."), { status: 409 });
  }
  const user = {
    id: randomUUID(),
    role,
    username,
    name,
    email,
    phoneArea,
    phoneNumber,
    phone,
    defaultAddress,
    addresses: role === "customer" ? [addressRecord({ ...defaultAddress, label: "Main address", isDefault: true })] : [],
    preferences: { theme: "light" },
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  data.users.push(user);
  await writeUsersData(data);
  return user;
}

async function updateAccountByAdmin(accountId, input, admin) {
  const data = await readUsersData();
  const actor = data.users.find((user) => user.id === admin.userId && user.role === "admin");
  if (!actor) throw Object.assign(new Error("Admin login is required."), { status: 401 });
  const target = data.users.find((user) => user.id === accountId);
  if (!target) throw Object.assign(new Error("Account not found."), { status: 404 });
  if (target.role !== "admin") throw Object.assign(new Error("Only admin accounts can be edited here for now."), { status: 409 });
  const username = cleanText(input.username, 80).toLowerCase();
  const name = cleanText(input.name, 120);
  const password = String(input.password || "");
  if (!username) throw Object.assign(new Error("Username is required."), { status: 400 });
  if (!name) throw Object.assign(new Error("Name is required."), { status: 400 });
  if (password && password.length < 4) throw Object.assign(new Error("Use at least 4 characters for the password."), { status: 400 });
  if (data.users.some((user) => user.id !== target.id && user.username === username)) {
    throw Object.assign(new Error("An account already exists for this username."), { status: 409 });
  }
  target.username = username;
  target.name = name;
  target.email = cleanText(input.email || target.email || `${username}@admin.local`, 180).toLowerCase();
  if (password) target.passwordHash = hashPassword(password);
  target.updatedAt = new Date().toISOString();
  await writeUsersData(data);
  return target;
}

async function removeAccountByAdmin(accountId, input, admin) {
  const data = await readUsersData();
  const actor = data.users.find((user) => user.id === admin.userId && user.role === "admin");
  if (!actor || !verifyPassword(input.password, actor.passwordHash)) {
    throw Object.assign(new Error("Admin password confirmation failed."), { status: 401 });
  }
  const target = data.users.find((user) => user.id === accountId);
  if (!target) throw Object.assign(new Error("Account not found."), { status: 404 });
  if (target.id === actor.id) throw Object.assign(new Error("You cannot remove the admin account you are signed in with."), { status: 409 });
  if (target.role === "admin" && data.users.filter((user) => user.role === "admin").length <= 1) {
    throw Object.assign(new Error("At least one admin account must remain."), { status: 409 });
  }
  data.users = data.users.filter((user) => user.id !== target.id);
  await writeUsersData(data);
  return target;
}

function money(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100) / 100;
}

function cleanText(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function normalizeReferenceFormat(value, fallback) {
  const cleaned = cleanText(value, 80).replace(/[^A-Za-z0-9{}_\-]+/g, "");
  return cleaned.includes("{RAND") ? cleaned : fallback;
}

function normalizePhoneNumber(value) {
  return String(value || "").replace(/[^\d ]+/g, "").replace(/\s+/g, " ").trim().slice(0, 24);
}

function emptyAddress() {
  return {
    line1: "",
    line2: "",
    suburb: "",
    city: "",
    province: "",
    postalCode: "",
    country: "South Africa",
  };
}

function normalizeAddress(value) {
  if (typeof value === "string") return { ...emptyAddress(), line1: cleanText(value, 180) };
  const input = value || {};
  return {
    line1: cleanText(input.line1, 180),
    line2: cleanText(input.line2, 180),
    suburb: cleanText(input.suburb, 120),
    city: cleanText(input.city, 120),
    province: cleanText(input.province, 120),
    postalCode: cleanText(input.postalCode, 16).replace(/[^\dA-Za-z -]+/g, ""),
    country: cleanText(input.country || "South Africa", 80),
  };
}

function addressComplete(address) {
  return Boolean(address.line1 && address.suburb && address.city && address.province && address.postalCode);
}

function addressRecord(input = {}, existing = {}, options = {}) {
  const now = new Date().toISOString();
  const address = normalizeAddress(input);
  return {
    id: cleanText(existing.id || input.id, 120) || randomUUID(),
    label: cleanText(input.label || existing.label || "Delivery address", 80),
    ...address,
    isDefault: Boolean(input.isDefault ?? existing.isDefault),
    createdAt: existing.createdAt || input.createdAt || now,
    updatedAt: options.touch ? now : existing.updatedAt || input.updatedAt || now,
  };
}

function normalizeAddressList(addresses, defaultAddress, role = "customer") {
  const list = (Array.isArray(addresses) ? addresses : [])
    .map((address) => addressRecord(address, address))
    .filter(addressComplete);
  const normalizedDefault = normalizeAddress(defaultAddress);
  if (role !== "admin" && addressComplete(normalizedDefault) && !list.some((address) => sameAddress(address, normalizedDefault))) {
    list.unshift(addressRecord({ ...normalizedDefault, label: "Main address", isDefault: true }));
  }
  if (list.length && !list.some((address) => address.isDefault)) list[0].isDefault = true;
  if (list.filter((address) => address.isDefault).length > 1) {
    let foundDefault = false;
    for (const address of list) {
      if (!address.isDefault) continue;
      if (!foundDefault) foundDefault = true;
      else address.isDefault = false;
    }
  }
  return list;
}

function defaultAddressFromList(addresses, fallback = emptyAddress()) {
  return normalizeAddress((addresses || []).find((address) => address.isDefault) || addresses?.[0] || fallback);
}

function sameAddress(a, b) {
  return ["line1", "line2", "suburb", "city", "province", "postalCode", "country"].every(
    (key) => cleanText(a?.[key], 180).toLowerCase() === cleanText(b?.[key], 180).toLowerCase(),
  );
}

function formatAddress(address) {
  return [address.line1, address.line2, address.suburb, address.city, address.province, address.postalCode, address.country].filter(Boolean).join(", ");
}

function publicOrder(order) {
  const readyForPayment = specialOrderReadyForPayment(order);
  return {
    id: order.id,
    reference: order.reference,
    customer: order.customer,
    items: order.items,
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    total: order.total,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    specialOrder: order.specialOrder || null,
    customerStatus: customerStatus(order),
    proof: order.proof ? { filename: order.proof.filename, uploadedAt: order.proof.uploadedAt } : null,
    canUploadProof: order.paymentStatus !== "confirmed" && readyForPayment,
    tracking: order.tracking || null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

function specialOrderReadyForPayment(order) {
  return !order.specialOrder || ["accepted", "countered"].includes(order.specialOrder.status);
}

function staffOrder(order) {
  return {
    ...publicOrder(order),
    delivery: order.delivery,
    staffNotes: order.staffNotes || "",
    paymentConfirmedAt: order.paymentConfirmedAt || null,
    paymentConfirmedBy: order.paymentConfirmedBy || null,
    backOrderReason: order.backOrderReason || "",
    shopifyOrder: order.shopifyOrder || null,
    shopifySync: order.shopifySync || { status: "not_started", message: "" },
  };
}

function customerStatus(order) {
  if (order.specialOrder?.status === "pending") return "Special order review";
  if (order.specialOrder?.status === "declined") return "Special order declined";
  if (order.specialOrder?.status === "countered") return "Special order countered";
  if (order.fulfillmentStatus === "shipped") return "Shipped";
  if (order.fulfillmentStatus === "back_order") return "Not ready";
  if (order.paymentStatus === "confirmed") return "Payment confirmed";
  return "Payment pending";
}

function orderReadyForRetailShark(order) {
  if (order.paymentStatus !== "confirmed" || order.fulfillmentStatus === "shipped") return false;
  if (!shopifyOrderSyncEnabled) return true;
  return Boolean(order.shopifyOrder?.id);
}

function orderCompletedForRetailShark(order) {
  return order.paymentStatus === "confirmed" && order.fulfillmentStatus === "shipped";
}

async function buildReference(kind = "standard") {
  const settings = (await readShopSettingsData()).settings;
  const template = kind === "special" ? settings.references.specialFormat : settings.references.standardFormat;
  return formatReference(template);
}

function formatReference(template) {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const date = new Date();
  const rand4 = String(Math.floor(1000 + Math.random() * 9000));
  return String(template || "OP-{YYYY}{MM}{DD}-{RAND4}")
    .replaceAll("{YYYY}", String(date.getFullYear()))
    .replaceAll("{YY}", String(date.getFullYear()).slice(-2))
    .replaceAll("{MM}", String(date.getMonth() + 1).padStart(2, "0"))
    .replaceAll("{DD}", String(date.getDate()).padStart(2, "0"))
    .replaceAll("{DATE}", day)
    .replaceAll("{RAND4}", rand4);
}

async function validateOrderRequest(input, user, options = {}) {
  const customer = {
    id: user.id,
    username: user.username || "",
    name: user.name,
    email: user.email,
    phone: user.phone || "",
  };
  const savedAddresses = normalizeAddressList(user.addresses, user.defaultAddress, user.role);
  const requestedAddressId = cleanText(input.delivery?.addressId, 120);
  const savedAddress = requestedAddressId ? savedAddresses.find((address) => address.id === requestedAddressId) : null;
  const address = normalizeAddress(savedAddress || input.delivery?.address || user.defaultAddress);
  if (!addressComplete(address)) throw new Error("Complete the required delivery address fields.");
  const delivery = {
    method: cleanText(input.delivery?.method || "Courier", 80),
    address,
    addressText: formatAddress(address),
    notes: cleanText(input.delivery?.notes, 500),
  };
  const allowSpecial = Boolean(options.allowSpecial);
  const catalog = await catalogProducts();
  const items = validateCartItems(input.items, catalog.products, { allowSpecial });
  if (!items.length) throw new Error("Add at least one product to the order.");
  const subtotal = money(items.reduce((sum, item) => sum + item.price * item.quantity, 0));
  const deliveryFee = money(input.deliveryFee || 0);
  return { customer, delivery, items, subtotal, deliveryFee, total: money(subtotal + deliveryFee) };
}

function validateCartItems(inputItems, catalogProducts, options = {}) {
  const allowSpecial = Boolean(options.allowSpecial);
  const catalogByVariant = new Map();
  for (const product of catalogProducts) {
    if (product.variant?.id) catalogByVariant.set(product.variant.id, product);
  }
  const items = (Array.isArray(inputItems) ? inputItems : [])
    .map((item) => {
      const variantId = cleanText(item.variantId, 160);
      const product = catalogByVariant.get(variantId);
      const quantity = Math.max(0, Math.floor(Number(item.quantity || 0)));
      if (!product || !product.variant) return null;
      if (quantity <= 0) return null;
      if (!allowSpecial) assertQuantityAvailable(product, quantity);
      return {
        variantId,
        productTitle: product.title,
        variantTitle: product.variant.title || "Default Title",
        sku: product.variant.sku,
        quantity,
        price: money(product.variant.price),
      };
    })
    .filter(Boolean);
  if (!items.length) throw Object.assign(new Error("Add at least one product to the order."), { status: 400 });
  return items;
}

function assertQuantityAvailable(product, quantity) {
  const variant = product.variant;
  if (!variant?.inStock) throw Object.assign(new Error(`${product.title} is out of stock.`), { status: 409 });
  if (Number.isFinite(variant.availableQuantity) && quantity > variant.availableQuantity) {
    throw Object.assign(new Error(`${product.title} exceeds current availability. Use a special order request for larger quantities.`), { status: 409 });
  }
}

async function createOrder(input, user) {
  const now = new Date().toISOString();
  const data = await readOrdersData();
  const isSpecialOrder = Boolean(input.specialOrder);
  const request = await validateOrderRequest(input, user, { allowSpecial: isSpecialOrder });
  const order = {
    id: randomUUID(),
    reference: await buildReference(isSpecialOrder ? "special" : "standard"),
    ...request,
    paymentStatus: "pending",
    fulfillmentStatus: "not_ready",
    tracking: null,
    proof: null,
    specialOrder: isSpecialOrder
      ? {
          status: "pending",
          note: cleanText(input.specialOrderNote, 500),
          requestedAt: now,
          reviewedAt: null,
          reviewedBy: null,
          originalItems: request.items.map((item) => ({ ...item })),
          counterItems: [],
        }
      : null,
    staffNotes: "",
    shopifyOrder: null,
    shopifySync: { status: "not_started", message: "" },
    statusEvents: [{ at: now, actor: "customer", type: "submitted", label: "Order request submitted" }],
    createdAt: now,
    updatedAt: now,
  };
  data.orders.unshift(order);
  await writeOrdersData(data);
  return order;
}

async function uploadProof(orderId, input, user) {
  const data = await readOrdersData();
  const order = data.orders.find((entry) => entry.id === orderId && entry.customer?.id === user.id);
  if (!order) throw Object.assign(new Error("Order not found."), { status: 404 });
  const proof = await storeProofUpload(order, input);
  const now = new Date().toISOString();
  order.proof = proof;
  order.paymentStatus = "pending";
  order.updatedAt = now;
  order.statusEvents.push({ at: now, actor: "customer", type: "proof_uploaded", label: "Proof of payment uploaded" });
  await writeOrdersData(data);
  return order;
}

async function confirmPayment(orderId, input, admin) {
  const data = await readOrdersData();
  const order = data.orders.find((entry) => entry.id === orderId);
  if (!order) throw Object.assign(new Error("Order not found."), { status: 404 });
  if (order.specialOrder?.status === "pending") throw Object.assign(new Error("Review the special order before confirming payment."), { status: 409 });
  if (order.specialOrder?.status === "declined") throw Object.assign(new Error("Declined special orders cannot be confirmed."), { status: 409 });
  const now = new Date().toISOString();
  const wasConfirmed = order.paymentStatus === "confirmed";
  if (!wasConfirmed) {
    order.paymentStatus = "confirmed";
    order.fulfillmentStatus = order.fulfillmentStatus === "back_order" ? "back_order" : "not_ready";
    order.paymentConfirmedAt = now;
    order.paymentConfirmedBy = cleanText(input.confirmedBy || admin.username || "admin", 120);
    order.statusEvents.push({ at: now, actor: "admin", type: "payment_confirmed", label: "Payment confirmed" });
  }
  if (shopifyOrderSyncEnabled && !order.shopifyOrder?.id) {
    await syncOrderToShopify(order, admin, { throwOnError: false });
  } else if (!shopifyOrderSyncEnabled && !order.shopifyOrder?.id) {
    order.shopifySync = {
      status: "disabled",
      message: "Shopify order sync is disabled. Enable SHOPIFY_ORDER_SYNC_ENABLED to create Shopify orders after payment confirmation.",
      attemptedAt: null,
      syncedAt: null,
    };
  }
  order.updatedAt = new Date().toISOString();
  await writeOrdersData(data);
  return order;
}

async function syncConfirmedOrder(orderId, admin) {
  const data = await readOrdersData();
  const order = data.orders.find((entry) => entry.id === orderId);
  if (!order) throw Object.assign(new Error("Order not found."), { status: 404 });
  await syncOrderToShopify(order, admin, { throwOnError: true });
  order.updatedAt = new Date().toISOString();
  await writeOrdersData(data);
  return order;
}

async function reviewSpecialOrder(orderId, input, admin) {
  const data = await readOrdersData();
  const order = data.orders.find((entry) => entry.id === orderId);
  if (!order) throw Object.assign(new Error("Order not found."), { status: 404 });
  if (!order.specialOrder) throw Object.assign(new Error("This is not a special order."), { status: 409 });
  const action = cleanText(input.action, 20);
  const now = new Date().toISOString();
  order.specialOrder.reviewedAt = now;
  order.specialOrder.reviewedBy = admin.username || "admin";
  if (action === "accept") {
    order.specialOrder.status = "accepted";
    order.statusEvents.push({ at: now, actor: "admin", type: "special_order_accepted", label: "Special order approved" });
  } else if (action === "decline") {
    order.specialOrder.status = "declined";
    order.specialOrder.declineReason = cleanText(input.reason, 500);
    order.statusEvents.push({ at: now, actor: "admin", type: "special_order_declined", label: "Special order declined" });
  } else if (action === "counter") {
    const counterItems = counterOrderItems(order.items, input.counterItems);
    order.items = counterItems;
    order.subtotal = money(counterItems.reduce((sum, item) => sum + item.price * item.quantity, 0));
    order.total = money(order.subtotal + money(order.deliveryFee || 0));
    order.specialOrder.status = "countered";
    order.specialOrder.counterItems = counterItems.map((item) => ({ ...item }));
    order.specialOrder.counterNote = cleanText(input.note, 500);
    order.statusEvents.push({ at: now, actor: "admin", type: "special_order_countered", label: "Special order countered" });
  } else {
    throw Object.assign(new Error("Choose a valid special order action."), { status: 400 });
  }
  order.updatedAt = now;
  await writeOrdersData(data);
  return order;
}

function counterOrderItems(currentItems, inputItems) {
  const quantityByVariant = new Map(
    (Array.isArray(inputItems) ? inputItems : []).map((item) => [cleanText(item.variantId, 160), Math.max(0, Math.floor(Number(item.quantity || 0)))]),
  );
  const items = currentItems
    .map((item) => ({ ...item, quantity: quantityByVariant.has(item.variantId) ? quantityByVariant.get(item.variantId) : item.quantity }))
    .filter((item) => item.quantity > 0);
  if (!items.length) throw Object.assign(new Error("Counter with at least one supplied item."), { status: 400 });
  return items;
}

async function updateTracking(orderId, input) {
  const data = await readOrdersData();
  const order = data.orders.find((entry) => entry.id === orderId);
  if (!order) throw Object.assign(new Error("Order not found."), { status: 404 });
  if (order.paymentStatus !== "confirmed") throw Object.assign(new Error("Payment must be confirmed first."), { status: 409 });
  const now = new Date().toISOString();
  order.tracking = {
    courier: cleanText(input.courier, 120),
    number: cleanText(input.number, 180),
    url: cleanText(input.url, 500),
    addedAt: now,
  };
  if (!order.tracking.number) throw new Error("Tracking number is required.");
  order.updatedAt = now;
  order.statusEvents.push({ at: now, actor: "staff", type: "tracking_added", label: "Tracking added" });
  await writeOrdersData(data);
  return order;
}

async function markBackOrder(orderId, input) {
  const data = await readOrdersData();
  const order = data.orders.find((entry) => entry.id === orderId);
  if (!order) throw Object.assign(new Error("Order not found."), { status: 404 });
  const now = new Date().toISOString();
  order.fulfillmentStatus = "back_order";
  order.backOrderReason = cleanText(input.reason, 500);
  order.updatedAt = now;
  order.statusEvents.push({ at: now, actor: "staff", type: "back_order", label: "Sent to back orders" });
  await writeOrdersData(data);
  return order;
}

async function markShipped(orderId) {
  const data = await readOrdersData();
  const order = data.orders.find((entry) => entry.id === orderId);
  if (!order) throw Object.assign(new Error("Order not found."), { status: 404 });
  if (order.paymentStatus !== "confirmed") throw Object.assign(new Error("Payment must be confirmed first."), { status: 409 });
  const now = new Date().toISOString();
  order.fulfillmentStatus = "shipped";
  order.shippedAt = now;
  order.updatedAt = now;
  order.statusEvents.push({ at: now, actor: "staff", type: "shipped", label: "Order shipped" });
  await writeOrdersData(data);
  return order;
}

async function syncOrderToShopify(order, admin, options = {}) {
  const now = new Date().toISOString();
  if (!shopifyOrderSyncEnabled) {
    throw Object.assign(new Error("Shopify order sync is disabled. Set SHOPIFY_ORDER_SYNC_ENABLED=true before retrying."), { status: 409 });
  }
  if (order.paymentStatus !== "confirmed") {
    throw Object.assign(new Error("Payment must be confirmed before creating a Shopify order."), { status: 409 });
  }
  if (order.specialOrder?.status === "pending" || order.specialOrder?.status === "declined") {
    throw Object.assign(new Error("This special order is not ready for Shopify sync."), { status: 409 });
  }
  if (order.shopifyOrder?.id) return { created: false, order: order.shopifyOrder };
  order.shopifySync = {
    status: "syncing",
    attemptedAt: now,
    attemptedBy: cleanText(admin?.username || "admin", 120),
    message: "Creating Shopify order.",
  };
  try {
    const shopifyOrder = await createShopifyOrder(order);
    order.shopifyOrder = shopifyOrder;
    order.shopifySync = {
      status: "synced",
      attemptedAt: now,
      attemptedBy: cleanText(admin?.username || "admin", 120),
      syncedAt: new Date().toISOString(),
      message: `Created ${shopifyOrder.name || shopifyOrder.id}.`,
    };
    order.statusEvents.push({
      at: new Date().toISOString(),
      actor: "system",
      type: "shopify_order_created",
      label: `Shopify order ${shopifyOrder.name || shopifyOrder.id} created`,
    });
    return { created: true, order: shopifyOrder };
  } catch (error) {
    order.shopifySync = {
      status: "error",
      attemptedAt: now,
      attemptedBy: cleanText(admin?.username || "admin", 120),
      message: friendlyStatusError(error),
    };
    if (options.throwOnError) throw error;
    return { created: false, error };
  }
}

async function createShopifyOrder(order) {
  for (const item of order.items || []) {
    if (!String(item.variantId || "").startsWith("gid://shopify/ProductVariant/")) {
      throw new Error(`"${item.productTitle}" does not have a Shopify variant ID and cannot be synced.`);
    }
  }
  const mutation = `#graphql
    mutation OnlinePortalOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        userErrors {
          field
          message
        }
        order {
          id
          legacyResourceId
          name
          createdAt
          displayFinancialStatus
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
      }
    }
  `;
  const variables = {
    order: buildShopifyOrderInput(order),
    options: {
      inventoryBehaviour: shopifyOrderInventoryBehaviour,
      sendReceipt: shopifyOrderSendReceipt,
      sendFulfillmentReceipt: false,
    },
  };
  const payload = await shopifyGraphql(mutation, variables);
  const result = payload.data?.orderCreate;
  const userErrors = result?.userErrors || [];
  if (userErrors.length) {
    throw new Error(userErrors.map((entry) => `${entry.field?.join(".") || "order"}: ${entry.message}`).join("; "));
  }
  if (!result?.order?.id) throw new Error("Shopify did not return a created order.");
  return {
    id: result.order.id,
    legacyResourceId: result.order.legacyResourceId || "",
    name: result.order.name || "",
    adminUrl: shopifyAdminOrderUrl(result.order.legacyResourceId),
    financialStatus: result.order.displayFinancialStatus || "",
    total: result.order.totalPriceSet?.shopMoney?.amount || "",
    currencyCode: result.order.totalPriceSet?.shopMoney?.currencyCode || "",
    createdAt: result.order.createdAt || new Date().toISOString(),
  };
}

function buildShopifyOrderInput(order) {
  const nameParts = splitCustomerName(order.customer?.name);
  const shippingAddress = shopifyMailingAddress(order.delivery?.address, order.customer);
  const input = {
    email: order.customer?.email || undefined,
    phone: shopifyPhone(order.customer?.phone),
    customer: {
      toUpsert: {
        email: order.customer?.email || undefined,
        firstName: nameParts.firstName,
        lastName: nameParts.lastName,
      },
    },
    financialStatus: "PAID",
    lineItems: (order.items || []).map((item) => ({
      variantId: item.variantId,
      quantity: item.quantity,
      properties: [
        { name: "Online Portal reference", value: order.reference },
        ...(order.specialOrder ? [{ name: "Order type", value: "Special order" }] : []),
      ],
    })),
    shippingAddress,
    billingAddress: shippingAddress,
    sourceIdentifier: order.id,
    sourceName: "online_portal",
    poNumber: order.reference,
    note: [
      `Online Portal reference: ${order.reference}`,
      `Payment verified by admin before Shopify order creation.`,
      order.specialOrder ? `Special order status: ${order.specialOrder.status}` : "",
      order.proof?.filename ? `POP file: ${order.proof.filename}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    customAttributes: [
      { key: "Online Portal reference", value: order.reference },
      { key: "Online Portal order ID", value: order.id },
      { key: "Payment method", value: "EFT" },
    ],
    tags: ["Online Portal", "EFT Paid", order.reference, ...(order.specialOrder ? ["Special Order"] : [])],
  };
  if (money(order.deliveryFee) > 0) {
    input.shippingLines = [
      {
        title: "Delivery",
        code: "ONLINE_PORTAL_DELIVERY",
        source: "online_portal",
        priceSet: moneyBag(order.deliveryFee),
      },
    ];
  }
  return pruneEmpty(input);
}

function moneyBag(amount, currencyCode = "ZAR") {
  return {
    shopMoney: { amount: String(money(amount).toFixed(2)), currencyCode },
    presentmentMoney: { amount: String(money(amount).toFixed(2)), currencyCode },
  };
}

function shopifyMailingAddress(address = {}, customer = {}) {
  const nameParts = splitCustomerName(customer.name);
  const provinceCode = southAfricanProvinceCode(address.province);
  return pruneEmpty({
    firstName: nameParts.firstName,
    lastName: nameParts.lastName,
    address1: address.line1,
    address2: [address.line2, address.suburb].filter(Boolean).join(", "),
    city: address.city,
    countryCode: countryCode(address.country),
    provinceCode,
    zip: address.postalCode,
    phone: shopifyPhone(customer.phone),
  });
}

function splitCustomerName(value) {
  const parts = cleanText(value, 160).split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || "Customer",
    lastName: parts.slice(1).join(" ") || parts[0] || "Customer",
  };
}

function shopifyPhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  const digits = raw.replace(/\D+/g, "");
  if (!digits) return undefined;
  if (raw.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("27")) return `+${digits}`;
  if (digits.startsWith("0")) return `+27${digits.slice(1)}`;
  return `+${digits}`;
}

function countryCode(value) {
  const normalized = cleanText(value, 80).toLowerCase();
  if (!normalized || normalized === "south africa" || normalized === "za") return "ZA";
  return undefined;
}

function southAfricanProvinceCode(value) {
  const normalized = cleanText(value, 80).toLowerCase().replace(/[^a-z]+/g, " ");
  const codes = {
    "eastern cape": "EC",
    "free state": "FS",
    gauteng: "GP",
    "kwazulu natal": "KZN",
    "kwa zulu natal": "KZN",
    limpopo: "LP",
    mpumalanga: "MP",
    "north west": "NW",
    "northern cape": "NC",
    "western cape": "WC",
  };
  return codes[normalized.trim()] || undefined;
}

function pruneEmpty(value) {
  if (Array.isArray(value)) return value.map(pruneEmpty).filter((entry) => entry !== undefined);
  if (!value || typeof value !== "object") return value === "" || value === undefined || value === null ? undefined : value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    const cleaned = pruneEmpty(entry);
    if (cleaned !== undefined) result[key] = cleaned;
  }
  return result;
}

function shopifyAdminOrderUrl(legacyResourceId) {
  if (!legacyResourceId) return "";
  return `https://admin.shopify.com/store/${shopifyStoreSubdomain}/orders/${legacyResourceId}`;
}

async function catalogProducts() {
  const accessToken = await getShopifyAccessToken();
  if (!accessToken) {
    const products = mockCatalogProducts();
    return { source: "mock", products, filters: buildCatalogFilters(products) };
  }
  const endpoint = `https://${shopifyStoreSubdomain}.myshopify.com/admin/api/${shopifyApiVersion}/graphql.json`;
  const productsQuery = `#graphql
    query OnlinePortalCatalog($query: String!, $after: String) {
      products(first: 100, after: $after, query: $query) {
        nodes {
          id
          title
          handle
          vendor
          productType
          tags
          featuredMedia {
            preview {
              image {
                url
                altText
              }
            }
          }
          variants(first: 5) {
            nodes {
              id
              title
              sku
              price
              inventoryQuantity
              availableForSale
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;
  const collectionsQuery = `#graphql
    query OnlinePortalCollections($after: String) {
      collections(first: 100, after: $after) {
        nodes {
          id
          title
          handle
          image {
            url
            altText
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;
  const [productNodes, collectionNodes] = await Promise.all([
    fetchShopifyConnection(endpoint, accessToken, productsQuery, "products", { query: "status:active" }, 5),
    fetchShopifyConnection(endpoint, accessToken, collectionsQuery, "collections", {}, 5),
  ]);
  const collectionImages = buildCollectionImageLookup(collectionNodes);
  const products = productNodes.map((product) => normalizeCatalogProduct(product, collectionImages)).filter((product) => product.variant);
  const cachedProducts = await cacheCatalogImages(products);
  return { source: "shopify", products: cachedProducts, filters: buildCatalogFilters(cachedProducts) };
}

async function fetchShopifyConnection(endpoint, accessToken, query, connectionName, variables = {}, pageLimit = 5) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < pageLimit; page += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-access-token": accessToken,
      },
      body: JSON.stringify({ query, variables: { ...variables, after } }),
    });
    const payload = await response.json();
    if (!response.ok || payload.errors) {
      throw new Error(payload.errors?.[0]?.message || `Shopify ${connectionName} request failed with ${response.status}.`);
    }
    const connection = payload.data?.[connectionName];
    nodes.push(...(connection?.nodes || []));
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }
  return nodes;
}

async function shopifyGraphql(query, variables = {}) {
  const accessToken = await getShopifyAccessToken();
  if (!accessToken) throw Object.assign(new Error("Shopify access token is not configured."), { status: 409 });
  const response = await fetch(`https://${shopifyStoreSubdomain}.myshopify.com/admin/api/${shopifyApiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-access-token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.errors) {
    throw new Error(payload.errors?.map((entry) => entry.message).join("; ") || `Shopify request failed with ${response.status}.`);
  }
  return payload;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 3500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  } finally {
    clearTimeout(timer);
  }
}

async function systemStatus() {
  const checkedAt = new Date().toISOString();
  const [retailShark, shopify, orders] = await Promise.all([checkRetailSharkStatus(checkedAt), checkShopifyStatus(checkedAt), checkOrdersStatus(checkedAt)]);
  return { checkedAt, systems: [retailShark, shopify, orders] };
}

async function checkRetailSharkStatus(checkedAt) {
  if (!retailSharkInternalUrl || !retailSharkInternalToken) {
    return statusEntry("retail-shark", "Retail Shark connection", "offline", "Internal URL/token not configured yet.", checkedAt);
  }
  try {
    const healthUrl = new URL("/api/internal/health", retailSharkInternalUrl).toString();
    const { response, payload } = await fetchJsonWithTimeout(healthUrl, {
      headers: { "x-internal-token": retailSharkInternalToken },
    });
    if (!response.ok || payload.ok === false) {
      return statusEntry("retail-shark", "Retail Shark connection", "error", payload.error || `Health check returned ${response.status}.`, checkedAt);
    }
    return statusEntry("retail-shark", "Retail Shark connection", "online", "Retail Shark internal endpoint is reachable.", checkedAt);
  } catch (error) {
    return statusEntry("retail-shark", "Retail Shark connection", "offline", friendlyStatusError(error), checkedAt);
  }
}

async function checkShopifyStatus(checkedAt) {
  try {
    const accessToken = await getShopifyAccessToken();
    if (!accessToken) return statusEntry("shopify", "Shopify database", "offline", "Shopify access token is not configured.", checkedAt);
    const endpoint = `https://${shopifyStoreSubdomain}.myshopify.com/admin/api/${shopifyApiVersion}/graphql.json`;
    const { response, payload } = await fetchJsonWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-access-token": accessToken,
      },
      body: JSON.stringify({ query: "{ shop { name myshopifyDomain } }" }),
    });
    if (!response.ok || payload.errors) {
      return statusEntry("shopify", "Shopify database", "error", payload.errors?.[0]?.message || `Shopify returned ${response.status}.`, checkedAt);
    }
    return statusEntry("shopify", "Shopify database", "online", "Shopify Admin API is reachable.", checkedAt);
  } catch (error) {
    return statusEntry("shopify", "Shopify database", "offline", friendlyStatusError(error), checkedAt);
  }
}

async function checkOrdersStatus(checkedAt) {
  try {
    const data = await readOrdersData();
    return statusEntry("orders", "Orders database", "online", `${data.orders.length} order${data.orders.length === 1 ? "" : "s"} available in local storage.`, checkedAt);
  } catch (error) {
    return statusEntry("orders", "Orders database", "error", friendlyStatusError(error), checkedAt);
  }
}

function statusEntry(id, label, state, detail, checkedAt) {
  return { id, label, state, detail, checkedAt };
}

function friendlyStatusError(error) {
  if (error?.name === "AbortError") return "Health check timed out.";
  return cleanText(error?.message || "Health check failed.", 240);
}

function normalizeCatalogProduct(product, collectionImages = new Map()) {
  const variant = product.variants?.nodes?.[0];
  const inventoryQuantity = Number(variant?.inventoryQuantity);
  const hasQuantity = Number.isFinite(inventoryQuantity);
  const brandImage = collectionImageForVendor(product.vendor, collectionImages);
  const normalized = {
    id: product.id,
    title: product.title,
    handle: product.handle,
    vendor: product.vendor || "",
    productType: product.productType || "",
    tags: Array.isArray(product.tags) ? product.tags.filter(Boolean) : [],
    image: product.featuredMedia?.preview?.image?.url || "",
    imageAlt: product.featuredMedia?.preview?.image?.altText || product.title,
    brandImage: brandImage?.image || "",
    brandImageAlt: brandImage?.imageAlt || product.vendor || "",
    variant: variant
      ? {
          id: variant.id,
          title: variant.title || "Default Title",
          sku: variant.sku || "",
          price: money(variant.price),
          availableQuantity: hasQuantity ? Math.max(0, inventoryQuantity) : null,
          inStock: Boolean(variant.availableForSale && (!hasQuantity || inventoryQuantity > 0)),
        }
      : null,
  };
  return { ...normalized, groups: matchingCatalogGroups(normalized).map((group) => group.id) };
}

function buildCollectionImageLookup(collections) {
  const lookup = new Map();
  for (const collection of collections) {
    if (!collection.image?.url) continue;
    const entry = {
      title: collection.title || "",
      handle: collection.handle || "",
      image: collection.image.url,
      imageAlt: collection.image.altText || collection.title || "",
    };
    for (const key of [collection.title, collection.handle]) {
      const normalized = normalizeSearchText(key);
      if (normalized && !lookup.has(normalized)) lookup.set(normalized, entry);
    }
  }
  return lookup;
}

function collectionImageForVendor(vendor, lookup) {
  const key = normalizeSearchText(vendor);
  if (!key) return null;
  if (lookup.has(key)) return lookup.get(key);
  for (const [collectionKey, entry] of lookup.entries()) {
    if (collectionKey.includes(key) || key.includes(collectionKey)) return entry;
  }
  return null;
}

async function cacheCatalogImages(products) {
  await mkdir(productImagesDir, { recursive: true });
  return Promise.all(
    products.map(async (product) => {
      const image = await cacheRemoteImage(product.image, product.handle || product.id);
      const brandImage = await cacheRemoteImage(product.brandImage, `brand-${product.vendor || product.brandImageAlt || product.id}`);
      return { ...product, image, brandImage };
    }),
  );
}

async function cacheRemoteImage(url, key) {
  if (!url) return "";
  try {
    const ext = imageExt(url);
    const filename = `${safeFilename(key)}${ext}`;
    const localPath = path.join(productImagesDir, filename);
    if (!existsSync(localPath)) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Image request failed with ${response.status}.`);
      await writeFile(localPath, Buffer.from(await response.arrayBuffer()));
    }
    return `/product-images/${filename}`;
  } catch {
    return "";
  }
}

function imageExt(url) {
  const clean = new URL(url).pathname.toLowerCase();
  const ext = path.extname(clean);
  return [".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? ext : ".jpg";
}

function safeFilename(value) {
  return String(value).replace(/^gid:\/\/shopify\//, "").replace(/[^\w.-]+/g, "-").toLowerCase();
}

function proofStorageUsesBlobs() {
  return String(proofStorageMode || "").toLowerCase() === "blobs";
}

async function paymentProofBlobStore() {
  const { getStore } = await import("@netlify/blobs");
  return getStore(proofBlobStoreName);
}

function parseProofDataUrl(input) {
  const match = String(input || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Proof upload was not a valid file.");
  return {
    contentType: cleanText(match[1] || "application/octet-stream", 120) || "application/octet-stream",
    buffer: Buffer.from(match[2], "base64"),
  };
}

function proofBlobKey(order, filename) {
  return `orders/${safeFilename(order.id || order.reference)}/${randomUUID()}-${safeFilename(filename)}`;
}

async function storeProofUpload(order, input) {
  const filename = cleanText(input.filename || "proof-of-payment.txt", 160).replace(/[^\w.\- ]+/g, "_");
  const note = cleanText(input.note, 500);
  const now = new Date().toISOString();
  if (!input.dataUrl || !String(input.dataUrl).startsWith("data:")) {
    return { filename, note, path: null, storage: "none", uploadedAt: now };
  }
  const { contentType, buffer } = parseProofDataUrl(input.dataUrl);
  const sizeBytes = buffer.length;
  if (proofStorageUsesBlobs()) {
    const key = proofBlobKey(order, filename);
    const store = await paymentProofBlobStore();
    await store.set(key, buffer, {
      metadata: {
        orderId: order.id,
        reference: order.reference,
        filename,
        contentType,
        sizeBytes,
        uploadedAt: now,
      },
    });
    return { filename, note, storage: "blobs", storageKey: key, contentType, sizeBytes, uploadedAt: now };
  }
  await mkdir(proofsDir, { recursive: true });
  const proofPath = path.join(proofsDir, `${order.reference}-${filename}`);
  await writeFile(proofPath, buffer);
  return { filename, note, storage: "local", path: proofPath, contentType, sizeBytes, uploadedAt: now };
}

async function readProofFile(proof) {
  if (proof?.storage === "blobs" || proof?.storageKey) {
    if (!proof.storageKey) return null;
    const store = await paymentProofBlobStore();
    const arrayBuffer = await store.get(proof.storageKey, { type: "arrayBuffer", consistency: "strong" });
    if (!arrayBuffer) return null;
    return Buffer.from(arrayBuffer);
  }
  const proofPath = proof?.path ? path.resolve(proof.path) : "";
  if (!proofPath || !isInsideDirectory(proofPath, proofsDir) || !existsSync(proofPath)) return null;
  return readFile(proofPath);
}

async function getShopifyAccessToken() {
  if (shopifyToken) return shopifyToken;
  if (!shopifyClientId || !shopifyClientSecret) return "";
  const now = Date.now();
  if (shopifyClientCredentialsToken && shopifyClientCredentialsToken.expiresAt > now + 60_000) {
    return shopifyClientCredentialsToken.token;
  }
  const response = await fetch(`https://${shopifyStoreSubdomain}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: shopifyClientId,
      client_secret: shopifyClientSecret,
      grant_type: "client_credentials",
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || `Shopify token request failed with ${response.status}.`);
  }
  shopifyClientCredentialsToken = {
    token: payload.access_token,
    expiresAt: now + Math.max(1, Number(payload.expires_in || 3600)) * 1000,
  };
  return shopifyClientCredentialsToken.token;
}

function buildCatalogFilters(products) {
  const groupCounts = Object.fromEntries(catalogGroups.map((group) => [group.id, 0]));
  const tags = new Map();
  const vendors = new Map();
  const productTypes = new Map();
  for (const product of products) {
    for (const group of matchingCatalogGroups(product)) groupCounts[group.id] += 1;
    for (const tag of product.tags || []) increment(tags, tag);
    if (product.vendor) increment(vendors, product.vendor);
    if (product.productType) increment(productTypes, product.productType);
  }
  return {
    groups: catalogGroups.map((group) => ({ id: group.id, label: group.label, count: groupCounts[group.id] || 0 })).filter((group) => group.count > 0),
    tags: countedEntries(tags, 24),
    vendors: countedEntries(vendors, 18),
    productTypes: countedEntries(productTypes, 18),
  };
}

function matchingCatalogGroups(product) {
  const searchable = normalizeSearchText([product.title, product.vendor, product.productType, ...(product.tags || [])].join(" "));
  return catalogGroups.filter((group) => group.tokens.some((token) => searchable.includes(normalizeSearchText(token))));
}

function normalizeSearchText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function countedEntries(map, limit) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function mockCatalogProducts() {
  return [
    {
      id: "mock-hd-reta",
      title: "HD VIAL RETATRUTIDE 32MG",
      handle: "hd-vial-retatrutide-32mg",
      vendor: "HD LABS",
      productType: "Peptides",
      tags: ["Peptides", "Vials", "HD Labs"],
      image: "",
      imageAlt: "HD VIAL RETATRUTIDE 32MG",
      variant: { id: "mock-hd-reta-default", title: "Default Title", sku: "HD-RETA-32", price: 1350, availableQuantity: 62, inStock: true },
      groups: ["peptides"],
    },
    {
      id: "mock-hd-tirz",
      title: "HD VIAL TIRZ MOUNJARO 30MG",
      handle: "hd-vial-tirz-mounjaro-30mg",
      vendor: "HD LABS",
      productType: "Peptides",
      tags: ["Peptides", "Vials", "HD Labs"],
      image: "",
      imageAlt: "HD VIAL TIRZ MOUNJARO 30MG",
      variant: { id: "mock-hd-tirz-default", title: "Default Title", sku: "HD-TIRZ-30", price: 1250, availableQuantity: 41, inStock: true },
    },
    {
      id: "mock-hd-bpc",
      title: "HD VIAL BPC-157 5MG",
      handle: "hd-vial-bpc-157-5mg",
      vendor: "HD LABS",
      productType: "Peptides",
      tags: ["Peptides", "Vials", "HD Labs"],
      image: "",
      imageAlt: "HD VIAL BPC-157 5MG",
      variant: { id: "mock-hd-bpc-default", title: "Default Title", sku: "HD-BPC-5", price: 520, availableQuantity: 24, inStock: true },
    },
    {
      id: "mock-injectable-oil",
      title: "Sample Injectable Oil",
      handle: "sample-injectable-oil",
      vendor: "Tank Nutrition",
      productType: "Injectable Oils",
      tags: ["Injectable Oils"],
      image: "",
      imageAlt: "Sample Injectable Oil",
      variant: { id: "mock-injectable-oil-default", title: "Default Title", sku: "TN-OIL", price: 950, availableQuantity: 0, inStock: false },
    },
  ].map((product) => ({ ...product, groups: product.groups || matchingCatalogGroups(product).map((group) => group.id) }));
}

function publicCatalogPayload(catalog) {
  return {
    ...catalog,
    products: catalog.products.map(publicCatalogProduct),
  };
}

function publicCatalogProduct(product) {
  const variant = product.variant
    ? {
        id: product.variant.id,
        title: product.variant.title,
        sku: product.variant.sku,
        price: product.variant.price,
        inStock: product.variant.inStock,
      }
    : null;
  return { ...product, variant };
}

function requireInternal(req) {
  if (req.headers["x-internal-token"] !== internalToken) {
    throw Object.assign(new Error("Internal token is required."), { status: 401 });
  }
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/catalog") {
    await requirePortalAccess(req);
    return json(res, 200, { ok: true, ...publicCatalogPayload(await catalogProducts()) });
  }
  if (req.method === "GET" && url.pathname === "/api/shop-settings") {
    await requirePortalAccess(req);
    const data = await readShopSettingsData();
    return json(res, 200, { ok: true, settings: data.settings });
  }
  if (req.method === "POST" && url.pathname === "/api/cart/check") {
    await requireCustomer(req);
    const input = await bodyJson(req);
    const catalog = await catalogProducts();
    validateCartItems(input.items, catalog.products, { allowSpecial: Boolean(input.specialOrder) });
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    const session = sessionFromRequest(req);
    if (!session) return json(res, 200, { ok: true, user: null, admin: null });
    if (session.kind === "admin") {
      const data = await readUsersData();
      const admin = data.users.find((entry) => entry.id === session.userId && entry.role === "admin");
      if (!admin) return json(res, 200, { ok: true, user: null, admin: null }, { "set-cookie": clearSession() });
      return json(res, 200, { ok: true, user: null, admin: publicAdmin(admin) });
    }
    const user = await requireCustomer(req);
    return json(res, 200, { ok: true, user: publicUser(user), admin: null });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    const user = await registerCustomer(await bodyJson(req));
    return json(res, 201, { ok: true, user: publicUser(user) }, { "set-cookie": createSession({ kind: "customer", userId: user.id }) });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const user = await loginCustomer(await bodyJson(req));
    return json(res, 200, { ok: true, user: publicUser(user) }, { "set-cookie": createSession({ kind: "customer", userId: user.id }) });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/admin-login") {
    const admin = await loginAdmin(await bodyJson(req));
    return json(res, 200, { ok: true, admin: publicAdmin(admin) }, { "set-cookie": createSession({ kind: "admin", username: admin.username, userId: admin.id }) });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    return json(res, 200, { ok: true }, { "set-cookie": clearSession() });
  }
  if (req.method === "POST" && url.pathname === "/api/account/preferences") {
    const session = sessionFromRequest(req);
    if (!session || !["customer", "admin"].includes(session.kind)) throw Object.assign(new Error("Please log in first."), { status: 401 });
    const updated = await updateAccountPreferences(await bodyJson(req), session);
    return json(res, 200, { ok: true, user: session.kind === "customer" ? publicUser(updated) : null, admin: session.kind === "admin" ? publicAdmin(updated) : null });
  }
  if (req.method === "POST" && url.pathname === "/api/account/addresses") {
    const user = await requireCustomer(req);
    const saved = await saveCustomerAddress(user, await bodyJson(req));
    return json(res, 201, { ok: true, user: publicUser(saved.user), address: saved.address });
  }
  const accountAddressMatch = url.pathname.match(/^\/api\/account\/addresses\/([^/]+)$/);
  if (req.method === "PUT" && accountAddressMatch) {
    const user = await requireCustomer(req);
    const saved = await saveCustomerAddress(user, await bodyJson(req), decodeURIComponent(accountAddressMatch[1]));
    return json(res, 200, { ok: true, user: publicUser(saved.user), address: saved.address });
  }
  if (req.method === "DELETE" && accountAddressMatch) {
    const user = await requireCustomer(req);
    const saved = await removeCustomerAddress(user, decodeURIComponent(accountAddressMatch[1]));
    return json(res, 200, { ok: true, user: publicUser(saved.user), address: saved.address });
  }
  const accountDefaultAddressMatch = url.pathname.match(/^\/api\/account\/addresses\/([^/]+)\/default$/);
  if (req.method === "POST" && accountDefaultAddressMatch) {
    const user = await requireCustomer(req);
    const saved = await setDefaultCustomerAddress(user, decodeURIComponent(accountDefaultAddressMatch[1]));
    return json(res, 200, { ok: true, user: publicUser(saved.user), address: saved.address });
  }
  if (req.method === "POST" && url.pathname === "/api/orders") {
    const user = await requireCustomer(req);
    const order = await createOrder(await bodyJson(req), user);
    return json(res, 201, { ok: true, order: publicOrder(order), banking: await bankingDetails() });
  }
  if (req.method === "GET" && url.pathname === "/api/orders") {
    const user = await requireCustomer(req);
    const data = await readOrdersData();
    const orders = data.orders.filter((order) => order.customer?.id === user.id).map(publicOrder);
    return json(res, 200, { ok: true, orders, banking: await bankingDetails() });
  }
  const proofMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/proof$/);
  if (req.method === "POST" && proofMatch) {
    const user = await requireCustomer(req);
    const order = await uploadProof(decodeURIComponent(proofMatch[1]), await bodyJson(req), user);
    return json(res, 200, { ok: true, order: publicOrder(order) });
  }
  const adminConfirmMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/confirm-payment$/);
  if (req.method === "POST" && adminConfirmMatch) {
    const admin = requireAdmin(req);
    const order = await confirmPayment(decodeURIComponent(adminConfirmMatch[1]), await bodyJson(req), admin);
    return json(res, 200, { ok: true, order: staffOrder(order) });
  }
  const adminShopifySyncMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/sync-shopify$/);
  if (req.method === "POST" && adminShopifySyncMatch) {
    const admin = requireAdmin(req);
    const order = await syncConfirmedOrder(decodeURIComponent(adminShopifySyncMatch[1]), admin);
    return json(res, 200, { ok: true, order: staffOrder(order) });
  }
  const adminSpecialOrderMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/special-order$/);
  if (req.method === "POST" && adminSpecialOrderMatch) {
    const admin = requireAdmin(req);
    const order = await reviewSpecialOrder(decodeURIComponent(adminSpecialOrderMatch[1]), await bodyJson(req), admin);
    return json(res, 200, { ok: true, order: staffOrder(order) });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/orders") {
    requireAdmin(req);
    const data = await readOrdersData();
    return json(res, 200, { ok: true, orders: data.orders.map(staffOrder) });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/accounts") {
    requireAdmin(req);
    return json(res, 200, { ok: true, accounts: await listAccounts() });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/accounts") {
    requireAdmin(req);
    const account = await createAccountByAdmin(await bodyJson(req));
    return json(res, 201, { ok: true, account: publicAccount(account) });
  }
  const adminAccountMatch = url.pathname.match(/^\/api\/admin\/accounts\/([^/]+)$/);
  if (req.method === "PUT" && adminAccountMatch) {
    const admin = requireAdmin(req);
    const account = await updateAccountByAdmin(decodeURIComponent(adminAccountMatch[1]), await bodyJson(req), admin);
    return json(res, 200, { ok: true, account: publicAccount(account), admin: admin.userId === account.id ? publicAdmin(account) : null });
  }
  if (req.method === "DELETE" && adminAccountMatch) {
    const admin = requireAdmin(req);
    const account = await removeAccountByAdmin(decodeURIComponent(adminAccountMatch[1]), await bodyJson(req), admin);
    return json(res, 200, { ok: true, account: publicAccount(account) });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/system-status") {
    requireAdmin(req);
    return json(res, 200, { ok: true, ...(await systemStatus()) });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/shop-settings") {
    requireAdmin(req);
    const data = await writeShopSettingsData(await bodyJson(req));
    return json(res, 200, { ok: true, settings: data.settings });
  }
  const adminProofMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/proof$/);
  if (req.method === "GET" && adminProofMatch) {
    requireAdmin(req);
    const data = await readOrdersData();
    const order = data.orders.find((entry) => entry.id === decodeURIComponent(adminProofMatch[1]));
    const body = await readProofFile(order?.proof);
    if (!body) throw Object.assign(new Error("Proof of payment was not found."), { status: 404 });
    const filename = order.proof.filename || "proof-of-payment";
    res.writeHead(200, {
      "content-type": order.proof.contentType || contentTypes[path.extname(filename).toLowerCase()] || "application/octet-stream",
      "content-disposition": `inline; filename="${filename.replaceAll('"', "")}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/internal/orders/confirmed") {
    requireInternal(req);
    const data = await readOrdersData();
    const orders = data.orders.filter(orderReadyForRetailShark).map(staffOrder);
    return json(res, 200, { ok: true, orders });
  }
  if (req.method === "GET" && url.pathname === "/api/internal/orders/history") {
    requireInternal(req);
    const data = await readOrdersData();
    const orders = data.orders.filter(orderCompletedForRetailShark).map(staffOrder);
    return json(res, 200, { ok: true, orders });
  }
  const trackingMatch = url.pathname.match(/^\/api\/internal\/orders\/([^/]+)\/tracking$/);
  if (req.method === "POST" && trackingMatch) {
    requireInternal(req);
    const order = await updateTracking(decodeURIComponent(trackingMatch[1]), await bodyJson(req));
    return json(res, 200, { ok: true, order: staffOrder(order) });
  }
  const backOrderMatch = url.pathname.match(/^\/api\/internal\/orders\/([^/]+)\/back-order$/);
  if (req.method === "POST" && backOrderMatch) {
    requireInternal(req);
    const order = await markBackOrder(decodeURIComponent(backOrderMatch[1]), await bodyJson(req));
    return json(res, 200, { ok: true, order: staffOrder(order) });
  }
  const shipMatch = url.pathname.match(/^\/api\/internal\/orders\/([^/]+)\/ship$/);
  if (req.method === "POST" && shipMatch) {
    requireInternal(req);
    const order = await markShipped(decodeURIComponent(shipMatch[1]));
    return json(res, 200, { ok: true, order: staffOrder(order) });
  }
  return json(res, 404, { ok: false, error: "API route not found." });
}

async function bankingDetails() {
  const data = await readShopSettingsData();
  return data.settings.payment;
}

async function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(path.join(publicDir, requested));
  if (!isInsideDirectory(filePath, publicDir)) return text(res, 403, "Forbidden");
  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const cache = requested.startsWith("/product-images/") || requested.startsWith("/assets/") ? "public, max-age=86400" : "no-store";
    res.writeHead(200, { "content-type": contentTypes[ext] || "application/octet-stream", "cache-control": cache });
    res.end(body);
  } catch {
    text(res, 404, "Not found");
  }
}

export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(res, url.pathname);
  } catch (error) {
    json(res, error.status || 500, { ok: false, error: error.message || "Something went wrong." });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = http.createServer(handleRequest);
  server.listen(port, "127.0.0.1", () => {
    console.log(`Online Portal running at http://127.0.0.1:${port}`);
  });
}
