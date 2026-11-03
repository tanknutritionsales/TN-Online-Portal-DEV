# Search and delivery confirmation — manual QA

Updated 2026-11-03. Shopify search tags are live. The portal features in this patch require the updated app to be running locally or deployed.

## Before testing

- Use separate customer and admin browser sessions. Reloading still requires login.
- The login screen opens without the research-use notice. After successful customer sign-in, the notice blocks browsing for three seconds before acknowledgment. Admins go directly to their dashboard. Failed sign-ins do not show it. Customer logout/relogin starts a fresh notice. Registration keeps its separate terms/18+ confirmation.
- Test the shop against the normal local portal to use the current Shopify catalog. The new search controls are under **Admin → Product search**.
- For receipt checks without waiting three days, run `npm run preview:receipts` from the Online Portal folder. Open the URL printed by the command. Use `user / user` or `admin / admin`. This preview uses disposable generated data, excludes project credentials, and disables Shopify sync. Ctrl+C removes it. Restart it to reset the fixtures.
- Leave Shopify order sync disabled during test orders. This patch does not require new environment variables or a manual database migration.

## Customer search

| Check | Expected result |
|---|---|
| Search `oxandrolone`, `Anavar`, then `VAR` | The VAR product family appears. No unrelated word containing “var” is included. |
| Type `oxan`, `anav` or `diana` | Partial compound/alias names immediately find VAR or Dianabol/DB products, across Shop and Special Orders. |
| Search `GLP-1`, `GLP 1`, then `GLP1` | Equivalent umbrella results for semaglutide, tirzepatide, retatrutide and verified hybrids. Cagrilintide and GLP-1 Enhancer remain distinct. |
| Search `Reta` | Retatrutide stays specific. Other GLP families are not substituted. |
| Search `Sarms` | True SARMs appear. MK-677, Cardarine and SR9009 do not inherit the old broad SARM tag. Use “SARM related” to find related compounds. |
| Search `KF ECYA` | KF ECYA Shred and the confirmed KF IVENOM mapping are searchable. No ECYA ingredient formula is invented. |
| Search `oxandrolne`, `oxandroone` or `diannabol` | The closest valid spelling suggestions appear. Clicking one changes the query and shows results. |
| Compare `SEMA` / `SEMAX`, `CLO` / `ENCLO`, `MK677` / `MK2866`, `Melanotan` / `Melatonin` | Each remains distinct. Chemical codes are not silently corrected. |
| Add a brand, form and strength, e.g. `HD Reta 32mg` | Every constraint applies; 32mg does not match 32.5mg. mg and mcg remain separate. |
| Compare `CJC no DAC` and `CJC with DAC` | Only explicitly labelled DAC variants match. Unspecified blends are not assigned a DAC status. |
| Search `BPC` | Singles rank before blends containing BPC. Those blends carry a clear “Blend containing this compound” note. |
| Search a deferred product by its complete name | It remains searchable. Unknown formulas have no guessed ingredient matches. |
| Search with no text | Recommended preserves the incoming catalog order. For searches, relevance comes first and stock breaks ties. |
| Combine search, brand, goal, type and In stock filters; clear each chip | Filters combine, counts and pagination update, and clearing works. Maximum 30 products, with top/bottom pagers. |
| Repeat alias searches in Special Orders | Same matching and ordering; out-of-stock products stay selectable. |
| Use an alias in the featured-product picker and Product details picker | Admin pickers use the shared search. Existing custom selections survive changing the search. |

## Admin search management

- [ ] Open **Product search → Names & aliases**. Select a group, edit an alias, and preview it before saving. Compound identity, named groups, blend ingredients, and categories stay separate.
- [ ] Save; leave the page and reopen it. The change persists. A fresh customer login uses it.
- [ ] Try assigning one identical alias to two enabled compound groups. Saving should explain the conflict.
- [ ] Edit a brand/category alias. Confirm the preview respects the brand and the intended umbrella category.
- [ ] Create a named group, then assign a product in **Product classification → All products**. Preview, save, and verify it.
- [ ] Find an unclassified product. Use **Keep name search only**, save, then verify the product name still finds it and it leaves the pending queue.
- [ ] A clearly named new single compound can inherit an approved rule. An unverified new blend stays pending; it cannot acquire guessed ingredients.
- [ ] Enter a misspelled/unknown catalog term as a customer and leave it for at least 1.2 seconds. Under **Unmatched searches**, preview and resolve it. The feedback contains the term/count, without customer/account details. Contact details and URLs are excluded. Records expire after 30 days.
- [ ] Toggle spelling suggestions or anonymous feedback collection, save, and check a fresh customer session. Other shop/payment settings remain intact.

## Receipt and order closure

The disposable receipt preview contains an order shipped four days ago, one shipped yesterday, and one still processing.

- [ ] Log in as the preview customer. **QA-RECEIPT-DUE** opens a check-in on Home with its reference, products, quantities and tracking. The recent/processing orders do not prompt.
- [ ] Click **Not yet**. The order remains on Home and in My orders. Reload and log in again: it stays snoozed for the configured interval (default 24 hours).
- [ ] Restart the preview. Click **Report a delivery problem**. The Help form opens with the correct order selected; the order remains open. Sending the form creates a support request.
- [ ] Restart the preview. Click **Received**. The order disappears from Home and shows **Completed** in My orders, with tracking retained.
- [ ] In My orders, mark the recent shipment as received manually. A three-day wait is required for the automatic prompt, not for voluntary confirmation.
- [ ] The processing order has no receipt action. An unpaid or partially shipped order cannot be completed through the receipt endpoint.
- [ ] Confirm that only one automatic check-in opens per Home visit. Other orders remain accessible. Escape acts as Not yet; it does not confirm receipt.
- [ ] Check the completed order in admin: **Received by customer** and the confirmation timestamp are visible in dispatch history.
- [ ] In a local split-order test, add external tracking while Office tracking is entered but the parcel is not dispatched. The order stays Processing. Receipt is unavailable until Office dispatch and the external shipment are both recorded.
- [ ] For a fully shipped split order, the delay begins at final dispatch. Confirm receipt only once all parcels arrived. Editing tracking later does not restart the timer.
- [ ] Repeat confirmation or use two customer tabs. The stored receipt timestamp remains stable. Another account cannot confirm this order. Shark dispatch history, Shopify order references, allocations and stock are preserved.
- [ ] Under **Shop settings → Delivery confirmation**, change the delay/snooze interval or disable the prompts. Save and verify in a fresh customer session. Previously received orders remain completed.

The automated suite checks the exact 72-hour boundary, snooze expiry, ownership, concurrent confirmation, split-shipment ordering and preserved dispatch data: `npm run check:all`.

## Visual and interaction QA

- [ ] Desktop, tablet and phone: no horizontal overflow; search, filters, pagers, suggestions and modal buttons stay reachable.
- [ ] Light and dark themes: names, prices, availability, blend notes, fields and receipt messages remain readable.
- [ ] Keyboard: Tab reaches controls, selects and suggestions; focus stays inside the receipt dialog; Not yet has initial focus; Escape snoozes the prompt.
- [ ] Long names, several products and multiple tracking numbers wrap cleanly. Receipt product photos remain separate from labels/actions.
- [ ] Slow/error response: duplicate clicks are blocked, errors are readable, and a failed receipt submission leaves the dialog open for retry.
- [ ] Reload: login is required; saved baskets and persisted search settings remain available after login.

## Deployment review

- [ ] Review and commit the portal patch, then deploy it to the intended Netlify project.
- [ ] Repeat the key customer/admin checks on the deployed version with separate sessions.
- [ ] Confirm Postgres storage is still configured. Search settings use the existing settings record; receipt/anonymous feedback records use the existing customer-message store with separate record kinds.
- [ ] Check **System status** and one existing order in Shark. Receipt confirmation must not change the staff dispatch/packing workflow.
- [ ] Keep the remaining formula clarifications and the UPA M1 T label/title strength mismatch on the separate catalog review list.
