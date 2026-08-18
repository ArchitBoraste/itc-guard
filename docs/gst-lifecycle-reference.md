# GST ITC Lifecycle — Complete Reference

**Project:** Omnikon 2026 · Omni_FinTech_13 — GST Reconciliation for Small Traders
**Purpose:** Domain reference for the team, the idea PDF, and the `CLAUDE.md` in the build repo.

---

## Part 1 — The Cast of Forms

### Live forms

| Form | Filed by | What it is | Due |
|---|---|---|---|
| **GSTR-1** | Supplier | Statement of all outward supplies (sales) — invoice-level | 11th of next month (monthly filers) |
| **IFF** | Supplier (QRMP) | Invoice Furnishing Facility — optional monthly B2B upload for quarterly filers, so their buyers aren't starved of ITC | 13th of next month |
| **GSTR-1A** | Supplier | Optional amendment form. Fixes/adds records after GSTR-1 is filed, before the supplier's own GSTR-3B | Between GSTR-1 filing and GSTR-3B filing, same period |
| **GSTR-2A** | *Auto* | Dynamic, read-only mirror of what suppliers have filed. Never locked, never stops updating | Continuous |
| **GSTR-2B** | *Auto* | Static monthly snapshot. **The legal basis for claiming ITC** | Generated ~14th |
| **GSTR-3B** | Trader | Self-declared summary return. Sales, ITC claimed, net tax paid | 20th of next month (monthly filers) |

### Forms that exist but aren't returns

| Form | What it actually is |
|---|---|
| **GSTR-2** | **Suspended.** The original buyer-side return where you'd manually declare purchases. Killed early in GST rollout — replaced by auto-drafted 2A/2B |
| **GSTR-3** | **Suspended.** The original auto-generated comprehensive return. GSTR-3B was meant to be a temporary stand-in and became permanent |
| **GSTR-3A** | **Not a return — a notice.** Issued by the department to someone who failed to file on time, demanding compliance |

> There is no "GSTR-1B". The `1A / 2A / 2B / 3A / 3B` naming is historical accident, not a system.

**Out of scope for us:** GSTR-9 (annual return) and GSTR-9C (reconciliation statement). Annual, different problem, don't touch them.

### IMS — Invoice Management System

Launched Oct 2024, actions live from 14 Oct 2024. Not a form — a **dashboard** that sits between the supplier's GSTR-1 and the trader's GSTR-2B.

- Records appear the moment a supplier **saves** (not just files) in GSTR-1/1A/IFF
- Trader acts: **Accept · Reject · Pending · (no action)**
- Actions allowed from supplier-save until the trader files GSTR-3B; latest action overwrites
- **No action = deemed accepted** at 2B generation ← *the danger our app exists to prevent*
- Only **filed** records count at 2B generation. A saved-but-unfiled record is not money in the bank
- If a supplier edits a saved record before filing, it **replaces** the record in IMS and **resets** the trader's action
- After GSTR-3B is filed: accepted + rejected records leave IMS; **Pending records stay** until acted on or the Section 16(4) cut-off kills them

**Never enters IMS** (goes straight to 2B's "ITC Not Available"):
- ITC ineligible under Place-of-Supply rules
- ITC ineligible under Section 16(4) (time-barred)
- RCM (reverse charge) invoices

> ⚠️ Therefore **IMS ≠ 2B**. Any matcher that assumes every 2B row passed through IMS will generate phantom exceptions.

---

## Part 2 — The Lifecycle, Day by Day

Scenario: **Sharma Electronics**, a small trader in Pune. Purchases during **February 2026**.

### Four suppliers, four different fates

| Supplier | Invoice | Taxable | GST | What happens |
|---|---|---|---|---|
| Dell India | `INV/DEL/2026/4471` | ₹1,00,000 | ₹18,000 | Clean — files on time |
| Verma Cables | `VC-2026-338` | ₹47,200 | ₹8,496 | Typo, caught pre-filing |
| Krishna Traders | `KT/887` | ₹18,000 | ₹3,240 | Never files this month |
| Patel Hardware | `PH/2026/119` | ₹25,000 | ₹4,500 | Appears in 2B — but never bought |

---

### Feb 8 — the purchase

Dell delivers laptops. Invoice: ₹1,00,000 taxable + ₹18,000 GST = ₹1,18,000 paid.

Sharma's accountant enters it in the **purchase register** (Tally / Excel).

> **This is the only record in existence that says this credit should be coming.** The government has no idea. This is the entire reason our app can do something the portal cannot.

Same for the other three purchases through February.

---

### Feb 9 – Mar 4 — silence

Nothing happens. No form is due. The trader waits.

> 🟦 **APP:** Ingests the purchase register on upload. Normalises rows, extracts supplier GSTIN, invoice no., date, taxable value, tax split. Builds the **expected ITC ledger** for Feb 2026: **₹34,236 across 4 suppliers.**

---

### Mar 5 — the preventive check ⭐ *our differentiator*

App pulls current IMS state and diffs against the expected ledger.

Nothing has been saved by anyone yet. **This is normal** — GSTR-1 isn't due until the 11th. A naive app would fire 4 alerts here and train the trader to ignore it.

Instead the risk model ranks by supplier filing history:

```
Expected but not yet in IMS — 4 invoices, ₹34,236

  LOW RISK  (no action needed)
    Dell India        ₹18,000   files by 10th in 6/6 last months
    Patel Hardware     ₹4,500   files by 9th in 5/6

  HIGH RISK  (chase now — 6 days left)
    Verma Cables       ₹8,496   late 3 of last 6 months
    Krishna Traders    ₹3,240   MISSED entirely 2 of last 6
                                ₹11,736 at risk
```

> 🟦 **APP:** Generates pre-filled WhatsApp text for the two at-risk suppliers with invoice no., date and amount. Trader taps send. **No supplier login. No supplier account. They're just a data row.**

---

### Mar 9 — Dell saves

Dell saves its GSTR-1 draft. Invoice appears in Sharma's IMS instantly.

> 🟦 **APP:** Matches `INV/DEL/2026/4471` against purchase register. Exact match on GSTIN + invoice no. + taxable value + tax. → **Recommend ACCEPT.** Status recorded as `saved`, not `filed`.

---

### Mar 10 — Verma's typo, caught in the golden window

Verma Cables responded to the reminder and saved their GSTR-1 — but entered taxable value **₹42,700** instead of **₹47,200**. Classic digit transposition. ₹810 of tax credit at stake.

> 🟦 **APP:** Fuzzy matcher scores it — invoice no. exact, GSTIN exact, date exact, value off by ₹4,500. Not a "no match", a **value mismatch**. Flags it with the delta.

**Why this timing is gold:** Verma hasn't *filed* yet. A saved record can still be edited freely. One phone call, Verma corrects the draft, files clean on the 11th. **Zero credit lost, no GSTR-1A, no one-month delay.**

Contrast with catching the same error on Mar 16: Verma would need GSTR-1A, and the corrected ITC would land in Sharma's **April** 2B. Same error, one week later, one month of cash flow gone.

---

### Mar 11 — GSTR-1 due date

Dell files. Verma files (corrected). Patel files. **Krishna Traders does not file.**

Patel's filing includes `PH/2026/119` for ₹25,000 — goods Sharma never ordered or received. Wrong GSTIN on Patel's side; it belongs to a different customer.

---

### Mar 12–13 — GSTR-2A is live throughout

2A has been updating in real time all along. It's read-only and it's a mirror, not a pipeline — **since IMS launched, 2B is built from IMS actions, not from 2A.** We watch IMS, not 2A, because IMS is earlier (save-stage) and actionable.

---

### Mar 14 — GSTR-2B is generated

The snapshot. Only **filed** records counted.

| In 2B | Not in 2B |
|---|---|
| Dell ₹18,000 ✓ | Krishna ₹3,240 ✗ (never filed) |
| Verma ₹8,496 ✓ (corrected) | |
| Patel ₹4,500 ⚠️ (not ours) | |

> ⚠️ **Verify before the PDF:** the exact cut-off for what lands in a given 2B. Sources conflict between the 11th (GSTR-1 due date) and the 13th. Check the current GST portal advisory — the whole alert schedule depends on this date.

---

### Mar 14–19 — reconciliation, the decision engine ⭐

> 🟦 **APP output — not a mismatch list, an action list:**

```
GSTR-2B  Feb 2026  ·  Sharma Electronics
────────────────────────────────────────────────
✅ ACCEPT  (2 invoices · ₹26,496)
   Dell India     INV/DEL/2026/4471   ₹18,000  exact match
   Verma Cables   VC-2026-338          ₹8,496  exact match

❌ REJECT  (1 invoice · ₹4,500)
   Patel Hardware PH/2026/119          ₹4,500
   → In 2B, not in your purchase register. No goods received.
   → Rejecting purges it from 2B and notifies Patel.
   ⚠️ Verify before rejecting — a wrong reject costs you a month.

⏸️ PENDING  (0)

🔴 MISSING FROM 2B  (1 invoice · ₹3,240)
   Krishna Traders KT/887
   → No IMS record exists. Nothing to act on.
   → ₹3,240 DEFERRED to March 2B at the earliest.
   → This was flagged high-risk on Mar 5.

────────────────────────────────────────────────
Claimable this month:  ₹26,496  of  ₹34,236 expected
Deferred:              ₹3,240
Rejected:              ₹4,500  (correctly — never yours)
```

Trader reviews, confirms, acts on the IMS dashboard. Then clicks **Re-compute GSTR-2B** on the portal so the rejection is reflected.

> 🛡️ **Deemed-acceptance guard:** if the trader hadn't reviewed at all, Patel's ₹4,500 would be **deemed accepted** on the 20th — Sharma claims credit he isn't entitled to, and carries the risk. The app's countdown ("3 days left, 1 invoice unreviewed") is the whole point.

---

### Mar 20 — GSTR-3B filed

```
Output GST collected on sales       ₹52,000
Less: ITC (auto-populated from 2B)  ₹26,496
─────────────────────────────────────────────
Cash payable                        ₹25,504
```

Without reconciliation, Sharma would have deemed-accepted Patel's ₹4,500 and never chased Verma's ₹810 error.

On filing: Dell, Verma, Patel records **leave IMS**. Nothing pending remains.

> ⚠️ If Sharma missed the 20th entirely, the department issues **GSTR-3A** — a non-filing notice. Not a return. Not our concern, but know what it is.

---

### April — Krishna's late credit comes home

Krishna Traders finally files, reporting `KT/887` as an amendment in the next GSTR-1.

> 🟦 **APP:** Recognises this as a **carry-forward recovery** from February, not a new March purchase. Reconciles it against the still-open February expectation. → **Recommend ACCEPT**, credit realised in March's 2B.

Krishna's reliability score drops. Next month, Sharma gets warned about them on the 5th.

---

## Part 3 — Where the App Lives

```
     SUPPLIER SIDE                    GOVERNMENT                   TRADER SIDE
─────────────────────────────────────────────────────────────────────────────────
                                                              Feb 8: purchase
                                                              ↓
                                                              PURCHASE REGISTER
                                                              (only record that
                                                               expects this ITC)
                                                              ↓
                                                              🟦 APP: expected ledger
                                                              ↓
                                                       Mar 5: 🟦 PREVENTIVE CHECK
                                                              risk-ranked chase list
                                                              ↓
  saves GSTR-1  ──────────────►  IMS dashboard  ◄──────────── 🟦 match & recommend
  (editable!)                    (save-stage)                  ↓
                                                       Mar 10: 🟦 catch pre-filing
                                                              = zero loss
  files GSTR-1 (11th)  ────────► locked                        ↓
                                    │
                                    ▼
                            GSTR-2B (14th)  ─────────────────► 🟦 DECISION ENGINE
                            only filed records                  Accept/Reject/Pending
                                    │                           ↓
                                    │                    🛡️ deemed-acceptance guard
                                    ▼                           ↓
                            GSTR-3B (20th) ◄──────────────────  file & pay
                            auto-populated ITC
```

**Two modes, one product:**

| Mode | Window | Value |
|---|---|---|
| **Preventive** | 1st – 11th | Stop the loss before it happens. Risk-ranked. *Nobody else does this.* |
| **Reactive** | 14th – 20th | Decide Accept/Reject/Pending. Prevent deemed acceptance. |

---

## Part 4 — Rules That Will Bite the Matcher

1. **IMS ≠ 2B.** POS-ineligible, Sec 16(4)-ineligible, and RCM records skip IMS entirely.
2. **Saved ≠ filed.** Track state. A saved record can be edited (resetting your action) or deleted before filing.
3. **Post-filing fixes land next period.** A GSTR-1A amendment reaches the recipient's 2B in the **following** tax period. Never promise same-month recovery after the 11th.
4. **Rejects are expensive.** A wrongly rejected valid invoice costs the trader a month of credit and raises the supplier's liability. When ambiguous, recommend *verify*, not *reject*.
5. **Pending ages out.** Section 16(4) eventually kills pending records permanently. Needs an ageing alert.
6. **QRMP filers are on a different clock** — quarterly GSTR-1 (13th), IFF for the first two months, GSTR-3B on the 22nd/24th. Detect and branch.
7. **Silence is acceptance.** No action = deemed accepted at 2B generation.

---

## Part 5 — Open Items

- [ ] Confirm exact 2B cut-off date (11th vs 13th) from the current portal advisory
- [ ] Confirm QRMP GSTR-3B due dates by state group (22nd / 24th)
- [ ] Obtain a real GSTR-2B JSON sample to fix the parser schema
- [ ] Decide Section 16(4) ageing window for the pending alert
