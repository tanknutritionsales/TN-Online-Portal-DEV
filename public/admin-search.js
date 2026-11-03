import { createCatalogSearch, normalizeSearchSettings, normalizeSearchText } from "./catalog-search.js";

export function mountAdminSearch({ container, products, settings, misses = [], api, onSave, toast, escapeHtml: esc }) {
  let draft = structuredClone(normalizeSearchSettings(settings));
  for (const vendor of new Set(products.map((p) => p.vendor).filter(Boolean))) if (!draft.brands.some((b) => b.vendor === vendor)) draft.brands.push({ vendor, aliases: [vendor] });
  let groupId = draft.groups[0]?.id || "", view = "vocabulary", page = 1, query = "", catalogView = "pending", busy = false;
  const list = (value) => [...new Set(String(value || "").split(/[\n,]+/).map((term) => term.trim()).filter(Boolean))];
  const options = (items, selected = []) => items.map((item) => `<option value="${esc(item.id)}" ${selected.includes(item.id) ? "selected" : ""}>${esc(item.label)}</option>`).join("");
  const selection = (id) => [...container.querySelector(`#${id}`).selectedOptions].map((o) => o.value);
  const engine = () => createCatalogSearch(products, draft);
  function capture() {
    const form = container.querySelector("#searchGroupEditor");
    const group = draft.groups.find((g) => g.id === groupId);
    if (!form || !group) return;
    group.label = form.elements.label.value.trim();
    group.aliases = list(form.elements.aliases.value);
    group.classes = selection("searchGroupClasses");
    group.includes = group.kind === "blend" ? selection("searchGroupIngredients") : [];
    group.disabled = !form.elements.enabled.checked;
  }
  function render() {
    const index = engine();
    const pending = index.entries.filter((e) => !e.primary.length && !draft.ignoredProductIds.includes(e.product.id));
    const openMisses = misses.filter((m) => m.status !== "resolved");
    container.innerHTML = `
      <div class="search-management">
        <div class="search-admin-heading"><div><h3>Product search</h3><p class="muted small">Manage search names and categories. Preview changes before saving.</p></div><button type="button" class="primary" data-search-save ${busy ? "disabled" : ""}>Save search settings</button></div>
        <div class="search-settings-toggles">
          <label class="check-option"><input type="checkbox" data-search-option="enabled" ${draft.enabled ? "checked" : ""}> Smart search</label>
          <label class="check-option"><input type="checkbox" data-search-option="typoSuggestions" ${draft.typoSuggestions ? "checked" : ""}> Spelling suggestions</label>
          <label class="check-option"><input type="checkbox" data-search-option="recordMisses" ${draft.recordMisses ? "checked" : ""}> Collect anonymous searches with no results</label>
        </div>
        <div class="admin-order-filters" role="group" aria-label="Search management views">
          <button type="button" data-search-view="vocabulary" class="${view === "vocabulary" ? "is-active" : ""}">Names &amp; aliases</button>
          <button type="button" data-search-view="catalog" class="${view === "catalog" ? "is-active" : ""}">Product classification (${pending.length})</button>
          <button type="button" data-search-view="misses" class="${view === "misses" ? "is-active" : ""}">Unmatched searches (${openMisses.length})</button>
        </div>
        ${view === "vocabulary" ? vocabulary() : view === "catalog" ? catalog(index) : missed()}
        ${view === "vocabulary" ? "" : previewPanel()}
        <p class="muted small" id="searchSaveFeedback" role="status">Changes take effect after saving. Product classification here controls portal search.</p>
      </div>`;
  }
  function previewPanel() {
    return `<section class="search-preview"><h3>Try a search</h3><label for="searchPreviewQuery">Search preview</label><input id="searchPreviewQuery" type="search" placeholder="Try oxandrolone, GLP-1 or a product name" autocomplete="off"><div id="searchPreviewResults" role="status" aria-live="polite"><p class="muted small">Preview uses your unsaved search settings.</p></div></section>`;
  }
  function vocabulary() {
    const group = draft.groups.find((g) => g.id === groupId);
    return `<div class="search-admin-layout"><section>
      <label>Search group<select id="searchGroupSelect">${options(draft.groups, [groupId])}</select></label>
      <button type="button" class="secondary" data-search-new>New search group</button>
      ${group ? `<form id="searchGroupEditor" class="search-group-editor">
        <label>Display name<input name="label" maxlength="100" value="${esc(group.label)}" required></label>
        <p class="muted small">${group.kind === "blend" ? "Blend" : group.kind === "compound" ? "Compound" : "Named product group"} &middot; ${esc(group.tag)}</p>
        <label for="searchGroupAliases">Other search names</label><textarea id="searchGroupAliases" name="aliases" rows="5" maxlength="4000" placeholder="One name per line">${esc(group.aliases.join("\n"))}</textarea>
        <label>Categories<select id="searchGroupClasses" multiple size="5">${options(draft.categories, group.classes)}</select></label>
        ${group.kind === "blend" ? `<label>Verified ingredients<select id="searchGroupIngredients" multiple size="5">${options(draft.groups.filter((g) => g.kind === "compound"), group.includes)}</select></label><p class="muted small">Only add ingredients confirmed for this blend. Ingredient searches show this as a blend.</p>` : ""}
        <label class="check-option"><input type="checkbox" name="enabled" ${group.disabled ? "" : "checked"}> Enable this search group</label>
      </form>` : ""}
    </section><section><h3>Brands &amp; umbrella searches</h3><p class="muted small">Umbrella searches include a category. Individual compound names stay specific.</p>
      <details class="settings-accordion"><summary>Brand aliases</summary><div class="search-dictionary-list">${draft.brands.map((brand, i) => `<label>${esc(brand.vendor)}<input data-brand-alias="${i}" maxlength="600" value="${esc(brand.aliases.join(", "))}" placeholder="Separate names with commas"></label>`).join("")}</div></details>
      <details class="settings-accordion"><summary>Category aliases</summary><div class="search-dictionary-list">${draft.categories.map((category, i) => `<label>${esc(category.label)}<input data-category-alias="${i}" maxlength="600" value="${esc(category.aliases.join(", "))}" placeholder="Separate names with commas"></label>`).join("")}</div></details>
      <details class="settings-accordion"><summary>Create a group</summary><div class="search-dictionary-list"><label>Name<input id="newSearchName" maxlength="100"></label><label>Kind<select id="newSearchKind"><option value="named">Named product group</option><option value="compound">Compound</option><option value="blend">Blend</option></select></label><button type="button" class="secondary" data-create-search-group>Create group</button></div></details>
      ${previewPanel()}
    </section></div>`;
  }
  function catalog(index) {
    let entries = index.entries.filter((e) => catalogView === "all" || (!e.primary.length && !draft.ignoredProductIds.includes(e.product.id)));
    if (query) {
      const matching = new Set(index.search(query).map((m) => m.product.id));
      entries = entries.filter((e) => matching.has(e.product.id));
    }
    const pages = Math.max(1, Math.ceil(entries.length / 15)); page = Math.min(pages, page);
    return `<div class="search-catalog-tools"><label>Find product<input id="classificationQuery" type="search" value="${esc(query)}" placeholder="Search product or brand"></label><label>Show<select id="classificationView"><option value="pending" ${catalogView === "pending" ? "selected" : ""}>Needs classification</option><option value="all" ${catalogView === "all" ? "selected" : ""}>All products</option></select></label></div>
      <p class="muted small">${entries.length} products. Deferred formulas can stay searchable by their product name. Select multiple groups only when verified. On a computer, hold Ctrl or ⌘ to select more than one.</p>
      <div class="classification-list">${entries.slice((page - 1) * 15, page * 15).map((e) => `<div class="classification-row"><div><strong>${esc(e.product.title)}</strong><small class="muted">${esc(e.product.vendor)}${draft.ignoredProductIds.includes(e.product.id) ? " · Name search only" : ""}</small></div><label>Search groups<select multiple size="3" data-product-groups="${esc(e.product.id)}" aria-label="Search groups for ${esc(e.product.title)}">${options(draft.groups.filter((g) => !g.disabled), e.primary)}</select></label><button type="button" class="secondary" data-search-ignore="${esc(e.product.id)}">Keep name search only</button></div>`).join("") || `<p class="muted">No products need attention in this view.</p>`}</div>
      <div class="product-pager"><button type="button" data-classification-page="-1" ${page === 1 ? "disabled" : ""}>Previous</button><span>Page ${page} of ${pages}</span><button type="button" data-classification-page="1" ${page === pages ? "disabled" : ""}>Next</button></div>`;
  }
  function missed() {
    return `<p class="muted small">Anonymous catalog terms only, retained for 30 days. No customer names or account details are attached. Each browser session records a term once.</p><div class="search-miss-list">${misses.filter((m) => m.status !== "resolved").sort((a, b) => b.count - a.count).map((miss) => `<div class="search-miss-row"><strong>${esc(miss.query)}</strong><span>${miss.count} ${miss.count === 1 ? "search" : "searches"}</span><button type="button" class="secondary" data-preview-miss="${esc(miss.query)}">Try search</button><button type="button" class="text-button" data-resolve-search="${esc(miss.id)}">Resolve</button></div>`).join("") || `<p class="muted">No unmatched searches to review.</p>`}</div>`;
  }
  function preview(value) {
    capture();
    const index = engine(), results = index.search(value), suggestions = index.suggest(value);
    container.querySelector("#searchPreviewResults").innerHTML = !value.trim() ? `<p class="muted small">Enter a product, compound or category.</p>` : `<p><strong>${results.length}</strong> matching products${suggestions.length ? `. Suggestions: ${suggestions.map(esc).join(", ")}` : ""}</p><ul>${results.slice(0, 8).map((m) => `<li>${esc(m.product.title)} <small class="muted">${m.product.variant?.inStock ? "In stock" : "Out of stock"}${m.reason ? ` · ${esc(m.reason)}` : ""}</small></li>`).join("")}</ul>${results.length > 8 ? `<p class="muted small">Showing the first 8 results.</p>` : ""}`;
  }
  async function save() {
    capture();
    const invalid = draft.groups.find((g) => !g.label || g.aliases.length > 50 || g.aliases.some((alias) => alias.length > 100));
    if (invalid) { toast("Each group needs a name and up to 50 aliases of 100 characters or fewer."); return; }
    const used = new Map();
    for (const group of draft.groups.filter((g) => !g.disabled)) for (const alias of [group.label, ...group.aliases]) {
      const key = normalizeSearchText(alias), previous = used.get(key);
      if (previous && previous !== group.id) { toast(`The search name "${alias}" already belongs to another group.`); return; }
      used.set(key, group.id);
    }
    busy = true; render();
    try {
      const payload = await api("/api/admin/shop-settings", { method: "POST", body: JSON.stringify({ search: normalizeSearchSettings(draft) }) });
      draft = structuredClone(payload.settings.search); onSave(payload.settings); toast("Search settings saved.");
    } catch (error) { toast(error.message); }
    finally { busy = false; render(); }
  }
  container.onclick = async (event) => {
    const target = event.target.closest("button"); if (!target) return;
    if (target.matches("[data-search-save]")) { await save(); return; }
    if (target.dataset.searchView) { capture(); view = target.dataset.searchView; render(); }
    if (target.matches("[data-search-new]")) {
      const input = container.querySelector("#newSearchName"); input.closest("details").open = true; input.focus();
    }
    if (target.matches("[data-create-search-group]")) {
      capture();
      const name = container.querySelector("#newSearchName").value.trim();
      const id = normalizeSearchText(name).replace(/[^a-z0-9]+/g, "-").slice(0, 80), kind = container.querySelector("#newSearchKind").value;
      if (!id || draft.groups.some((g) => g.id === id)) { toast("Enter a unique group name."); return; }
      draft.groups.push({ id, label: name, kind, tag: `${kind === "named" ? "search" : kind}-${id}`, aliases: [], classes: [], includes: [], disabled: false });
      groupId = id; render();
    }
    if (target.dataset.searchIgnore) {
      const id = target.dataset.searchIgnore;
      draft.ignoredProductIds = [...new Set([...draft.ignoredProductIds, id])]; draft.assignments[id] = []; render();
    }
    if (target.dataset.classificationPage) { page += Number(target.dataset.classificationPage); render(); }
    if (target.dataset.previewMiss) { const input = container.querySelector("#searchPreviewQuery"); input.value = target.dataset.previewMiss; preview(input.value); input.focus(); }
    if (target.dataset.resolveSearch) {
      target.disabled = true;
      try { await api(`/api/admin/search/${encodeURIComponent(target.dataset.resolveSearch)}/resolve`, { method: "POST", body: "{}" }); const miss = misses.find((m) => m.id === target.dataset.resolveSearch); if (miss) miss.status = "resolved"; render(); }
      catch (error) { toast(error.message); target.disabled = false; }
    }
  };
  container.onchange = (event) => {
    const target = event.target;
    if (target.id === "searchGroupSelect") { capture(); groupId = target.value; render(); }
    if (target.dataset.searchOption) draft[target.dataset.searchOption] = target.checked;
    if (target.id === "classificationView") { catalogView = target.value; page = 1; render(); }
    if (target.dataset.productGroups) {
      draft.assignments[target.dataset.productGroups] = [...target.selectedOptions].map((option) => option.value);
      draft.ignoredProductIds = draft.ignoredProductIds.filter((id) => id !== target.dataset.productGroups);
    }
  };
  container.oninput = (event) => {
    const target = event.target;
    if (target.id === "searchPreviewQuery") preview(target.value);
    if (target.dataset.brandAlias !== undefined) draft.brands[Number(target.dataset.brandAlias)].aliases = list(target.value);
    if (target.dataset.categoryAlias !== undefined) draft.categories[Number(target.dataset.categoryAlias)].aliases = list(target.value);
    if (target.id === "classificationQuery") {
      query = target.value; page = 1; render(); const input = container.querySelector("#classificationQuery"); input.focus(); input.setSelectionRange(query.length, query.length);
    }
  };
  container.onsubmit = (event) => { if (event.target.id === "searchGroupEditor") { event.preventDefault(); save(); } };
  render();
  return () => { container.onclick = null; container.onchange = null; container.oninput = null; container.onsubmit = null; };
}
