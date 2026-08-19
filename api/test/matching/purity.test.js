// Enforces the architecture rule for src/matching/**, so it cannot rot silently.
//
//   "src/matching/** is PURE. No DB, no fs, no network. It may not import from
//    services/, routes/, or db/. This is the unit-test showcase — keep it clean."
//
// Read as source text rather than by importing, because an illegal import is
// exactly the thing that would make importing it succeed.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MATCHING_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../src/matching');

const files = readdirSync(MATCHING_DIR).filter((name) => name.endsWith('.js'));
const sources = files.map((name) => ({
  name,
  code: readFileSync(join(MATCHING_DIR, name), 'utf8')
}));

// Import specifiers only, so a word inside a comment or string cannot fail this.
function importSpecifiers(code) {
  const specifiers = [];
  const patterns = [
    /\bimport\s+[^;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bexport\s+[^;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

describe('src/matching is pure', () => {
  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(sources)('$name imports nothing outside src/matching', ({ code }) => {
    for (const specifier of importSpecifiers(code)) {
      // Relative and inside this directory: './x.js' only, never '../anything'.
      expect(specifier.startsWith('./'), `illegal import: ${specifier}`).toBe(true);
      expect(specifier.includes('..'), `illegal import: ${specifier}`).toBe(false);
    }
  });

  it.each(sources)('$name touches no db, fs, network or timing source', ({ code }) => {
    const specifiers = importSpecifiers(code);
    for (const banned of ['node:fs', 'fs', 'node:net', 'node:http', 'node:https', 'mysql2', 'node:dns', 'node:child_process']) {
      expect(specifiers, `${banned} is not allowed in matching/`).not.toContain(banned);
    }
    // No ambient state either: results must depend only on the arguments, which is
    // what makes a run reproducible and the accuracy metric meaningful.
    expect(code).not.toMatch(/\bprocess\.env\b/);
    expect(code).not.toMatch(/\bDate\.now\s*\(/);
    expect(code).not.toMatch(/\bnew Date\s*\(\s*\)/);
    expect(code).not.toMatch(/\bMath\.random\s*\(/);
  });

  it.each(sources)('$name uses no portal field names — those live in adapters', ({ code }) => {
    // Portal vocabulary (ctin, inum, txval, srcfilstatus...) must not reach past
    // the adapter boundary, in code OR in comments: a reader of matching/ should
    // never need to know a portal schema.
    const portalNames = [
      'ctin', 'trdnm', 'inum', 'txval', 'srcfilstatus', 'supfildt', 'supprd',
      'itcavl', 'itcelg', 'diffprcnt', 'boenum', 'portcode', 'ispendactblocked',
      'isRemarksBlocked', 'itcRedReqBlocked', 'imsDetails', 'docdata',
      'iamt', 'camt', 'samt', 'nt_num', 'ntnum', 'inv_typ', 'rtnprd'
    ];
    for (const name of portalNames) {
      expect(code, `portal field name "${name}" leaked into matching/`).not.toMatch(
        new RegExp(`\\b${name}\\b`)
      );
    }
  });
});
