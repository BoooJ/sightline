const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url sans remplissage → octets (clé VAPID pour `applicationServerKey`), sans dépendre de atob. */
export function base64UrlToBytes(s: string): Uint8Array {
  const out: number[] = [];
  let buf = 0, bits = 0;
  for (const ch of s.replace(/=+$/, "")) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}
