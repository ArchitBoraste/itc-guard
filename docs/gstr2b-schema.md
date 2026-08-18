# GSTR-2B Schema + GSTN's Own Matching Algorithm

**Source:** `GSTR2B_Offline_Matching_Tool_v2.9.exe` (Inno Setup → Node/Angular app).
Extracted from `app/dao/gstr2b/gstr2bDao.js` and `app/db/matchingtool/matchqueries.js`.

**Blocker #2: CLOSED.**

---

## 1. GSTR-2B JSON envelope

```json
{
  "chksum":  "...",
  "rtnprd":  "032026",
  "docdata": {
    "b2b":     [...],   "b2ba":    [...],
    "cdnr":    [...],   "cdnra":   [...],
    "isd":     [...],   "isda":    [...],
    "impg":    [...],   "impgsez": [...],
    "ecom":    [...],   "ecoma":   [...]
  }
}
```

Quarterly 2B additionally carries `m2Sum` / `m3Sum` with `itcsumm`.

**Ten sections.** IMS has eight. The two extra — `isd`/`isda` and `impg`/`impgsez` — are
exactly the ones that never enter IMS. That's the "IMS ≠ 2B" claim, confirmed in code.

## 2. `b2b` — supplier-grouped, then rate-grouped

```js
{
  ctin:     "27AABCU9603R1ZM",   // supplier GSTIN
  trdnm:    "Dell India Pvt Ltd",// may be null (v2.8 fix)
  supfildt: "11-03-2026",        // supplier's GSTR-1 filing date
  supprd:   "022026",            // supplier's return period
  inv: [{
    inum:      "INV/DEL/2026/4471",
    dt:        "08-02-2026",     // dd-mm-yyyy
    val:       118000,           // invoice value incl. tax
    typ:       "R",              // R | DE | SEZWP | SEZWOP | SEWP | SEWOP
    pos:       "27",
    rev:       "N",              // reverse charge Y/N
    itcavl:    "Y",              // ITC available Y/N
    rsn:       "",               // reason when itcavl = N (POS rule, 16(4)…)
    chksum:    "...",
    diffprcnt: 1,                // differential tax %; absent ⇒ 100
    cfs:       "Y",              // counterparty filing status
    itcent:    ...,
    splrprd:   ...,
    uplddt:    ...,
    items: [{ hsn, rt, txval, igst, cgst, sgst, cess }]   // ← RATE LINES
  }]
}
```

**Three levels: supplier → document → rate lines.** `items[]` confirms the rate-line
structure independently of the purchase-register finding. Totals are summed from `items`;
when `items` is absent the tool falls back to document-level amounts.

## 3. Other sections

| Section | Shape |
|---|---|
| `cdnr` / `cdnra` | `{ ctin, trdnm, supfildt, supprd, nt: [{ typ:"C"\|"D", val, pos, rev, itcavl, diffprcnt, items }] }` |
| `isd` / `isda` | `{ ctin, doclist: [{ docnum, docdt, doctyp:"ISDI"\|"ISDC", itcelg, … }] }` — note `itcelg`, not `itcavl` |
| `impg` | `{ portcode, boenum, boedt, refdt, recdt, txval, igst, cess, isamd }` — **no supplier GSTIN** |
| `impgsez` | same, plus SEZ supplier GSTIN |
| `ecom` / `ecoma` | e-commerce operator supplies u/s 9(5) |

## 4. Constant vocabulary (`utility/gstr2bConstant.js`)

```
Doc types:  I invoice · C credit note · D debit note · R regular
            DE deemed export · SEZWP / SEZWOP (also SEWP / SEWOP)
            ISDI / ISDC · CBW
Filing:     F filed · NF not filed
Flags:      Y · N · U · E
```

`SEWP`/`SEWOP` are normalised to `SEZWP`/`SEZWOP` on import — accept both.

## 5. Document reference key

GSTN's own composite key, worth copying:

```
docref = ctin | inum | financialYear | doctyp | supprd | rtnprd | N
```

Financial year is derived: month ≤ 3 ⇒ year − 1. Imports key on
`portcode | boenum | boedt | refdt | rtnprd`.

---

## 6. ⭐ GSTN's matching algorithm — and why ours beats it

Two SQL views define the entire official matcher.

**ExactMatch** — inner join requiring *every* field equal:
`SUPPLY_TYPE`, `GSTIN`, `UPPER(DOC_NUM)`, `DOC_TYPE`, `DOC_DATE`, `TAXABLE_VALUE`,
`TAX_AMOUNT`, `IGST`, `CGST`, `SGST`, `CESS`.

**ProbableMatch** — the "fuzzy" tier. Allows exactly **one** of `GSTIN` or `DOC_TYPE`
to differ. Everything else — document number, date, taxable value, every tax head —
must still be **exactly** equal.

That's it. The official tool has:

| | GSTN tool | Ours |
|---|---|---|
| `INV/2024/0891` vs `INV-2024-891` | ✗ no match | ✓ normalised |
| ₹2 rounding difference | ✗ no match | ✓ within tolerance |
| Date off by one day | ✗ no match | ✓ date proximity score |
| Digit transposition (₹47,200 → ₹42,700) | ✗ no match | ✓ flagged as VALUE_MISMATCH with delta |
| Confidence score / explanation | ✗ none | ✓ score breakdown per pair |

**This is your strongest demo line, and it's now evidence-backed:** the government's own
matching tool can only find invoices that already agree in every field. Every real-world
discrepancy — the exact cases a trader needs help with — falls into its unmatched pile for
manual eyeballing.

Use the same field vocabulary and doc-type semantics as GSTN (so results are directly
comparable), then beat it on normalisation, tolerance and explainability.

---

## 7. Purchase Register template v2.4 (from the same ZIP)

Header: `GSTIN of recipient*`, `Trade/Legal name`, `Financial year*`, `Tax period*`
Data columns from row 5:

```
GSTIN of Supplier/ECO* | Trade/Legal name | Type of inward supplies* |
Document type* | Document number* | Document date* |
Taxable value (₹)* | Integrated tax (₹) | Central tax (₹) |
State/UT tax (₹) | Cess (₹)
```

Dropdown enums (from the sheet's data validations):

- **Type of inward supplies:** `B2B` · `DE` · `SEZWP` · `SEZWOP`
- **Document type:** `Invoice` · `Debit Note` · `Credit Note`
- **Tax period:** month names *and* quarters (`April-June`, etc.)
- **Financial year:** `2019-20` … `2026-27`
- GSTIN fields: exactly 15 chars; amounts ≤ 9999999999999.99

**Note:** this template is **one row per document** — no rate column. It differs from the
GSTR-2 CSV template, which is one row per rate. Support both: this one as the primary
(it's the 2B-matching format), the GSTR-2 CSV as an alternate that needs the grouping pass.

---

## 8. ⚠️ Correction to earlier advice

I argued GSTR-2A was essential because it alone carries supplier filing status. The 2B
`b2b` record actually contains **`supfildt`** (supplier's GSTR-1 filing date) and **`cfs`**
(counterparty filing status). So 2B already answers "did this supplier file, and when."

What I claimed for 2A — the supplier's **GSTR-3B** status and registration-cancelled flag —
is documented in the GSTR-2A form under rule 60(1), and `cfs` here may refer to GSTR-1
rather than GSTR-3B. **Unverified.** Check a real 2B JSON before deciding whether 2A stays
in scope. If `cfs` covers GSTR-3B, drop 2A and save a parser.

`supfildt` is independently valuable regardless: it gives you **days-late per supplier per
period** directly, which is the core feature of the risk model — no inference needed.

---

## 9. Blocker status

| # | Blocker | Status |
|---|---|---|
| 1 | IMS JSON schema | ✅ closed |
| 2 | GSTR-2B JSON schema | ✅ closed |
| 3 | Saved-vs-filed flag | ✅ closed (`srcfilstatus` in IMS, `cfs`/`supfildt` in 2B) |
| 4 | GSTR-2A columns | ⚠️ may be moot — resolve §8 first |

**All build-blocking schema work is done.** Phases 2 and 6 can be written against real
field names.
