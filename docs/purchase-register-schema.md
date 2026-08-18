# Purchase Register & Supplier-Side Schemas

**Source:** GSTN Returns Offline Tool V3.2.4 (`gst_offline_tool.zip`, Dec 2025).
Section-wise CSV templates — the government's own canonical formats.

> This is the **Returns** Offline Tool (GSTR-1/GSTR-2), not the GSTR-2B Matching Tool.
> Blocker #2 (GSTR-2B JSON schema) is still open. But this closes something we hadn't
> listed: the canonical purchase-register format.

---

## ⚠️ 1. The assumption this breaks

**One CSV row is NOT one invoice. It's one invoice × one tax rate.**

From the real sample data:

```
A/1003, 14-Jul-17, ₹50000, rate 12, taxable 10000
A/1003, 14-Jul-17, ₹60000, rate  5, taxable 35000
```

Same invoice, two rows, two rates. The `Invoice Value` repeats on every row (and here
even disagrees between them — real data is messy).

**Consequence for the matcher:** rows must be **aggregated into invoices** before
matching, keyed on `(supplierGstin, invoiceNo, invoiceDate)`. Sum taxable value and each
tax head across the rate rows. The build spec's `ExpectedInvoice` shape needs a
`rateLines[]` child, and the canonical shape is produced by a grouping pass, not a
row-by-row map.

Same applies on the portal side — 2B carries rate-level detail too.

---

## 2. Purchase register — canonical columns (GSTR2/b2b.csv)

```
GSTIN of Supplier | Invoice Number | Invoice date | Invoice Value |
Place Of Supply | Reverse Charge | Invoice Type | Rate | Taxable Value |
Integrated Tax Paid | Central Tax Paid | State/UT Tax Paid | Cess Paid |
Eligibility For ITC |
Availed ITC Integrated Tax | Availed ITC Central Tax |
Availed ITC State/UT Tax | Availed ITC Cess
```

| Field | Values seen | Notes |
|---|---|---|
| `Invoice date` | `12-Jul-17` | **`d-MMM-yy`** — a *third* date format (IMS uses `dd-mm-yyyy`, we use ISO) |
| `Place Of Supply` | `29-Karnataka` | Code **and** name, hyphen-joined. IMS wants bare `29` |
| `Reverse Charge` | `Y` / `N` | RCM is flagged here — use it to route RCM rows away from IMS matching |
| `Invoice Type` | `Regular`, `SEZ supplies without payment`, `Deemed Exp` | Maps to IMS `inv_typ` (`R`/`SEWOP`/`DE`) |
| `Eligibility For ITC` | `Inputs`, `Capital goods`, `Ineligible`, `Input services` | The trader's own eligibility call |
| Amounts | `"4,981"` | **Quoted with thousands separators.** Strip commas before parsing |

Make this the default column mapping. A trader using GSTN's own template gets zero-config
import; everyone else uses the mapping UI.

## 3. Credit/debit notes (GSTR2/cdnr.csv)

```
GSTIN of Supplier | Note/Refund Voucher Number | Note/Refund Voucher date |
Invoice/Advance Payment Voucher Number | Invoice/Advance Payment Voucher date |
Pre GST | Document Type | Reason For Issuing document | Supply Type | ...
```

- `Document Type`: `C` credit / `D` debit
- `Reason For Issuing document`: coded — `01-Sales Return`, `03-Deficiency in services`
- Notes reference their **original invoice** — that link must be preserved, it's how you
  net a credit note against the invoice it adjusts

## 4. Imports (GSTR2/impg.csv)

```
Port Code | Bill Of Entry Number | Bill Of Entry Date | Bill Of Entry Value |
Document type | GSTIN Of SEZ Supplier | Rate | Taxable Value |
Integrated Tax Paid | Cess Paid | Eligibility For ITC | ...
```

`Document type` is `Imports` or `Received from SEZ`. No supplier GSTIN for overseas
imports — the blocking key must fall back to Port Code + BoE number.

## 5. ITC reversal (GSTR2/itcr.csv)

Fixed rows for rules 37(2), 42(1)(m), 43(1)(h), 42(2)(a), 42(2)(b). Out of scope for the
prototype, but this is where a "credit reversed because supplier didn't pay" feature would
eventually live (rule 37).

---

## 6. Real invoice numbers — evidence for the matcher

Straight from GSTN's own sample data:

```
1000          A1001        1000A        A/1001       A/1002
1/1005        A-10010      1-10010      A2001
A-KNP/1000/06-17           06-17/LKO/1052            06-17/LKO/1053
```

This is exactly the mess the fuzzy matcher exists for. Two things to note:

1. **Embedded dates and branch codes** (`KNP`, `LKO`) are common. Normalisation must not
   discard them — they're often the only thing distinguishing two invoices.
2. **Collision risk:** `A/1003` and `A1003` normalise identically under
   strip-non-alphanumeric. So does `1-10010` vs `1/10010`. Never match on normalised
   invoice number alone — that's why value, date and GSTIN carry 60% of the score.

Use this list as the seed corpus for the fixture generator's invoice-number formats.
It's real, and "we tested against GSTN's own sample data" is a good line in the demo.

---

## 7. Spec changes required

| Was | Now |
|---|---|
| Row → `ExpectedInvoice` | Rows → group by `(gstin, invNo, date)` → `ExpectedInvoice` with `rateLines[]` |
| Two date formats | Three: `d-MMM-yy` (PR), `dd-mm-yyyy` (IMS), ISO (internal) |
| POS = bare code | PR gives `29-Karnataka`; split before sending to IMS |
| Amounts are numbers | May be comma-formatted strings. Sanitise in the adapter |
| RCM discovered from 2B | PR flags it directly via `Reverse Charge` = Y |
| Notes as edge case | Notes carry an original-invoice link — needed to net ITC correctly |

---

## 8. Still open

| # | Blocker | Only source |
|---|---|---|
| 2 | **GSTR-2B JSON schema** | GSTR-2B Matching Offline Tool ZIP, or a real 2B download (needs portal login) |
| 4 | GSTR-2A column names | Real 2A Excel export (needs portal login) |
