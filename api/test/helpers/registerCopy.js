// A copy of a demo register with some suppliers' contact cells changed, written
// to the temp directory: what a trader does when a supplier's phone or email
// changes and they upload the register again.
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const XLSX = createRequire(import.meta.url)('xlsx');

const HEADER_ROW = 4; // 0-based: the v2.4 template's header is row 5

// changes: { [supplierGstin]: { person?, phone?, email? } } -> path of the copy
export function registerWithContacts(sourcePath, changes, name = 'register-copy') {
  const book = XLSX.readFile(sourcePath);
  const sheet = book.Sheets[book.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, blankrows: true });
  // Template headers carry suffixes ("GSTIN of Supplier/ECO* "), so match the start.
  const column = (title) =>
    rows[HEADER_ROW].findIndex((cell) => String(cell ?? '').trim().toLowerCase().startsWith(title.toLowerCase()));
  const col = {
    gstin: column('GSTIN of Supplier'),
    person: column('Supplier contact person'),
    phone: column('Supplier phone'),
    email: column('Supplier email')
  };
  for (let r = HEADER_ROW + 1; r < rows.length; r += 1) {
    const change = changes[rows[r][col.gstin]];
    if (!change) continue;
    for (const field of ['person', 'phone', 'email']) {
      if (change[field] === undefined) continue;
      sheet[XLSX.utils.encode_cell({ r, c: col[field] })] = { t: 's', v: change[field] };
    }
  }
  const path = join(tmpdir(), `${name}-${process.pid}-${Date.now()}.xlsx`);
  XLSX.writeFile(book, path);
  return path;
}
