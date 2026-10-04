# ITC Guard — audit and design review

Target: **https://itcguard.duckdns.org** (deployed build), audited 2 Oct 2026 with Playwright (playwright-core 1.63 driving installed Microsoft Edge, 1440×1000).
No application code was changed. Supporting material is in `docs/audit/`:

- `answer-key.mjs` / `answer-key.json`: the independent answer key. It reads only the raw fixture files (purchase register, `ims.json`, `gstr2b.json`, `ground_truth.json`, `suppliers.json`) plus the `xlsx` parser, and imports nothing from `api/src` or `web/src`. Every raw record joins to exactly one ground-truth document, with nothing left over, in all six periods.
- `screens/E*.png`: the screenshots cited below. E32 is the full April Still fixable page at 16 May, for context.
- `playwright/`: the scripts that produced every observation.
  - Install with `npm i` inside that folder.
  - Paths to the repo and to my scratch folder are absolute at the top of `lib.mjs`, `late.mjs`, `mapping.mjs` and `unmap.mjs`; change them before running.
  - `diagnostic-still-fixable-pairing.mjs` deliberately imports the app's own engine. It was used only to find the root cause of P16, never for expected values.

The deployed fixtures were verified byte-identical to a fresh run of `tools/generate-fixtures.js`, so the answer key reads the same data the server uses. A fresh visitor org holds March and April, plus the scripted April story: Mahavir Sales Corp `06-17/AMD/3538` is revised down by ₹5,000 after being confirmed.

Run the answer key with: `XLSX_FROM=<any package.json whose node_modules has xlsx> node docs/audit/answer-key.mjs`

---

## What passed

| Check | Result |
|---|---|
| Matching (#1) | All **2,461** documents, all six periods, land in the ground-truth bucket **with the right partner record**. This also holds after loading all six months and re-running every period. |
| Summary totals (#1, #3) | Expected, claimable, at risk, deferred, ineligible, outside IMS and grand total equal the answer key **to the paisa** in all six periods (table below). The identity line holds. |
| Dates (#7) | Every run is dated as of the 16th of the next month, cut-off the 11th, GSTR-3B the 20th. The picker follows each period loaded from Upload. |
| Export (#9) | IMS JSON is valid in all six periods: `rtin`/`reqtyp`/`invdata`, 8 sections, string `inum`/`nt_num`, `dd-mm-yyyy` dates, 2-digit `pos`, `rtnprd` MM, notes in `b2bcn`/`b2bdn`, remarks only on R and ASCII ≤ 250, no P on pending-blocked records; the UI also disables Pending on those rows (E30), and "Reject all" needs a second click with a warning (E33). Amounts echo the IMS download, and A/R/N counts equal the answer key. |
| Isolation (#10) | Session B gets 404 on session A's run, export, change feed and result PATCH, and A's totals are unchanged. **Reset my data** restores the exact preloaded state in about 6 s (E31). |
| Own-file upload | A Tally-style CSV of June (headers "Party GSTIN", "Bill No", "Bill Date", "Taxable Amount", …, dd/mm/yyyy dates, "3,63,097.00" amounts) got all 11 columns guessed correctly by the mapper (E36), and the Reconcile panel then offered the run (E38). 407 of 409 June documents then reconciled exactly as the answer key says; the other 2 are P31. |
| Console (#11) | **Zero** console errors and zero failed requests across every tab, period, as-of date and button (apart from the deliberate cross-tenant probes). |

| Period | Expected | Claimable | At risk | Deferred | "need a decision" app / real | Banner unactioned / risky | Export A/R/N | Still fixable (docs·suppliers·exposure) | "Left out" app / key |
|---|---|---|---|---|---|---|---|---|---|
| Feb | ₹1,51,91,508 | ₹1,42,70,480 | ₹5,59,566 | ₹82,861 | **54** / 19 | 368 / 19 ✓ | 349/7/12 ✓ | 4·2·₹1,24,137 ✓ | **27 / 28** |
| Mar | ₹1,36,70,228 | ₹1,23,56,730 | ₹11,11,983 | ₹1,50,505 | **58** / 31 | 382 / 31 ✓ | 351/6/25 ✓ | 8·6·₹3,31,688 ✓ | 20 / 20 |
| Apr | ₹1,45,38,162 | ₹1,27,78,287 | ₹13,62,927 | −₹5,577 | **72** / 32 | 384 / 32 ✓ | 352/9/23 ✓ | 4·3·₹1,36,066 ✓ | **32 / 34** |
| May | ₹1,44,87,341 | ₹1,29,45,251 | ₹12,27,022 | ₹55,536 | **63** / 27 | 379 / 27 ✓ | 352/10/17 ✓ | 6·5·₹3,52,448 ✓ | **29 / 30** |
| Jun | ₹1,48,11,358 | ₹1,36,59,954 | ₹7,31,387 | ₹2,28,581 | **58** / 24 | 375 / 24 ✓ | 351/7/17 ✓ | 10·5·₹4,72,996 ✓ | **22 / 23** |
| Jul | ₹1,39,87,597 | ₹1,29,82,176 | ₹6,74,851 | ₹68,991 | **51** / 18 | 368 / 18 ✓ | 350/5/13 ✓ | 3·3·₹1,40,877 ✓ | **28 / 29** |

The engine is sound. The problems are in what the screens **say** around its numbers, in the recommendation rules, and in what happens across periods.

---

# Part 1 — Correctness findings

All findings are **CONFIRMED** against raw data or by reproduction unless marked otherwise. "Preloaded" means a fresh visitor session.

### BLOCKER

**P1. The banner says nothing will be deemed accepted while 22 records go to the portal as "No action".**
- **Screen:** April, Actions → banner on every screen.
- **Steps:** On Actions, click "Confirm all" on every group (Accept 352, Verify 20, Chase supplier 2, Deferred 2) and "Reject all".
- **Screen says:** the banner turns green: *"Every IMS record has a decision. Nothing will be deemed accepted by default for April 2026."* (E24)
- **Rule says:** the export still carries **22 records with action N**. By the app's own text, N "is precisely the state that gets deemed accepted at GSTR-3B". Those 22 include all **6 phantom invoices not in the books (₹2,23,569)**.
- "Confirm all 20" on the Verify group (E08) records *No action* on records the app itself says need human verification, in one click.
- The same screen still says **"72 need a decision"** and **At risk ₹11,43,464 — "Open decisions"**.

**P2. The preloaded March period opens as "out of date" and its export is blocked; every earlier month does the same once a later one loads.**
- **Steps:** Fresh session → Tax period March → Actions (E01, E01b).
- **Screen says:** *"This run is out of date — 804 records arrived after this run and appear nowhere in it."* Download IMS action JSON is disabled.
- **Data says:** 804 = April's 384 IMS + 420 2B records. They belong to April, not March.
- Loading May makes April stale (788 records, E20); June makes May stale (774); and so on.
- Re-running every period gave results **identical** to the answer key, so the warning is false.

### WRONG

**P3. Filed value mismatches are always "Reject", whatever the direction or size.** Actions, all periods (E04, E06, E07).
- **20** filed mismatches have the portal **lower** than the books, and all are recommended Reject. That defers ₹7,67,974 of portal credit that could be accepted now, with only the difference chased. Example: Mahavir `06-17/AMD/3538` (scripted story), portal ₹843 lower on ₹1,21,033 → Reject.
- **22** filed mismatches with a tax difference **≤ ₹100** are rejected outright. Examples:
  - Unity Distributors `06-17/PNQ/2983` (Apr): +₹2.25 on ₹57,316 → Reject.
  - Fortune Hardware `A/2010` (Mar): +₹1.35.
  - Fortune `A/2016` (Apr): −₹3.15.
- **Rule (brief #8):** where the portal is lower, accept and chase the difference; where it is higher, reject. Full list: `answer-key.json → periods.*.valueMismatches` (fields `direction`, `briefAt16`).

**P4. Credit-note mismatches are treated like invoices.**
- **Example:** Kiran Systems credit note `C/1477` (Apr, portal ₹9 lower) → "reject … **that credit arrives next period**" (E05).
- Rejecting a credit note keeps credit the trader's own books say must be given back (₹3,812 here). There is no "credit arriving" for a note.
- Same pattern in National Supply `Z3221` (Feb) and Fortune `A/2032` (Jun).

**P5. Accepting a mismatch counts the books amount as claimable.**
- **Steps:** Override Mahavir from Reject to Accept.
- **Result:** Claimable rises by **₹1,21,033 (books)**. Only the portal's ₹1,20,190 can be claimed, so claimable is overstated by ₹843.

**P6. A late arrival from an earlier month is shown wrongly in both months.**
- **Setup:** April's unreported Patel Systems invoice `1-02678` (₹22,850) was added to May's IMS and 2B files and uploaded through Upload.
- **In May (E34):** *"On the portal but not in the purchase register … verify no goods were received before rejecting"*. It is in April's books.
- **After re-running April (E35):** the same May record is **MATCHED in April**, and April's claimable rises ₹22,850, though the credit is only in May's 2B.
- **Exports:** April's export now carries it with **A** and May's with **N** (`rtnprd 05` in both) — contradictory files for one record.

**P7. "N need a decision" counts every non-matched record.**
- It includes reverse charge and ineligible records that have no action. The counts are 54/58/72/63/58/51 against 19/31/32/27/24/18 real decisions.
- The banner on the same screen says "Review 32" (E02), and the count stays 72 after everything is decided (E24).

**P8. "Amounts differed from your books on N of M documents" is false for 22 of 24 suppliers that show it (April preloaded).**
- It counts invoice-number-only differences (amounts identical), phantom records, reverse charge and ineligible records.
- Example: Reliable Sales Corp "1" is a phantom not in the books (E18).
- Example: Laxmi Components shows "Mismatches 2"; both are invoice-number differences with identical amounts (E17).
- These counts also feed the risk band.

**P9. QRMP suppliers are judged on the monthly 11th.**
- Fortune Hardware & Co is QRMP (true cut-off the 13th; `suppliers.json`), but the app shows **"MONTHLY"** at MEDIUM confidence with no "(assumed)" tag.
- On 11 Jun it says *"Cut-off is today"*; on 12–13 Jun and 12–13 Jul it says *"Cut-off passed … needs GSTR-1A"*, while the free-fix window is still open (E21, E21b).
- All 7 QRMP suppliers are labelled MONTHLY.
- Krishna Systems & Co is told *"filed late in 3 of the last 6 months"*; against its real cut-off it was late twice (E23).

**P10. The Still fixable group header contradicts its own rows (known example).**
- **Screen:** April, as of 16 May (and the 12th).
- **Screen says:** *"Every supplier here is past their own cut-off **with nothing reported**"*.
- **Rows say:** Anand Systems and Kiran Systems are *"Saved with different amounts"* (E10).
- In March, 5 of the 8 documents under the same header are saved.

**P11. The Still fixable introduction is false at the default date (known example).**
- *"Nothing here is final, so one phone call can still put it right"* sits above rows that all show *"Cut-off passed"*. This happens at the default as-of in **all six periods** (E09).

**P12. One card contradicts itself.**
- Row note: *"While it is a draft the supplier can correct it **for free**"*.
- Directly above it: *"Their cut-off has passed. A correction now needs GSTR-1A"* (E11).

**P13. Two different "today"s on one screen.**
- Setting Still fixable's As of to 5 May leaves the sticky banner reading *"As of 16 May 2026 · After 2B, before GSTR-3B · 4 days left"* (E13).
- Summary and Actions also stay on 16 May.

**P14. "Re-run reconciliation" erases the "1 decision you made was dropped" warning.**
- The banner and the row's reset flag disappear, although nothing was decided again (E26 → E25).
- The stale banner in P2 tells the trader to press exactly this button.

**P15. The Suppliers screen lists 108 suppliers for 40 real ones.**
- Each supplier GSTIN typo on the portal becomes its own supplier. "National Supply Co" appears 5 times (E22).

**P16. Still fixable's "Left out" line undercounts in 5 of 6 periods (table above).**
- Its books-vs-IMS-only match pairs never-in-IMS purchases with unrelated records:
  - April reverse-charge `1582J` → phantom IMS `1587J` (score 0.7175).
  - April ineligible `C/2654` → **March** `C/2650` (0.701).
- April's line is short by 2 documents and ₹45,260 (E12).
- Root cause was found with a diagnostic that called the app's own engine. This was not used for the answer key.

**P17. A supplier row mixes time windows, and risk is not recomputed.**
- National Supply Co (May view) shows "Periods 3 · Docs 68" but "differed … on 10 of 36 documents".
- Risk is saved when a month is loaded and never recomputed. After loading Feb last, July still says "5 months of history" with 6 loaded.

**P30. Re-uploading a corrected register adds rows instead of replacing them, and creates invoices that don't exist.**
- **Screen:** Upload → June, in a fresh session.
- **Steps:**
  1. Load June from your own files (CSV register, IMS, 2B) and reconcile.
  2. Re-upload the register with one column mapped differently (here "Document type" unmapped; see P32).
  3. Re-run June.
- **Result:** June holds **418 register rows for 399 documents** and **428 results**. The 19 credit and debit notes now exist twice; the invoice copies have no portal match, so they become **"In your books, never reported"**.
  - Deferred rises from ₹2,28,581 to **₹9,21,023**.
  - Expected ITC is overstated by **₹7,28,169** against the answer key.
  - Still fixable would draft chase messages for 19 invoices that do not exist (E39).
- The commit also did not rebuild the run: it showed "19 records arrived after this run" until re-run by hand.
- Nothing in the UI removes an earlier upload except "Reset my data", which wipes every period.

**P31. The per-rate CSV path merges two documents that share a number and date.**
- **Example:** June, Deepak Sales Corp & Co (`33VHXWA2766G3ZP`), two invoices both numbered `D1404` and dated 16 Jun (₹35,727.50 and ₹87,231.48 tax).
- The CSV adapter groups rows by supplier + number + date, so they become one book entry of ₹1,22,958.98.
- **Result:** the correct ₹87,231 invoice is recommended **Reject** (shown as a value mismatch), and the other appears as "not in your books". Expected ITC is overstated by ₹35,727.50.
- GST requires invoice numbers to be unique within a financial year, so this should be rare with real data. The fixture's duplicate case is what exposes it.

### CONFUSING

- **P32. A real Tally export is refused.** Voucher type "Purchase" gets *row 2: document type has unknown value "Purchase"* and the whole file is refused (E37). The natural workaround, unmapping "Document type", silently parses every credit and debit note as an invoice: credit notes would then *add* credit instead of reducing it. P30 shows those 19 rows arriving as invoices.
- **P33. CSV uploads vanish from the upload history.** A GSTR-2 CSV carries no file-level period, so its upload has no tax period. The history on Upload is filtered by period, so the CSV never appears in it; only June's IMS and 2B uploads are listed.
- **P18. Rounding is inconsistent.** On the same screen: "₹1.08 L owed to you" and "₹1,07,639 owed to you"; card "₹77,687" next to sentence "Rs. 77,687.04". The footer says amounts are "rounded to whole rupees only for display" (E09, E11).
- **P19. Negative headline amounts.** The bucket card "In your books, never reported **−₹5,577**" (E03) and the Actions Deferred group header (−₹5,577) show the net that the Deferred card deliberately splits.
- **P20. One supplier, one date, three labels:** "Too early to say" (Suppliers, E16), "Worth a look" (Still fixable on 5 May, E14), "Chase these" (on 16 May).
- **P21. How to use is wrong about the demo.** It says *"One tax period of sample data … is loaded"*; two are (E19). It tells judges to look at "the reasons under a HIGH band", but with the preloaded two months no HIGH band can appear.
- **P22. The chase message misfires.** For a record already saved, past cut-off: *"Please still report it so the credit is not lost altogether"*. Anand's message chases a ₹10.08 difference through GSTR-1A.
- **P23. Re-loading a loaded period erases the story.** Re-loading April from Upload silently removes the demo story: Mahavir is MATCHED again and the reset banner is gone (E27).
- **P24. Group buttons mean odd things.** The Deferred group offers "Confirm all 2" (records *No action* on books-only rows) and shows "2 open" (E08b). Accepting a *Verify* suggestion counts as an "Overridden" decision.
- **P25. The fixtures contradict the portal timeline.** A CA will notice these:
  - Every "Saved, not filed" record belongs to a supplier whose 2B shows GSTR-1 filed before the cut-off. Example: Anand Systems filed on 10 May, yet its record is still a draft on 16 May. When GSTR-1 is filed, saved records are filed with it.
  - 5 filings on or after the 14th still sit in that month's 2B, which generates on the 14th.
  - On "as of 5th", records count as filed although the supplier's filing date is the 6th–10th.
- **P26. Inconsistent cross-tenant response.** `GET /api/runs/<other org's run>/results` returns 200 with an empty list instead of 404. No data leaks.

### COSMETIC

- **P27. The active tab is unreadable while the pointer rests on it.** `.nav-item:hover` outranks `.is-active`, giving white text on #F6F7F9 (E28).
- **P28. Awkward phrasing:** "Cut-off is today · 0 days left", "0 days away", "the last 1 month" (E15).
- **P29. Phone width breaks the layout.** At 390 px the page overflows by 494 px and the banner wraps one word per line (E29).

### Found in code and docs (not visible as a single screen)

- **P34. The matching weights add up to 1.2 (CONFUSING, CONFIRMED in code).**
  - **Where:** `api/src/matching/score.js` sets the invoice-date weight to **0.35**; CLAUDE.md's scoring table gives 0.15.
  - **Effect:** scores are divided by the 1.2 total, so date closeness counts for about 29% of the score instead of 15%.
  - Together with the 0.70 threshold, this lets different invoices pair. P16's pairs differ in number, sit 6 days apart and differ by 35–44% in tax, yet still score 0.70–0.72.
  - The score popover shows these weights, so a judge who adds them up will notice.
  - **Fix:** either change the code back to the documented weights, or update the CLAUDE.md table and justify the change with the `sweep-weights` results. Re-test P16 afterwards.
- **P35. About contradicts How to use and the live site (COSMETIC, CONFIRMED).**
  - About says *"No login — every request is served as a single stubbed trader."*
  - On the deployed link every visitor gets a private copy of the data, as How to use says.
  - **Fix:** say "no login; on the public demo each visitor gets their own private copy".
- **P36. README statements that are wrong (CONFUSING, CONFIRMED against `fixtures/suppliers.json`).**
  - README says *"all 108 generated suppliers are MONTHLY"*. There are **40** generated suppliers; the 108 is the Suppliers-screen count inflated by GSTIN typos (P15). **7** of the 40 are quarterly (QRMP) filers.
  - It concludes the per-supplier cut-off problem is "latent rather than live". It is live: see P9 (Fortune Hardware & Co, Krishna Systems & Co).
  - It says no supplier can reach a HIGH band with two seeded periods, presented as a limit. With all six months loaded, 12 suppliers reach HIGH. The real issue is that the preloaded demo, and How to use (P21), point judges at a band they cannot see.
- **P37. Money in sentences uses floating-point division (COSMETIC, CONFIRMED in code).**
  - **Where:** recommendation reasons and IMS remarks in `api/src/matching/recommend.js` (`formatAmount`), and the Chase supplier group header in `web/src/lib/vocab.js` (`portalActionClause`). Both compute `paise / 100` and format the result.
  - **Rule broken:** CLAUDE.md says "Never floats for currency"; the About screen claims "Money never becomes a float … to the screen".
  - No wrong figure was observed at these magnitudes, but this is also where paise leak into the text (P18).
  - **Fix:** format from integer paise, as `web/src/lib/money.js` already does.

---

# Part 2 — Design review

**A. Screen structure.** **Recommend Option 3, borrowing Option 2's split inside it.**
- **Proposed change:**
  - Rename the screen **"Chase suppliers"** so the name is true on every date.
  - Group rows **per supplier's own cut-off** into "Before the cut-off — fix is free (N days left)" and "Missed the cut-off — credit moves to ⟨next month⟩".
  - Generate the intro and headers from what is actually listed.
  - Move saved-with-wrong-amount records past their cut-off to Actions with a link, because the decision there is now an IMS accept/reject.
- **Why not Option 1:** state ("on the portal or not") is a portal concept. A trader thinks "who do I phone, and what does waiting cost". The "saved with wrong amounts, pre-cut-off" screen would also be empty from the 12th onwards.
- **Why not Option 2 as two screens:** each half is empty for half the month, and an empty tab trains the trader to stop opening it.
- **Who:** trader. **Effort:** medium. **Priority:** must.

**B. Period navigation.**
- **Problem:** "Tax period April 2026", "as of 16 May", "Today is 2 Oct 2026" and a screen-local as-of compete. The Upload picker lists 6 months while the header lists only loaded ones. Re-loading a period silently replaces it.
- **Proposed change:**
  - One header line, e.g. "April 2026 return · filing in May · demo date 16 May".
  - A single app-wide as-of that the banner, Summary and Actions all follow.
  - One period list that marks loaded and not-loaded months.
  - A confirmation before re-loading a period.
- **Who:** all. **Effort:** small–medium. **Priority:** must for the clock; should for the rest.

**C. Cross-period flow (tested with a constructed file, P6).**
- **Problem:** late arrivals show as "not in your books" and can be claimed in the wrong month. April's Deferred items never re-appear in May.
- **Proposed change:**
  - Match a later month's records against *open expectations* from earlier months.
  - Credit belongs to the month whose 2B contains it.
  - Add a view **"Arrived from earlier months / still expected"** that links each arrival back to the original Deferred or mismatch row.
  - One record appears in exactly one export.
- **Cannot be tested:** amendments (`b2ba`, `cdnra`, `ecoma` are empty in every fixture), GSTR-1A corrections, and `oinum` linkage. Credit notes' original-invoice links are also not used.
- **Who:** CA, trader. **Effort:** large. **Priority:** must.

**D. Pending carry-forward.**
- **Not tracked:** the engine never recommends Pending, nothing lists Pending records in later months, and there is no ageing warning.
- **Unverified risk (from code):** a later IMS download that still carries an earlier month's Pending record would stamp it with the earlier month, and it would be filtered out of the later month's run.
- **Proposed change:** a Pending and Deferred register with age and a deadline.
- **GST rule (I am fairly but not fully sure):** Section 16(4) bars availing ITC after 30 November following the end of the financial year, or the annual return date if earlier. The exact IMS rules on how long Pending may be held should be checked.
- **Who:** CA. **Effort:** medium. **Priority:** should.

**E. What the trader does next.**
- **Problem:** after "Confirm all" nothing says "now upload this file in IMS, then re-compute GSTR-2B, then file 3B by the 20th".
- **Proposed change:**
  - Block or warn on export while N records include phantoms or Verify items.
  - Add a per-supplier "chased on / follow up by" field.
  - Show the **GSTR-3B Table 4 figures** (ITC to claim, reversals). That is the number a trader actually types.
  - Show the rupee amount to chase when accepting a lower portal figure.
- **Who:** trader. **Effort:** medium. **Priority:** must for the export warning; should for the rest.

**F. Language.** Effort: small. Priority: should.
- **"No action" has two opposite meanings:** a group of records with nothing to do, and the IMS action N, which means deemed acceptance.
- **Five names for similar money:** "At risk", "Not yet safe", "ITC at stake", "Credit at stake", "rides on them".
- **"Verify" vs "Probably the same invoice":** two labels for the same thing.
- **Engine codes on cards:** `VALUE_MISMATCH` and `NON_IMS` are printed on bucket cards.
- **Tooltip jargon:** "ispendactblocked = Y".
- **Unexplained terms:** "Outside IMS", "Shows in 2B only", "ISD", "Bill of entry", "QRMP", "normalisation", "provisional read".
- **Sentences that need a second read:** the "two problems pulling opposite ways…" paragraph, the "These net to −₹5,577, which is why the net is not the headline…" sentence, and the "never missed their 11th … most file about 4 days early…" reason.
- **Density:** most screens open with 3–6 explanatory paragraphs. Move them into disclosures.

**G. What a GST practitioner would also expect.**
- **Configurable materiality tolerance** (₹1 absolute is far tighter than practice). Effort small, priority must, with P3.
- **GSTIN checksum validation** to flag typo GSTINs rather than create suppliers. Small, should.
- **An honest supplier-scheme inference:** early filers cannot be told apart. Keep "assumed" until known, or let the user set it. Small, must.
- **Suppress unnecessary N records in the export.** Sending N for every undecided record could overwrite actions already taken on the portal. *Unverified:* every fixture has action N, so this can't be tested. Small, should.
- **Show the reverse-charge liability** the trader must pay. Small, could.
- **CA workflow:** multi-client switching, Excel working papers, a decision log. These are outside the CLAUDE.md scope and listed only as future work. Large, could.
- **Realistic demo data:** fix P25, and add a "5th of the month" IMS snapshot so preventive mode can really be shown. Medium, should.
- **Mobile layout:** traders use phones. Medium, should.

**Persona notes.**
- **Trader:** wants one "do this today" list, and gets four overlapping counts (72 / 32 / 4 / 384).
- **CA:** would distrust P3–P6 and P8 on sight.
- **Judge (5 minutes):** clicks March and sees "out of date"; sees "72 need a decision" against "Review 32"; finds Still fixable's headline untrue at the default date. The strongest material (exact matching, the export) is buried.

---

# Top ten changes, in order

1. **Never present N as a decision.** Fix the banner, make Verify's "Confirm all" honest, and warn or block the export while phantoms or Verify items go as N (P1).
2. **Stop false "out of date" runs** caused by neighbouring months, and stop re-runs from erasing invalidated decisions (P2, P14).
3. **Make mismatch recommendations direction-, size- and document-type-aware.** Accept lower and chase the difference; reject higher; use a materiality tolerance; invert for credit notes. Claim min(books, portal) on accept (P3–P5).
4. **Restructure Still fixable** per Part 2A, with **one app-wide as-of clock** that every screen follows, and with its own matching fixed so documents cannot silently drop out (P9–P13, P16).
5. **Cross-period correctness:** late arrivals belong to the month whose 2B holds them, link to earlier expectations, one export per record (P6, C).
6. **Make re-uploads replace, not append.** A corrected register must replace the previous one for that period (with a way to remove an upload), and Tally's "Purchase" voucher type should be accepted (P30, P32).
7. **Make supplier facts true:** "differed" means value mismatches only, merge typo GSTINs, consistent windows, "assumed" schemes, QRMP cut-offs (P8, P9, P15, P17).
8. **One count for "needs a decision"** everywhere, equal to open decisions (P7, P20).
9. **Plain-language and consistency pass:** "No action", money terms, rounding, negative headlines, How to use (P18, P19, P21, F).
10. **Add a Pending/Deferred carry-forward register with deadlines, plus GSTR-3B Table 4 figures** (D, E).

---

## Coverage and limits

**Covered:**
- All six periods, loaded from Upload.
- Every tab, with every `<details>` opened and every "Show more" expanded.
- As-of dates 5th, 11th (cut-off), 12th, 13th, 14th and 16th on Still fixable.
- Every group and row action on April, plus Reset my data, two-session isolation and the IMS export for every period.
- Own-file upload through the column mapper.

**Not testable with these fixtures:**
- Amendment sections (`b2ba`, `cdnra`, `isda`, `ecoma`, `ecom`), all empty.
- Records already actioned on the portal: every IMS record has action N.
- Pending records carried in a later IMS download.
- A real portal upload of the exported JSON.

**Not tested:**
- QRMP GSTR-3B due dates (22nd/24th), still listed as open in `docs/gst-lifecycle-reference.md`.
- Screens at widths other than 1440 px and one 390 px check.
- Keyboard and screen-reader use.
