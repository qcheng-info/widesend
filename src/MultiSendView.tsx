import { useRef } from 'react';
import {
  ArrowRight,
  Check,
  CheckCheck,
  Copy,
  FileUp,
  Link,
  LoaderCircle,
  LockKeyhole,
} from 'lucide-react';
import type { GroupSnapshot, ReceiverRow } from './send-session';
import { FileIcon } from './FileIcon';
import { formatBytes } from './format';

type T = (text: string, values?: Record<string, string | number>) => string;

// The sender's view of a code that can be used several times: the code while it
// is open, one row per use, and the files.
export function MultiSendView({
  group,
  busy,
  copied,
  onCopy,
  onSelectOriginals,
  onStopSharing,
  onCancel,
  onReset,
  t,
}: {
  group: GroupSnapshot;
  busy: boolean;
  copied: string;
  onCopy: (value: string, label: string) => void;
  onSelectOriginals: (files: FileList | null) => void;
  onStopSharing: () => void;
  onCancel: () => void;
  onReset: () => void;
  t: T;
}) {
  const originals = useRef<HTMLInputElement>(null);
  const finished = group.phase !== 'active';
  const delivered =
    group.delivered === 1
      ? t('Delivered once')
      : t('Delivered {count} times', { count: group.delivered });
  return (
    <>
      <div className="session-header">
        <span>
          <span className="status-dot" />
          {t('OUTGOING TRANSFER')}
        </span>
        <span className="route-badge" data-testid="connection-status">
          <span className="status-dot" />
          {group.phase === 'complete'
            ? t('Delivered')
            : group.phase === 'error'
              ? t('Needs attention')
              : group.phase === 'cancelled'
                ? t('Cancelled')
                : t('Used {joined} of {count} times', { joined: group.joined, count: group.uses })}
        </span>
      </div>
      <div className="card-body">
        <div className="card-heading">
          <div>
            <h2>
              {group.needsFiles && !finished
                ? t('Continue your transfer')
                : group.phase === 'complete'
                  ? t('Files delivered.')
                  : group.phase === 'error'
                    ? t('Transfer failed.')
                    : group.phase === 'cancelled'
                      ? t('Transfer cancelled.')
                      : group.open
                        ? t('Share this code')
                        : t('Sending files…')}
            </h2>
            <p role="status">
              {group.needsFiles && !finished
                ? t('Select your original files to continue automatically.')
                : group.phase === 'complete'
                  ? delivered
                  : finished
                    ? t(group.message)
                    : group.open
                      ? t(
                          'Enter the code in WideSend on each device that should receive the files.',
                        )
                      : t('The code can’t be used again.')}
            </p>
          </div>
          {group.phase === 'complete' && (
            <span className="complete-icon">
              <CheckCheck size={26} />
            </span>
          )}
        </div>
        {group.open && !group.needsFiles && (
          <div className="pairing">
            <div className="pairing-details">
              <span className="small-label">{t('TRANSFER CODE')}</span>
              <code className="transfer-code" data-testid="transfer-code">
                {group.code}
              </code>
              <div className="copy-actions">
                <button className="secondary-button" onClick={() => onCopy(group.code, 'code')}>
                  {copied === 'code' ? <Check size={16} /> : <Copy size={16} />}
                  {copied === 'code' ? t('Copied') : t('Copy code')}
                </button>
                <button
                  className="text-button"
                  onClick={() => onCopy(`${location.origin}/#${group.code}`, 'link')}
                >
                  {copied === 'link' ? <Check size={16} /> : <Link size={16} />}
                  {copied === 'link' ? t('Copied') : t('Copy link')}
                </button>
              </div>
              <span className="field-note">
                {t('Can be used {count} times · Code expires in 20 minutes', { count: group.uses })}
              </span>
            </div>
          </div>
        )}
        {group.needsFiles && !finished && (
          <div className="receive-actions">
            <input
              ref={originals}
              type="file"
              multiple
              hidden
              data-testid="original-files"
              onChange={(event) => {
                onSelectOriginals(event.target.files);
                event.target.value = '';
              }}
            />
            <button
              className="primary-button"
              disabled={group.checkingFiles || busy}
              onClick={() => originals.current?.click()}
            >
              {group.checkingFiles ? (
                <LoaderCircle size={18} className="spin" />
              ) : (
                <FileUp size={18} />
              )}
              {t(group.checkingFiles ? 'Checking your original files…' : 'Select original files')}
            </button>
          </div>
        )}
        {group.receivers.length > 0 && (
          <div className="use-list">
            {group.receivers.map((row) => (
              <UseRow key={row.slot} row={row} t={t} />
            ))}
          </div>
        )}
        <div className="transfer-files">
          {group.files.map((file) => (
            <div className="file-row" key={file.id}>
              <FileIcon name={file.name} />
              <div className="file-description">
                <strong>{file.name}</strong>
                <span>{formatBytes(file.size)}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="session-footer">
          <span>
            <LockKeyhole size={14} />
            {t('Keep your code private')}
          </span>
          {finished ? (
            <button className="text-button" onClick={onReset}>
              {t('New transfer')}
              <ArrowRight size={16} />
            </button>
          ) : (
            <span className="footer-actions">
              {group.open && group.joined > 0 && (
                <button className="text-button" onClick={onStopSharing}>
                  {t('Stop sharing')}
                </button>
              )}
              <button className="text-button cancel-button" onClick={onCancel}>
                {t('Cancel transfer')}
              </button>
            </span>
          )}
        </div>
      </div>
    </>
  );
}

function UseRow({ row, t }: { row: ReceiverRow; t: T }) {
  const percent = row.total ? Math.min(100, Math.floor((row.transferred / row.total) * 100)) : 0;
  const status = !row.claimed
    ? t('Waiting')
    : row.phase === 'complete'
      ? t('Delivered')
      : row.phase === 'cancelled'
        ? t('Cancelled')
        : row.phase === 'error'
          ? t('Needs attention')
          : row.phase === 'reconnecting'
            ? t('Reconnecting…')
            : row.phase === 'transferring'
              ? `${percent}% · ${formatBytes(row.speed)}/s`
              : t('Connected · waiting to start');
  return (
    <div className={`use-row ${row.phase}`} data-testid="use-row">
      <span className="use-index">{row.slot + 1}</span>
      <div className="use-details">
        <strong>{t('Use {count}', { count: row.slot + 1 })}</strong>
        <span>{status}</span>
        {row.claimed && ['transferring', 'reconnecting'].includes(row.phase) && (
          <div
            className="progress-track"
            role="progressbar"
            aria-label={t('Use {count}', { count: row.slot + 1 })}
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
      {!row.claimed ? (
        <LoaderCircle size={17} className="spin muted" />
      ) : row.phase === 'complete' ? (
        <Check size={20} className="success-text" />
      ) : null}
    </div>
  );
}
