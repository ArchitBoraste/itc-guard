// The trader GSTIN a workspace is for.
//
// An empty workspace adopts the GSTIN of the first uploaded file that carries one:
// the register's "GSTIN of recipient", or the trader's GSTIN on an IMS or GSTR-2B
// file. From then on a file naming another trader is refused, because its records
// would be reconciled against someone else's books and its IMS actions filed
// under the wrong GSTIN. Clear all data empties the workspace, and the GSTIN with
// it (demoStory.wipeOrgData). A file that names no GSTIN (a CSV register, a
// portal file without one) is taken on trust.
import { pool } from '../db/pool.js';
import * as purchaseRegister from '../adapters/purchaseRegister.js';
import * as ims from '../adapters/ims.js';
import * as gstr2b from '../adapters/gstr2b.js';
import { ServiceError } from './ingest.js';

// The trader GSTIN an upload's bytes name, or null.
export function fileTraderGstin(kind, buffer) {
  if (kind === 'PURCHASE_REGISTER') return purchaseRegister.recipientGstin(buffer);
  if (kind === 'IMS') return ims.recipientGstin(buffer);
  if (kind === 'GSTR2B') return gstr2b.recipientGstin(buffer);
  return null;
}

// -> { gstin, adopted }: the adopted GSTIN, or the org's own until one is.
export async function readWorkspaceGstin(orgId, connection = pool) {
  const [rows] = await connection.query(
    'SELECT gstin, workspace_gstin FROM organizations WHERE id = ?',
    [orgId]
  );
  if (!rows.length) throw new ServiceError('workspace not found', 404, 'not_found');
  return { gstin: rows[0].workspace_gstin ?? rows[0].gstin, adopted: rows[0].workspace_gstin !== null };
}

function mismatch(fileGstin, workspaceGstin) {
  return new ServiceError(
    `These files belong to GSTIN ${fileGstin}; this workspace is for ${workspaceGstin}.`,
    422,
    'gstin_mismatch'
  );
}

// Refuses a file for another trader once the workspace has adopted a GSTIN.
export async function assertFileGstin(orgId, fileGstin) {
  if (!fileGstin) return;
  const { gstin, adopted } = await readWorkspaceGstin(orgId);
  if (adopted && gstin !== fileGstin) throw mismatch(fileGstin, gstin);
}

// Inside the commit's transaction: adopts fileGstin if the workspace has none,
// refuses it if the workspace is another trader's. The org row is locked, so two
// commits racing on an empty workspace cannot adopt two different GSTINs.
export async function adoptFileGstin(connection, orgId, fileGstin) {
  if (!fileGstin) return null;
  const [rows] = await connection.query(
    'SELECT workspace_gstin FROM organizations WHERE id = ? FOR UPDATE',
    [orgId]
  );
  const current = rows[0]?.workspace_gstin ?? null;
  if (current && current !== fileGstin) throw mismatch(fileGstin, current);
  if (!current) {
    await connection.query('UPDATE organizations SET workspace_gstin = ? WHERE id = ?', [fileGstin, orgId]);
  }
  return fileGstin;
}
