# IMS JSON Schema — Recovered from Official Offline Utility v1.1

**Source:** `IMS_Offline_Utility_V1_1.xlsm`, GSTN. Extracted from the VBA modules
(`ImportMod.bas` = portal → tool, `ExportMod.bas` = tool → portal).
**Status:** authoritative for the offline round-trip. Blockers #1 and #3 are CLOSED.

---

## 1. Download envelope (portal → us)

```json
{
  "imsDetails": {
    "b2b":    [ ... ],
    "b2ba":   [ ... ],
    "b2bdn":  [ ... ],
    "b2bdna": [ ... ],
    "b2bcn":  [ ... ],
    "b2bcna": [ ... ],
    "ecom":   [ ... ],
    "ecoma":  [ ... ]
  }
}
```

Errors returned by the portal after an upload come back under `imsDetailsErr`
with the same section keys, plus `error_msg` per record.

## 2. Upload envelope (us → portal)

```json
{
  "rtin":    "27AABCU9603R1ZM",
  "reqtyp":  "SAVE",
  "invdata": { "b2b": [...], "b2ba": [...], "b2bdn": [...],
               "b2bdna": [...], "b2bcn": [...], "b2bcna": [...],
               "ecom": [...], "ecoma": [...] }
}
```

`rtin` = the **recipient's** (our trader's) GSTIN. `reqtyp` is the literal string `SAVE`.

---

## 3. `b2b` record

### Written on upload

| Key | Type | Notes |
|---|---|---|
| `stin` | string | Supplier GSTIN |
| `inum` | string | Invoice number — **always a string** (v1.1 fixed 16-digit numerics being coerced to numbers) |
| `inv_typ` | string | `R` regular · `DE` deemed export · `SEWP` SEZ with payment · `SEWOP` SEZ without payment |
| `idt` | string | Invoice date, **`dd-mm-yyyy`** |
| `val` | number | Invoice value (total incl. tax) |
| `action` | string | `N` no action · `A` accepted · `R` rejected · `P` pending |
| `pos` | string | Place of supply, 2-digit state code (`27` Maharashtra) |
| `txval` | number | Taxable value |
| `iamt` | number | IGST |
| `camt` | number | CGST |
| `samt` | number | SGST/UTGST |
| `cess` | number | Cess |
| `remarks` | string | **Only when action is R or P.** Max 250 chars. Omit otherwise |
| `srcform` | string | `R1` GSTR-1/IFF · `R5` GSTR-5 · `R1A` GSTR-1A |
| `rtnprd` | string | Source return period, `MM` |

### Additional keys present on download

| Key | Meaning |
|---|---|
| `tradenm` | Supplier trade/legal name |
| **`srcfilstatus`** | **SAVED vs FILED — blocker #3, solved** |
| `rtnTyp` | Source form on the download side (maps to `srcform`) |
| `sRtnPrd` | Source return period on the download side |
| `ispendactblocked` | `Y`/`N` — Pending action not allowed on this record |
| `isRemarksBlocked` | `Y`/`N` — remarks not accepted |
| `itcRedReqBlocked` | `Y`/`N` — ITC-reduction input not allowed |
| `error_msg` | Portal validation error text |

### Credit/debit notes and amendments

| Section | Extra keys |
|---|---|
| `b2bdn` / `b2bcn` | `nt_num`, `nt_dt` instead of `inum`/`idt` |
| `b2ba` | `oinum`, `oidt` — the original invoice being amended |
| `b2bcna` / `b2bdna` | `ont_num`, `ont_dt` — the original note |
| CN + downward amendments | `itc_red_req` (`Y`/`N`), `decl_igst`, `decl_cgst`, `decl_sgst`, `decl_cess` |

---

## 4. Rules the app MUST respect

1. **Remarks only on Reject or Pending.** Max 250 chars. Never send on Accept.
2. **Honour the blocked flags.** If `ispendactblocked` is `Y`, never recommend Pending.
   Same for remarks and ITC reduction. The portal rejects the whole JSON otherwise.
3. **ITC-reduction fields apply only to Accepted records** of these types: credit notes;
   CN amendments (except downward where the original CN was accepted and ITC adjusted);
   B2B invoice downward amendments where the original was accepted and ITC availed;
   debit note downward amendments.
4. **`inum` is a string.** Never let JSON.stringify emit it as a number.
5. **Dates go out as `dd-mm-yyyy`**, not ISO. Convert at the adapter boundary only.
6. **Codes, not labels.** Send `A`, not `"Accepted"`. Send `27`, not `"Maharashtra"`.
   Send `R1`, not `"GSTR-1/IFF"`.

---

## 5. Excel sheet layout (for the .xlsx export path)

Sheets: `B2B` · `B2BA` · `B2B-DN` · `B2B-DNA` · `B2B-CN` · `B2B-CNA` · `ECO` · `ECOA`

Two-level headers: row 5 = group, row 6 = sub-columns, data from row 7.

`B2B` columns in order:
```
1 GSTIN of supplier   2 Trade/Legal name
3 Invoice number      4 Invoice type    5 Invoice Date   6 Invoice Value
7 Status              8 Place of supply 9 Taxable Value
10 IGST  11 CGST  12 SGST  13 Cess
14 Remarks  15 Source  16 Source Return Period  17 Source Filing Status
18 Sheet validation errors  19 GST portal validation errors
20 Previous Status  21 Remarks  22 IsPendingBlocked  23 IsRemarkBlocked
```

`B2B-CN` / `B2BA` add the ITC-reduction block and `IsITCBlocked` / `ItcAvailabilityCheck`.

---

## 6. What this changes in the build spec

| Spec assumption | Reality |
|---|---|
| Might need snapshot diffing for saved-vs-filed | `srcfilstatus` gives it directly |
| Change detection needs hashing | `Previous Status` is on the sheet — still hash for *value* changes |
| Sections: B2B only | **8 sections.** Credit notes and amendments are first-class, not edge cases |
| No ECO concept | `ECO`/`ECOA` = e-commerce operator supplies u/s 9(5). Needs its own bucket |
| Action = 3 states | 4: `N`/`A`/`R`/`P`, and `N` is the dangerous default (deemed acceptance) |

**Note:** v1.1 has **no Import-of-Goods section**, despite BoE being in the online IMS
dashboard since Oct 2025. Imports are not actionable via the offline round-trip yet —
handle them read-only from GSTR-2B.

---

## 7. Still open

| # | Blocker | Where |
|---|---|---|
| 2 | GSTR-2B JSON schema | GSTR-2B matching offline tool, or a real 2B download |
| 4 | GSTR-2A column names | A real 2A Excel export |
| — | `srcfilstatus` value vocabulary | Need one real download to see the actual strings |
