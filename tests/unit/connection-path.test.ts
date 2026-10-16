import { describe, expect, it } from 'vitest';
import { connectionPath } from '../../src/connection-path';

const report = (local: Record<string, unknown> = {}, remote: Record<string, unknown> = {}) =>
  new Map([
    ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'active' }],
    [
      'active',
      {
        id: 'active',
        type: 'candidate-pair',
        state: 'succeeded',
        localCandidateId: 'local',
        remoteCandidateId: 'remote',
      },
    ],
    [
      'local',
      {
        id: 'local',
        type: 'local-candidate',
        candidateType: 'host',
        protocol: 'udp',
        address: '192.168.1.4',
        ...local,
      },
    ],
    [
      'remote',
      {
        id: 'remote',
        type: 'remote-candidate',
        candidateType: 'host',
        address: '192.168.1.5',
        ...remote,
      },
    ],
  ]) as unknown as RTCStatsReport;

describe('selected WebRTC path', () => {
  it('reports only the active pair and never returns raw addresses', () => {
    const stats = report({ candidateType: 'srflx', address: '203.0.113.4' });
    (stats as unknown as Map<string, unknown>).set('unused', {
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true,
      localCandidateId: 'remote',
      remoteCandidateId: 'remote',
    });
    expect(connectionPath(stats)).toEqual({
      network: 'public',
      localCandidate: 'srflx',
      remoteCandidate: 'host',
      protocol: 'UDP',
    });
    expect(JSON.stringify(connectionPath(stats))).not.toContain('203.0.113');
    expect(JSON.stringify(connectionPath(stats))).not.toContain('192.168');
  });

  it.each([
    ['10.0.0.2', 'local'],
    ['172.16.0.2', 'local'],
    ['172.32.0.2', 'public'],
    ['device-a.local', 'local'],
    ['fd01::1', 'local'],
    ['fe80::1', 'local'],
    ['::ffff:192.168.1.4', 'local'],
    ['2001:db8::1', 'public'],
    ['100.64.1.2', 'unknown'],
    ['0.0.0.0', 'unknown'],
    ['::', 'unknown'],
    ['', 'unknown'],
  ])('treats %s as a %s address hint', (address, network) => {
    expect(connectionPath(report({ address }))?.network).toBe(network);
  });

  it('does not infer a LAN merely from host types or redacted addresses', () => {
    expect(connectionPath(report({ address: undefined }, { address: undefined }))?.network).toBe(
      'unknown',
    );
    expect(connectionPath(report({ candidateType: 'srflx' }))?.network).toBe('unknown');
    expect(connectionPath(report({ protocol: undefined }))?.protocol).toBe('unknown');
  });

  it('supports the Firefox selected flag without guessing from nomination', () => {
    const stats = report();
    const map = stats as unknown as Map<string, Record<string, unknown>>;
    map.delete('transport');
    map.get('active')!.nominated = true;
    expect(connectionPath(stats)).toBeNull();
    map.get('active')!.selected = true;
    expect(connectionPath(stats)?.network).toBe('local');
    map.get('active')!.state = 'failed';
    expect(connectionPath(stats)).toBeNull();
  });
});
