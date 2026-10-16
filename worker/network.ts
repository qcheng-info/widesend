// The network a request comes from, for per-network limits. Free of Durable Object
// imports so the admin Worker can use it too.
// Group IPv6 privacy addresses by /64 so rotating their suffix doesn't bypass
// a household's limits. Only Cloudflare's authoritative IP header is used.
export function networkAddress(ip: string): string {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every((v) => Number(v) <= 255))
    return ip.split('.').map(Number).join('.');
  try {
    const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const [left, right] = normalized.split('::');
    const start = left ? left.split(':') : [];
    const end = right ? right.split(':') : [];
    const parts =
      right === undefined
        ? start
        : [...start, ...Array(8 - start.length - end.length).fill('0'), ...end];
    if (parts.length !== 8) return 'unknown';
    const numbers = parts.map((v) => parseInt(v, 16));
    if (numbers.slice(0, 5).every((v) => v === 0) && numbers[5] === 65535)
      return [numbers[6] >> 8, numbers[6] & 255, numbers[7] >> 8, numbers[7] & 255].join('.');
    return `${numbers
      .slice(0, 4)
      .map((v) => v.toString(16))
      .join(':')}::/64`;
  } catch {
    return 'unknown';
  }
}
export async function networkKey(request: Request): Promise<string> {
  const address = networkAddress(request.headers.get('CF-Connecting-IP') || 'unknown');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`widesend-network:${address}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
