function concatBytes(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint16(value: number) {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function base64UrlBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(normalized), char => char.charCodeAt(0));
}

function pem(label: string, bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).match(/.{1,64}/g)?.join("\n") || "";
  return `-----BEGIN ${label}-----\n${encoded}\n-----END ${label}-----`;
}

export async function generateEch(publicName: string) {
  if (!publicName || new TextEncoder().encode(publicName).length > 253) return null;
  const pair = await crypto.subtle.generateKey({ name: "X25519" } as any, true, ["deriveBits"] as any) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateKey = base64UrlBytes(String(privateJwk.d || ""));
  const publicKey = base64UrlBytes(String(publicJwk.x || ""));
  if (privateKey.length !== 32 || publicKey.length !== 32) throw new Error("X25519 key export failed");
  const name = new TextEncoder().encode(publicName);
  const configId = crypto.getRandomValues(new Uint8Array(1))[0];
  const contents = concatBytes(new Uint8Array([configId]), uint16(0x0020), uint16(32), publicKey, uint16(8), uint16(1), uint16(1), uint16(1), uint16(3), new Uint8Array([0, name.length]), name, uint16(0));
  const config = concatBytes(uint16(0xfe0d), uint16(contents.length), contents);
  return {
    key: pem("ECH KEYS", concatBytes(uint16(32), privateKey, uint16(config.length), config)),
    config: pem("ECH CONFIGS", concatBytes(uint16(config.length), config))
  };
}
