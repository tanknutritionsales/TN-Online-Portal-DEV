import { defaultSearchGroups, defaultSearchCategories, defaultBrandAliases } from "./search-defaults.js";

export function normalizeSearchText(value) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[µμ]g\b/g, "mcg").replace(/\b(?:no|without)[\s-]*dac\b/g, "no dac").replace(/\bwithdac\b/g, "with dac")
    .replace(/(\d),(\d)/g, "$1.$2").replace(/(\d)(mcg|mg|ml|iu|ius|g)\b/g, "$1 $2")
    .replace(/\.(?!\d)|(?<!\d)\./g, " ").replace(/[^a-z0-9.]+/g, " ").trim().replace(/\s+/g, " ");
}
const clean = (value, max = 100) => String(value || "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, max);
const unique = (items) => [...new Set(items)];
const words = (value) => normalizeSearchText(value).split(" ").filter(Boolean);
const safeId = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
const strings = (value, max = 50) => unique((Array.isArray(value) ? value : []).slice(0, max).map((v) => clean(v)).filter(Boolean));
export function normalizeSearchSettings(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
  const seen = new Set();
  const groups = (Array.isArray(input.groups) ? input.groups : defaultSearchGroups).slice(0, 250).map((g) => {
    const id = clean(g?.id, 80);
    if (!safeId(id) || seen.has(id) || !clean(g.label)) return null;
    seen.add(id);
    const kind = ["compound", "blend", "named"].includes(g.kind) ? g.kind : "named";
    return { id, label: clean(g.label), kind, tag: /^(compound|blend|search)-[a-z0-9-]+$/.test(g.tag) ? g.tag : `${kind === "named" ? "search" : kind}-${id}`, aliases: strings(g.aliases), classes: strings(g.classes).filter(safeId), includes: strings(g.includes).filter(safeId), disabled: g.disabled === true };
  }).filter(Boolean);
  const ids = new Set(groups.map((g) => g.id));
  for (const g of groups) g.includes = g.includes.filter((id) => ids.has(id) && id !== g.id);
  const categories = (Array.isArray(input.categories) ? input.categories : defaultSearchCategories).slice(0, 60).filter((g) => safeId(g?.id) && clean(g.label)).map((g) => ({ id: g.id, label: clean(g.label), aliases: strings(g.aliases) }));
  const brands = (Array.isArray(input.brands) ? input.brands : defaultBrandAliases).slice(0, 80).filter((g) => clean(g?.vendor)).map((g) => ({ vendor: clean(g.vendor), aliases: strings(g.aliases) }));
  const assignments = Object.create(null);
  for (const [id, value] of Object.entries(input.assignments && typeof input.assignments === "object" ? input.assignments : {}).slice(0, 2000)) {
    if (["__proto__", "constructor", "prototype"].includes(id)) continue;
    assignments[clean(id, 180)] = strings(value, 12).filter((id) => ids.has(id));
  }
  return { enabled: input.enabled !== false, typoSuggestions: input.typoSuggestions !== false, recordMisses: input.recordMisses !== false, groups, categories, brands, assignments, ignoredProductIds: strings(input.ignoredProductIds, 2000) };
}

const phraseIn = (text, phrase) => (` ${text} `).includes(` ${phrase} `);
const formTerms = { vial: ["vial", "vials"], oral: ["oral", "orals", "tablets", "tablet", "tabs", "capsules", "caps"], pen: ["pen", "pens", "kwikpen"], nasal: ["nasal", "nasals"] };

export function createCatalogSearch(products = [], input = {}) {
  const settings = normalizeSearchSettings(input);
  const groups = new Map(settings.groups.filter((g) => !g.disabled).map((g) => [g.id, g]));
  const entries = products.map((product, order) => {
    const tags = new Set(product.tags || []);
    const assigned = settings.assignments[product.id];
    const title = normalizeSearchText(product.title), sku = normalizeSearchText(product.variant?.sku);
    let all = assigned !== undefined ? assigned.map((id) => groups.get(id)).filter(Boolean) : [...groups.values()].filter((g) => tags.has(g.tag));
    let inferred = false;
    if (assigned === undefined && !all.length && !/\b(blend|mix|hybrid|stack)\b/.test(title)) {
      const candidates = [...groups.values()].filter((g) => g.kind === "compound").flatMap((g) => [g.label, ...g.aliases].map(normalizeSearchText).filter((term) => phraseIn(title, term)).map((term) => ({ group: g, term })));
      const specific = candidates.filter((candidate) => !candidates.some((other) => other.group.id !== candidate.group.id && other.term.length > candidate.term.length && phraseIn(other.term, candidate.term)));
      const ids = unique(specific.map((candidate) => candidate.group.id));
      // Only a single unambiguous compound inherits a rule. New blends stay in the review queue.
      if (ids.length === 1) { all = [groups.get(ids[0])]; inferred = true; }
    }
    const blends = all.filter((g) => g.kind === "blend");
    const primary = blends.length ? blends : all;
    const includes = unique(primary.flatMap((g) => g.includes)).filter((id) => groups.has(id));
    const classes = new Set([...primary.flatMap((g) => g.classes), ...includes.flatMap((id) => groups.get(id).classes)]);
    // Ignore legacy broad category tags. Only the approved class vocabulary participates.
    if (assigned === undefined) for (const tag of tags) if (tag.startsWith("class-")) classes.add(tag.slice(6));
    const searchable = normalizeSearchText([product.title, product.vendor, product.productType, product.variant?.sku, ...(product.tags || []).filter((t) => !/^(compound|blend|class|search)-/.test(t))].join(" "));
    const ingredientTokens = unique(includes.flatMap((id) => [groups.get(id).label, ...groups.get(id).aliases]).flatMap(words));
    const aliasTokens = unique(primary.flatMap((g) => [g.label, ...g.aliases]).flatMap(words))
      .filter((token) => !blends.length || !ingredientTokens.includes(token));
    const formText = normalizeSearchText([product.title, product.productType, ...(product.tags || []).filter((tag) => !/^(compound|blend|class|search)-/.test(tag))].join(" "));
    const forms = Object.entries(formTerms).filter(([, aliases]) => aliases.some((alias) => phraseIn(formText, alias))).map(([id]) => id);
    return { product, order, title, sku, searchable, tokens: words(searchable), aliasTokens, ingredientTokens, primary: primary.map((g) => g.id), includes, classes, forms, inferred };
  });
  const vocabulary = [];
  const add = (kind, id, label, aliases) => {
    for (const term of unique([label, ...aliases].map(normalizeSearchText).filter(Boolean))) vocabulary.push({ kind, id, label, term, count: words(term).length });
  };
  for (const g of groups.values()) add("group", g.id, g.label, g.aliases);
  for (const c of settings.categories) add("category", c.id, c.label, c.aliases);
  for (const b of settings.brands) add("brand", b.vendor, b.vendor, b.aliases);
  for (const [id, aliases] of Object.entries(formTerms)) add("form", id, id, aliases);
  vocabulary.sort((a, b) => b.count - a.count || b.term.length - a.term.length || (a.kind === "category" ? -1 : 1));

  function search(query = "") {
    const normalized = normalizeSearchText(query).slice(0, 160);
    if (!normalized) return entries.map((entry) => ({ product: entry.product, score: 0, reason: "", order: entry.order }));
    if (!settings.enabled) return entries.filter((e) => words(normalized).every((t) => e.tokens.some((word) => word === t || (!/\d/.test(t) && word.startsWith(t))))).map((e) => ({ product: e.product, score: 1, reason: "", order: e.order }));
    const dac = /\b(?:no|without) dac\b/.test(normalized) ? "without" : /\bdac\b/.test(normalized) ? "with" : "";
    let remaining = ` ${normalized.replace(/\b(?:no|without|with) dac\b|\bdac\b/g, " ").trim()} `;
    const conditions = [];
    for (const term of vocabulary) {
      if (!remaining.includes(` ${term.term} `)) continue;
      conditions.push(term);
      remaining = remaining.replaceAll(` ${term.term} `, " ");
    }
    const residual = words(remaining);
    return entries.flatMap((e) => {
      if (dac && (dac === "without" ? !/\b(?:no|without) dac\b/.test(e.title) : !/\bdac\b/.test(e.title) || /\b(?:no|without) dac\b/.test(e.title))) return [];
      const ingredientSearch = conditions.some((condition) => condition.kind === "group" && e.includes.includes(condition.id) && !e.primary.includes(condition.id));
      const literalName = phraseIn(e.title, normalized) && !ingredientSearch && (residual.length || !conditions.some((condition) => condition.kind === "category"));
      if (e.title === normalized || (e.sku && e.sku === normalized) || literalName) {
        return [{ product: e.product, score: e.title === normalized || e.sku === normalized ? 2000 : 1600, reason: "", order: e.order }];
      }
      let score = e.title === normalized || e.sku === normalized ? 1000 : phraseIn(e.title, normalized) ? 900 : 0;
      let includesMatch = false;
      for (const condition of conditions) {
        if (condition.kind === "group") {
          if (e.primary.includes(condition.id)) score += 700;
          else if (e.includes.includes(condition.id)) { score += 300; includesMatch = true; }
          else return [];
        } else if (condition.kind === "category") {
          if (!e.classes.has(condition.id)) return [];
          score += 450;
        } else if (condition.kind === "brand") {
          if (normalizeSearchText(e.product.vendor) !== normalizeSearchText(condition.id)) return [];
          score += 100;
        } else if (condition.kind === "form") {
          if (!e.forms.includes(condition.id)) return [];
          score += 80;
        }
      }
      for (const token of residual) {
        const exact = e.tokens.includes(token);
        // Codes, strengths and units are exact constraints, never substrings or fuzzy replacements.
        const allowPrefix = !/\d/.test(token) && !["mg", "mcg", "ml", "iu", "ius", "g"].includes(token) && token.length >= 3;
        const partial = allowPrefix && e.tokens.some((word) => word.startsWith(token));
        const alias = allowPrefix && e.aliasTokens.some((word) => word.startsWith(token));
        const ingredient = allowPrefix && e.ingredientTokens.some((word) => word.startsWith(token));
        if (!exact && !partial && !alias && !ingredient) return [];
        if (ingredient && !alias) includesMatch = true;
        score += alias ? 200 : ingredient ? 80 : exact ? 20 : 5;
      }
      return [{ product: e.product, score: includesMatch ? Math.min(score, 350) : score, reason: includesMatch ? "Blend containing this compound" : "", order: e.order }];
    }).sort((a, b) => b.score - a.score || Number(Boolean(b.product.variant?.inStock)) - Number(Boolean(a.product.variant?.inStock)) || a.order - b.order);
  }

  function suggest(query) {
    if (!settings.typoSuggestions || !settings.enabled || search(query).length) return [];
    const normalized = normalizeSearchText(query), queryWords = words(normalized);
    const candidates = unique(vocabulary.filter((v) => ["group", "category"].includes(v.kind)).map((v) => v.term));
    const results = [];
    for (let i = 0; i < queryWords.length; i++) {
      const word = queryWords[i];
      if (word.length < 4 || /\d/.test(word) || vocabulary.some((v) => v.term === word)) continue;
      for (const candidate of candidates) {
        if (candidate.includes(" ") || /\d/.test(candidate) || Math.abs(candidate.length - word.length) > 2) continue;
        if (candidate.length < 4) continue;
        const distance = editDistance(word, candidate);
        if (distance > (word.length > 8 ? 2 : 1) || (word[0] !== candidate[0] && distance > 1)) continue;
        if ((word.startsWith("melan") && candidate.startsWith("melat")) || (word.startsWith("melat") && candidate.startsWith("melan"))) continue;
        const replacement = [...queryWords]; replacement[i] = candidate;
        const value = replacement.join(" ");
        if (search(value).length) results.push({ value, distance });
      }
    }
    return unique(results.sort((a, b) => a.distance - b.distance).map((result) => result.value)).slice(0, 3);
  }
  return { search, suggest, entries, settings, groups };
}

function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i), beforePrevious;
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], beforePrevious[j - 2] + 1);
    }
    beforePrevious = previous;
    previous = row;
  }
  return previous[b.length];
}

// Store only short catalog terms. Never retain contact details, IDs, URLs or free text.
export function anonymousSearchTerm(value) {
  const raw = String(value || "");
  if (raw.length > 80 || /[@:/\\]|\b\d{5,}\b/.test(raw) || (raw.match(/\d/g) || []).length >= 7 || /\b(email|phone|password|address|postal|road|street|avenue)\b/i.test(raw) || /[^a-zA-Z0-9\s+.,-]/.test(raw)) return "";
  const normalized = normalizeSearchText(raw);
  return normalized.length >= 2 && words(normalized).length <= 6 ? normalized : "";
}
