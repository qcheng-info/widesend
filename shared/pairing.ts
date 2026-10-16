export function validPairingCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z0-9]{6}$/.test(value);
}

export async function roomId(code: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`widesend-room-v1:${code}`),
  );
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
