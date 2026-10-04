# ITC Guard — UI redesign handoff

Mockups for the redesigned web app. Build the real React screens to match these.

- `screens/*.png`: what each screen should look like at 1440 px wide.
- `screens/*.rendered.html`: the same screens as plain HTML with inline styles. Read these for exact
  spacing, colours, font sizes and structure.
- `source/*.dc.html`: the original mockup files. `Decisions.dc.html` has the interaction logic
  (tabs, decision buttons, expand rows) in its `<script>` block; the `{{ }}`, `<sc-for>` and `<sc-if>`
  syntax is a mockup template language. Translate to React; don't copy it.

**The numbers, names, dates and invoices in the mockups are placeholders** (April/May sample data).
Every figure on the real screens comes from the API. Copy the layout, hierarchy, wording style and
components, not the data. Screen 5 (Corrections) was drawn for May; in the demo it is September.

## Principles

1. **One sentence under each page title, at most.** No explanatory paragraphs on the face of any
   screen. Explanations live in a row's expanded details ("why"), in a tooltip, or in Help.
2. **Numbers first.** Stat tiles: label above, value below, left-aligned, tabular figures.
3. **One name per idea**, used everywhere:
   - Credit in your books · Ready to claim · Needs your decision · Not filed by suppliers
   - IMS action N is shown as **"Not decided"** (never "No action" as a group name)
   - Statuses on the portal: Not on portal · Saved, not filed · Saved with a different amount · Filed
   - Issues: Matches · Lower on portal · Higher on portal · Invoice no. differs · Not in your books ·
     ₹x rounding
4. **Money:** ₹ with Indian grouping, whole rupees on screen, formatted from integer paise
   (`web/src/lib/money.js`). Never "₹1.08 L" next to "₹1,07,639". No negative headline figures.
   A credit note shows as −₹900 only inside a row.
5. **Dates:** `16 May 2026` in text, `16 May` in chips. Never ISO dates on screen.
6. **No engine codes** (`VALUE_MISMATCH`, `NON_IMS`, …) and no portal field names on screen.
7. **Colour carries status; text says it too.** Never colour alone.

## Tokens

| Token | Value | Use |
|---|---|---|
| font-sans | IBM Plex Sans 400/500/600 | all UI text |
| font-mono | IBM Plex Mono 400/500 | GSTINs, invoice numbers, file names only |
| bg-app | #F5F6F8 | page background |
| bg-card | #FFFFFF, border #E2E6EC, radius 10px | cards, tables |
| bg-subtle | #F7F8FA | inner panels, file chips, message preview |
| sidebar | #0F1B2D; active item #1E2D44; text #C9D2DE; muted #93A1B5; divider #24344D | nav |
| text | #0F1B2D primary · #3D4B5F secondary · #5B6778 muted | |
| primary | #2446C7 (hover #1A3599); soft #E9EDFB / text #1A3599 | main buttons, links, active tab |
| border-input | #D5DBE3 | inputs, secondary buttons |
| ok | text #11724A · bg #E8F5EE · solid #1F8A5B | matches, ready, arrived, Low risk |
| warn | text #8A3F05 · bg #FDF1E3 · solid #D9822B / #B4540A | needs decision, mismatch, Medium risk |
| bad | text #A11E14 · bg #FDECEA · solid #B42318 | not in books, cut-off passed, Reject, High risk |
| info | text #1D4F8C · bg #EAF2FB | "accept if same bill", before cut-off |
| neutral-status | text #2D4A73 · bg #EAEFF6 · bar #7E93B3 | not filed / not on portal, New (not enough history) |

Type scale: page title 24/600 · section title 15–17/600 · body 14/400 · secondary 13 · caption 12.
Stat values 22–28/600. Spacing: page padding 32px 40px; card padding 18–22px; gaps 16–24px.
Chips: 12/500, padding 3px 8px, radius 4px. Buttons: radius 6–8px, height ≥ 36px (touch ≥ 44 on mobile).

## Layout

- Left sidebar 232px (navy) with: logo, nav (Upload, Overview, IMS decisions [count badge],
  Not filed yet [count badge], Corrections [count badge], Suppliers), Help at the bottom, then the
  trader's name + GSTIN. "Clear all data" lives on the Upload screen, not in the sidebar.
- Top bar (white): Tax period select · **As of** date picker (the workspace clock) · deadline chip on
  the right (before the supplier cut-off: "Supplier cut-off 11 Sep · 4 days left" in info colours;
  after it: "GSTR-3B due 20 Sep · 9 days left" in warn colours; overdue: bad colours).
- Content max-width 1240px.
- Below 900px: sidebar becomes a top bar with a menu button; stat grids drop to 2 columns, then 1;
  wide tables scroll inside their card (`overflow-x: auto`). No horizontal page scroll at 390px.

## Screens

1. **Upload** (`Main`): 3 file cards (register, IMS, GSTR-2B). Locked 2B card (dashed border,
   lock chip "Opens 14 Sep", "N days" + one line). IMS card names the snapshot date and offers
   "Upload newer download". Then the Reconcile bar, upload history (Remove per row; replaced
   uploads greyed with "Replaced by 7 Sep"), accepted formats, Clear all data. Keep table cells on
   one line (`white-space: nowrap`) for type, period and time.
2. **Overview**: 4 stat tiles + a segmented bar; "Before <deadline>" to-do list (numbered steps,
   each with one button; hide steps with nothing to do); "What we found" table of every
   non-matching item + "N other documents match exactly".
3. **IMS decisions**: the Decide → Download → Upload strip; tabs Ready to accept / Needs a decision /
   Decided / Overridden with counts; rows with Accept/Reject/Pending segmented buttons (selected =
   solid ok/bad/warn); a chevron expands books-vs-portal + one-line why + message to supplier
   (contact, Copy, WhatsApp, Email). Footer: undecided count + Download IMS file.
4. **Not filed yet**: cut-off card first (see `CutoffStates.png` for both states), then the table
   (supplier + GSTIN + scheme, invoice, taxable, tax, portal status chip, cut-off date + "Passed" /
   "N days left", contact, Message button), then the message panel for the selected row.
5. **Corrections**: 3 tiles (Asked for · Arrived · Still waiting) and a table (supplier, invoice,
   what you asked for, status chip, found in, credit, Remind).
6. **Suppliers**: search + "Only with issues"; table (supplier + GSTIN, contact or "Not in your
   purchase register" + Add contact, filing scheme with edit button + last filing, this period's
   issue, tax, risk chip: High · Medium · Low, or "New · not enough history" under 3 months;
   High whatever the history when an invoice of theirs is not in the books). Row expands to the
   risk reasons, or for a New supplier the facts so far.
