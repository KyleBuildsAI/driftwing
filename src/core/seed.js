
/** Seed from the URL, normalised to A-Z 0-9 and dashes (max 24), or a fresh random one. */
export function resolveSeed(params) {
  const requested = params.get('seed');
  if (requested) {
    const normalised = requested.toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    if (normalised) return normalised;
  }
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}
