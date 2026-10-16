import { validateManifest, type FileMeta } from './protocol';

export type AuditReport =
  | { event: 'manifest'; files: FileMeta[] }
  | { event: 'file'; file: FileMeta; md5: string; sha256: string }
  | {
      event: 'status';
      status: 'transferring' | 'complete' | 'error' | 'cancelled';
      route: 'connecting' | 'direct' | 'relay';
    };
export type AuditMessage = { type: 'audit'; id: string; report: AuditReport };
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const AUDIT_MAX_BYTES = 128 * 1024;

/** A report as stored when the deployment doesn't record file names. */
export function withoutFileNames(report: AuditReport): AuditReport {
  if (report.event === 'manifest')
    return { ...report, files: report.files.map((file) => ({ ...file, name: '' })) };
  if (report.event === 'file') return { ...report, file: { ...report.file, name: '' } };
  return report;
}

export function validateAudit(value: unknown): AuditMessage {
  const m = value as AuditMessage;
  if (!m || m.type !== 'audit' || !/^[a-f0-9-]{36}$/.test(m.id) || !m.report)
    throw new Error('Invalid activity report');
  const r = m.report;
  if (r.event === 'manifest')
    return {
      type: 'audit',
      id: m.id,
      report: { event: r.event, files: validateManifest(r.files) },
    };
  if (r.event === 'file') {
    if (
      !r.file ||
      !Number.isInteger(r.file.id) ||
      r.file.id < 0 ||
      r.file.id >= 100 ||
      !/^[a-f0-9]{32}$/.test(r.md5) ||
      !/^[a-f0-9]{64}$/.test(r.sha256)
    )
      throw new Error('Invalid fingerprint');
    const file = validateManifest([{ ...r.file, id: 0 }])[0];
    return {
      type: 'audit',
      id: m.id,
      report: { event: r.event, file: { ...file, id: r.file.id }, md5: r.md5, sha256: r.sha256 },
    };
  }
  if (
    r.event === 'status' &&
    ['transferring', 'complete', 'error', 'cancelled'].includes(r.status) &&
    ['connecting', 'direct', 'relay'].includes(r.route)
  )
    return {
      type: 'audit',
      id: m.id,
      report: { event: r.event, status: r.status, route: r.route },
    };
  throw new Error('Invalid activity report');
}
