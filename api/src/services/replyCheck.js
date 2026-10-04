// What a supplier's reply says. Until a checker is configured every reply is
// "unchecked" and the UI shows the raw text.
export const UNCHECKED = Object.freeze({ intent: 'unchecked', summary: null, promisedDate: null, mentionsOurInvoice: null });

export async function checkReply() {
  return UNCHECKED;
}
