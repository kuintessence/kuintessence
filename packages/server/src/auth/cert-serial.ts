/**
 * Generate a random 16-byte X.509 serial, hex-encoded with the high bit
 * cleared (serials must be positive integers). Shared by the CA + cert-issuer.
 */
export function randomSerial(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
