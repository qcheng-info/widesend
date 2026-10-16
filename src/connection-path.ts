export type ConnectionPath = {
  network: 'local' | 'public' | 'unknown';
  localCandidate: 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';
  remoteCandidate: 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';
  protocol: 'UDP' | 'TCP' | 'unknown';
};

function addressKind(value: unknown): 'local' | 'public' | 'unknown' {
  if (typeof value !== 'string' || !value) return 'unknown';
  const address = value.toLowerCase();
  if (/^[a-z0-9-]+\.local\.?$/.test(address)) return 'local';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
    const parts = address.split('.').map(Number);
    if (parts.some((n) => n > 255) || parts[0] === 0) return 'unknown';
    if (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254)
    )
      return 'local';
    // Shared carrier space is not evidence of a LAN or a public endpoint.
    if ((parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || parts[0] >= 224)
      return 'unknown';
    return 'public';
  }
  try {
    if (!address.includes(':')) return 'unknown';
    const ip = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    if (ip === '::') return 'unknown';
    if (ip.startsWith('::ffff:')) {
      const parts = ip
        .slice(7)
        .split(':')
        .map((n) => parseInt(n, 16));
      if (parts.length !== 2) return 'unknown';
      return addressKind(`${parts[0] >> 8}.${parts[0] & 255}.${parts[1] >> 8}.${parts[1] & 255}`);
    }
    if (ip === '::1' || /^(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(ip)) return 'local';
    return /^[23][0-9a-f]{3}:/.test(ip) ? 'public' : 'unknown';
  } catch {
    return 'unknown';
  }
}

// Read only the selected pair, never guess from other gathered candidates.
// Addresses are used transiently for a hint; none are returned, stored or sent.
export function connectionPath(report: RTCStatsReport): ConnectionPath | null {
  const entries: Record<string, unknown>[] = [];
  report.forEach((entry) => entries.push(entry));
  const selected = entries.find(
    (entry) => entry.type === 'transport' && entry.selectedCandidatePairId,
  );
  let pair = selected ? report.get(String(selected.selectedCandidatePairId)) : undefined;
  if (!pair) {
    // Firefox has historically exposed `selected` on candidate-pair stats.
    const pairs = entries.filter(
      (entry) => entry.type === 'candidate-pair' && entry.selected === true,
    );
    if (pairs.length === 1) pair = pairs[0];
  }
  if (!pair || pair.type !== 'candidate-pair' || pair.state !== 'succeeded') return null;
  const local = report.get(pair.localCandidateId),
    remote = report.get(pair.remoteCandidateId);
  const candidateType = (value: unknown): ConnectionPath['localCandidate'] =>
    ['host', 'srflx', 'prflx', 'relay'].includes(String(value))
      ? (value as ConnectionPath['localCandidate'])
      : 'unknown';
  const localCandidate = candidateType(local?.candidateType),
    remoteCandidate = candidateType(remote?.candidateType);
  const localAddress = addressKind(local?.address ?? local?.ip),
    remoteAddress = addressKind(remote?.address ?? remote?.ip);
  const protocol = local?.protocol?.toLowerCase();
  return {
    network:
      localCandidate === 'host' &&
      remoteCandidate === 'host' &&
      localAddress === 'local' &&
      remoteAddress === 'local'
        ? 'local'
        : localAddress === 'public' || remoteAddress === 'public'
          ? 'public'
          : 'unknown',
    localCandidate,
    remoteCandidate,
    protocol: protocol === 'udp' ? 'UDP' : protocol === 'tcp' ? 'TCP' : 'unknown',
  };
}
