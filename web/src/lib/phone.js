// '+919876543210' or '919876543210' -> '+91 98765 43210', the way an Indian
// mobile number is read aloud. Anything else comes back as it was given.
export function formatWhatsappNumber(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  return String(value ?? '');
}
