import { useId, useState } from 'react';
import { Activity, ChevronDown } from 'lucide-react';
import type { Snapshot } from './transfer';
import type { translate } from './i18n';
import { formatBytes, formatDuration } from './format';

type Translator = (text: string, values?: Parameters<typeof translate>[2]) => string;

export function NerdStats({ state, t }: { state: Snapshot; t: Translator }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const stats = state.stats;
  if (!stats) return null;
  const finished = ['complete', 'error', 'cancelled'].includes(state.phase);
  const file = state.files[stats.currentFile];
  const transferred =
    state.files.slice(0, stats.currentFile).reduce((sum, f) => sum + f.size, 0) +
    stats.fileTransferred;
  const remaining = Math.max(0, state.total - transferred);
  const eta =
    !finished && remaining > 0 && stats.speed > 0
      ? formatDuration(Math.ceil(remaining / stats.speed))
      : '—';
  const peak = Math.max(1, ...stats.samples.map((point) => point.speed));
  const graphEnd = stats.elapsed;
  const graphStart = Math.max(0, graphEnd - 60);
  const graphDuration = Math.max(1, graphEnd - graphStart);
  const points = stats.samples.map((point) => ({
    x: Math.max(0, Math.min(600, ((point.elapsed - graphStart) / graphDuration) * 600)),
    y: 88 - (point.speed / peak) * 76,
  }));
  const line = points.map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const metrics = [
    ['speed', 'Current speed', `${formatBytes(stats.speed)}/s`],
    ['average', 'Average speed', `${formatBytes(stats.averageSpeed)}/s`],
    ['elapsed', 'Elapsed time', formatDuration(stats.elapsed)],
    ['remaining', 'Estimated remaining', eta],
    [
      'latency',
      'Round-trip latency',
      stats.latencyMs === null ? '—' : `${Math.round(stats.latencyMs)} ms`,
    ],
    ['queued', 'Queued on this device', formatBytes(stats.queuedBytes)],
    ...(state.role === 'send'
      ? [
          [
            'unacknowledged',
            'Awaiting acknowledgement',
            formatBytes(stats.unacknowledgedBytes ?? 0),
          ],
          ['resent', 'Resent file data', formatBytes(stats.resentBytes ?? 0)],
        ]
      : []),
    ['verified', 'Files verified', `${stats.verifiedFiles} / ${state.files.length}`],
    ['reconnects', 'Reconnect attempts', String(stats.reconnects)],
  ];

  return (
    <div className="nerd-stats">
      <button
        className="nerd-toggle"
        type="button"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded(!expanded)}
      >
        <Activity size={15} aria-hidden="true" />
        {t('Nerd stats')}
        <ChevronDown size={15} className={expanded ? 'expanded' : ''} aria-hidden="true" />
      </button>
      {expanded && (
        <section id={id} className="nerd-panel" aria-label={t('Nerd stats')}>
          <div className="nerd-heading">
            <strong data-testid="stats-route">
              {t(
                state.route === 'direct'
                  ? 'Direct P2P'
                  : state.route === 'relay'
                    ? 'Cloudflare relay'
                    : 'Connecting…',
              )}
            </strong>
            <span className="nerd-live">
              {!finished && <span className="status-dot" />}
              {t(finished ? 'Final snapshot' : 'Live · every second')}
            </span>
          </div>
          <p className="nerd-activity" data-testid="stats-activity">
            {t(stats.activity)}
          </p>
          <div className="nerd-chart">
            <div className="nerd-chart-labels">
              <span>{t('Speed · last 60 seconds')}</span>
              <span>{formatBytes(peak)}/s</span>
            </div>
            <svg
              viewBox="0 0 600 96"
              preserveAspectRatio="none"
              role="img"
              aria-label={t('Transfer speed history')}
            >
              <path d="M0 12H600 M0 50H600 M0 88H600" className="nerd-grid-lines" />
              {points.length > 0 && (
                <>
                  <polygon
                    points={`${points[0].x},88 ${line} ${points.at(-1)!.x},88`}
                    className="nerd-chart-fill"
                  />
                  <polyline points={line} className="nerd-chart-line" />
                </>
              )}
            </svg>
            <div className="nerd-chart-labels">
              <span>{formatDuration(graphStart)}</span>
              <span>{formatDuration(graphEnd)}</span>
            </div>
          </div>
          <dl className="nerd-metrics">
            {metrics.map(([key, label, value]) => (
              <div key={key}>
                <dt>{t(label)}</dt>
                <dd data-testid={`stats-${key}`}>{value}</dd>
              </div>
            ))}
            <div>
              <dt>{t('Acknowledgement path')}</dt>
              <dd data-testid="stats-ack-path">
                {stats.acknowledgementPath === null
                  ? '—'
                  : t(stats.acknowledgementPath === 'direct' ? 'Direct P2P' : 'Cloudflare relay')}
              </dd>
            </div>
            {state.route === 'direct' && (
              <>
                <div>
                  <dt>{t('Connection path')}</dt>
                  <dd data-testid="stats-path">
                    {t(
                      stats.connectionPath?.network === 'local'
                        ? 'Local addresses (LAN likely)'
                        : stats.connectionPath?.network === 'public'
                          ? 'Public addresses'
                          : 'Network not exposed',
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t('Transport')}</dt>
                  <dd data-testid="stats-transport">
                    {stats.connectionPath && stats.connectionPath.protocol !== 'unknown'
                      ? stats.connectionPath.protocol
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt>{t('ICE candidates')}</dt>
                  <dd data-testid="stats-candidates">
                    {stats.connectionPath
                      ? `${stats.connectionPath.localCandidate === 'unknown' ? '—' : stats.connectionPath.localCandidate} ↔ ${stats.connectionPath.remoteCandidate === 'unknown' ? '—' : stats.connectionPath.remoteCandidate}`
                      : '—'}
                  </dd>
                </div>
              </>
            )}
            {file && (
              <div className="nerd-wide">
                <dt>
                  {t('File {index} of {count}', {
                    index: stats.currentFile + 1,
                    count: state.files.length,
                  })}
                </dt>
                <dd className="nerd-filename">{file.name}</dd>
                <dd className="nerd-file-progress">
                  {formatBytes(stats.fileTransferred)} / {formatBytes(file.size)}
                  <span>
                    {t(state.role === 'send' ? 'Receiver acknowledged' : 'Received on this device')}
                  </span>
                </dd>
              </div>
            )}
            {stats.fallbackReason && (
              <div className="nerd-wide">
                <dt>{t('Relay reason')}</dt>
                <dd data-testid="stats-fallback">{t(stats.fallbackReason)}</dd>
              </div>
            )}
          </dl>
          <p className="nerd-note">
            {t('Latency includes queues and device processing. Counters are for this device.')}
            {state.route === 'direct' && (
              <> {t('Address types are hints, not proof of LAN routing.')}</>
            )}
          </p>
          <div className="nerd-events">
            <h3>{t('Recent events')}</h3>
            <ol aria-label={t('Recent events')}>
              {[...stats.events].reverse().map((event, index) => (
                <li key={`${event.elapsed}:${index}`}>
                  <time>{formatDuration(event.elapsed)}</time>
                  <span>{t(event.label)}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}
    </div>
  );
}
