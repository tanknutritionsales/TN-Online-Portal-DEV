const clean = (value) => String(value || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 100);

export function normalizeProductContent(input = {}) {
  const content = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return content;
  for (const [id, value] of Object.entries(input).slice(0, 1500)) {
    if (!id || id.length > 180 || ["__proto__", "constructor", "prototype"].includes(id) || !value || typeof value !== "object") continue;
    const entry = { strength: clean(value.strength), format: clean(value.format), packSize: clean(value.packSize) };
    if (Object.values(entry).some(Boolean)) content[id] = entry;
  }
  return content;
}

export function productFacts(product, overrides = {}) {
  const title = String(product.title || "");
  const text = [title, product.productType, ...(product.tags || [])].join(" ");
  const strengths = [...new Set((title.match(/\b\d+(?:[.,]\d+)?\s*(?:MCG|MG|IU|ML|G)(?:\s*\/\s*(?:ML|VIAL|PEN))?\b/gi) || []).map((value) => value.toUpperCase()))];
  const format = /\b(nasal|spray)\b/i.test(text) ? "Nasal" : /\b(pen|pens|kwikpen)\b/i.test(text) ? "Pen" : /\b(vial|vials)\b/i.test(text) ? "Vial" : /\b(oral|orals|tablet|tablets|tabs|capsule|capsules|caps)\b/i.test(text) ? "Oral" : "";
  const pack = title.match(/\b\d+\s*(?:tablets?|capsules?|tabs|caps|vials?|pens?)\b/i)?.[0] || title.match(/\b\d+\s*x\s*\d+(?:[.,]\d+)?\s*ML\b/i)?.[0] || "";
  return [
    { label: "Strength", value: clean(overrides.strength) || (strengths.length === 1 ? strengths[0] : "") },
    { label: "Format", value: clean(overrides.format) || format },
    { label: "Pack size", value: clean(overrides.packSize) || pack },
  ].filter((fact) => fact.value);
}
