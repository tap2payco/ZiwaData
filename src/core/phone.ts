/**
 * Tanzanian mobile numbers: 0xxxxxxxxx or +255xxxxxxxxx (also 255xxxxxxxxx and bare 9 digits).
 * Returns the international digits "255XXXXXXXXX" or null. Mobile ranges start 06x or 07x.
 */
export function normalizeTzPhone(input: string): string | null {
  const cleaned = (input ?? '').replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(cleaned)) return null;
  const digits = cleaned.replace(/^\+/, '');
  let national: string;
  if (/^0\d{9}$/.test(digits)) national = digits.slice(1);
  else if (/^255\d{9}$/.test(digits)) national = digits.slice(3);
  else if (/^\d{9}$/.test(digits) && !cleaned.startsWith('+')) national = digits;
  else return null;
  if (!/^[67]\d{8}$/.test(national)) return null;
  return '255' + national;
}

/** "+255 7•• ••• 678" for display; the full number never leaves the server after Save. */
export function maskPhone(normalized: string): string {
  if (!/^255\d{9}$/.test(normalized)) return '';
  const n = normalized.slice(3);
  return `+255 ${n[0]}•• ••• ${n.slice(6)}`;
}
