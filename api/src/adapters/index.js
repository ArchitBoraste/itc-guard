// Adapter boundary. Portal field names (ctin, inum, txval, srcfilstatus, ...)
// exist only inside this directory; everything downstream of here speaks the
// canonical ExpectedInvoice / PortalRecord shapes with money in integer paise
// and dates as ISO yyyy-mm-dd strings.
export * as purchaseRegister from './purchaseRegister.js';
export * as ims from './ims.js';
export * as gstr2b from './gstr2b.js';
export * as imsActionWriter from './imsActionWriter.js';
export { AdapterError } from './values.js';
export { computeContentHash } from './contentHash.js';
