import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync } from "node:crypto";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(rootDir, "data");
const proofsDir = path.join(dataDir, "proofs");
const ordersPath = path.join(dataDir, "orders.json");
const usersPath = path.join(dataDir, "users.json");

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

const orders = {
  version: 1,
  updatedAt: new Date().toISOString(),
  orders: [],
};

const users = {
  version: 1,
  updatedAt: new Date().toISOString(),
  users: [
    {
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
    },
    {
      id: "demo-admin",
      role: "admin",
      username: "admin",
      name: "Admin",
      email: "admin@example.com",
      phoneArea: "+27",
      phoneNumber: "",
      phone: "",
      defaultAddress: {
        line1: "",
        line2: "",
        suburb: "",
        city: "",
        province: "",
        postalCode: "",
        country: "South Africa",
      },
      addresses: [],
      preferences: { theme: "light" },
      passwordHash: hashPassword("admin"),
      createdAt: new Date().toISOString(),
    },
  ],
};

await mkdir(dataDir, { recursive: true });
if (existsSync(proofsDir)) await rm(proofsDir, { recursive: true, force: true });
await mkdir(proofsDir, { recursive: true });
await writeFile(ordersPath, JSON.stringify(orders, null, 2));
await writeFile(usersPath, JSON.stringify(users, null, 2));

console.log("Online Portal local data reset: orders cleared, proofs cleared, demo customer and admin restored.");
