const maxAge = 30 * 24 * 60 * 60 * 1000;

export function cartStorageKey(userId) {
  return `op-cart-v1:${encodeURIComponent(userId)}`;
}

export function readSavedCart(storage, userId, now = Date.now()) {
  if (!userId) return [];
  try {
    const key = cartStorageKey(userId);
    const saved = JSON.parse(storage.getItem(key) || "null");
    if (!saved) return [];
    if (saved.version !== 1 || saved.userId !== userId || !Number.isFinite(saved.savedAt) || now - saved.savedAt > maxAge || saved.savedAt > now + 60_000) {
      storage.removeItem(key);
      return [];
    }
    return normalizeItems(saved.items);
  } catch {
    return [];
  }
}

export function saveCart(storage, userId, items, now = Date.now()) {
  if (!userId) return false;
  try {
    const normalized = normalizeItems(items);
    const key = cartStorageKey(userId);
    if (!normalized.length) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ version: 1, userId, savedAt: now, items: normalized }));
    return true;
  } catch {
    return false;
  }
}

function normalizeItems(items) {
  const unique = new Map();
  for (const item of Array.isArray(items) ? items.slice(0, 100) : []) {
    if (typeof item?.variantId !== "string" || !item.variantId.trim() || item.variantId.length > 180) continue;
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 999) continue;
    unique.set(item.variantId, { variantId: item.variantId, quantity: item.quantity });
  }
  return [...unique.values()];
}
