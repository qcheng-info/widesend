(() => {
  const get = (id) => document.getElementById(id);
  const DAY = 86400000;
  let snapshot = null,
    period = 'today',
    busy = false,
    lastAttempt = 0;
  const number = (value) => (value == null ? '—' : value.toLocaleString('en-US'));
  const bytes = (value) => {
    if (value == null) return '—';
    if (value < 1024) return `${number(value)} B`;
    const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
    return `${(value / 1024 ** unit).toLocaleString('en-US', { maximumFractionDigits: 1 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
  };
  const stamp = (value) =>
    new Intl.DateTimeFormat('en-GB', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    }).format(value) + ' UTC';
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function bars(target, entries) {
    const max = Math.max(1, ...entries.map(([, value]) => value || 0));
    get(target).replaceChildren();
    for (const [label, value, color] of entries) {
      const row = el('div', undefined, 'health-row');
      row.append(el('span', label), el('strong', number(value)));
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 100 3');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('aria-hidden', 'true');
      const rect = document.createElementNS(svg.namespaceURI, 'rect');
      rect.setAttribute('width', String((100 * (value || 0)) / max));
      rect.setAttribute('height', '3');
      rect.setAttribute('rx', '1.5');
      rect.setAttribute('class', color);
      svg.append(rect);
      row.append(svg);
      get(target).append(row);
    }
  }
  function facts(target, entries) {
    const list = el('dl', undefined, 'health-block-list');
    for (const [label, value] of entries) {
      const row = el('div');
      row.append(el('dt', label), el('dd', value));
      list.append(row);
    }
    target.append(list);
  }
  function operations(from, now) {
    const relay = snapshot?.protection?.relay,
      cleanup = snapshot?.cleanup;
    const target = get('health-relay');
    target.replaceChildren();
    if (relay) {
      const sum = { bytes: 0, messages: 0, denied: 0 };
      for (const day of relay.daily)
        if (day.day >= from && day.day <= now)
          for (const key of Object.keys(sum)) sum[key] += day[key];
      facts(target, [
        ['Relayed bytes', bytes(sum.bytes)],
        ['Observed messages', number(sum.messages)],
        ['Estimated request units', number(Math.ceil(sum.messages / 20))],
        ['New relay transfers declined', number(sum.denied)],
      ]);
      const today = Math.floor(now / DAY) * DAY;
      const units = (relay.daily.find((d) => d.day === today)?.messages ?? 0) / 20;
      const limit = relay.budget.dailyRequestUnits,
        threshold = Math.floor((limit * relay.budget.stopNewAtPercent) / 100);
      const status = el('div', undefined, 'health-operation-status');
      status.classList.toggle('operation-warning', !relay.acceptingNew);
      status.append(
        el(
          'strong',
          relay.acceptingNew ? 'New relay transfers available' : 'New relay transfers waiting',
        ),
      );
      status.append(
        el('span', `Today: ${number(Math.ceil(units))} / ${number(limit)} estimated units`),
      );
      const progress = el('progress');
      progress.max = limit;
      progress.value = Math.min(units, limit);
      progress.setAttribute('aria-label', 'Today’s estimated relay budget usage');
      status.append(
        progress,
        el(
          'small',
          `New relay admission stops at ${number(threshold)} units (${relay.budget.stopNewAtPercent}%). Resets ${stamp(relay.resetAt)}.`,
        ),
      );
      target.append(status);
      get('health-relay-coverage').textContent =
        `Relay recording began ${stamp(relay.recordingSince)}. Earlier traffic is not available.`;
    } else
      target.append(
        el('p', snapshot ? 'Relay usage is unavailable.' : 'Loading relay usage…', 'health-note'),
      );
    const clean = get('health-cleanup');
    clean.replaceChildren();
    if (cleanup) {
      const failed =
        cleanup.lastErrorAt &&
        (!cleanup.lastSuccessAt || cleanup.lastErrorAt > cleanup.lastSuccessAt);
      const stale = cleanup.lastStartedAt && now - cleanup.lastStartedAt > 2 * 3600000;
      const unfinished =
        cleanup.lastStartedAt &&
        (!cleanup.lastFinishedAt || cleanup.lastStartedAt > cleanup.lastFinishedAt) &&
        !cleanup.running;
      const label = cleanup.running
        ? 'Cleanup in progress'
        : failed || unfinished
          ? 'Last cleanup did not finish'
          : stale
            ? 'Cleanup status is overdue'
            : !cleanup.lastSuccessAt
              ? 'Waiting for first cleanup'
              : cleanup.overdueTransfers
                ? 'Expired records awaiting cleanup'
                : 'Up to date';
      const status = el('div', undefined, 'health-operation-status');
      status.classList.toggle(
        'operation-warning',
        Boolean(failed || unfinished || stale || cleanup.overdueTransfers),
      );
      status.append(
        el('strong', label),
        el('span', 'Runs every hour · retains 90 days of activity'),
      );
      clean.append(status);
      facts(clean, [
        [
          'Last successful run',
          cleanup.lastSuccessAt ? stamp(cleanup.lastSuccessAt) : 'Not yet recorded',
        ],
        ['Expired transfer records remaining', number(cleanup.overdueTransfers)],
        ['Transfer records deleted in last run', number(cleanup.deletedTransfers)],
        ['Database rows written in last run', number(cleanup.rowsWritten)],
      ]);
      if (cleanup.oldestExpiredAt)
        clean.append(
          el(
            'p',
            `Oldest expired transfer started ${stamp(cleanup.oldestExpiredAt)}.`,
            'health-note',
          ),
        );
    } else
      clean.append(
        el(
          'p',
          snapshot ? 'Cleanup status is unavailable.' : 'Loading cleanup status…',
          'health-note',
        ),
      );
  }
  function render() {
    const activity = snapshot?.activity?.[period],
      protection = snapshot?.protection;
    const now = snapshot?.generatedAt ?? Date.now();
    const today = Math.floor(now / DAY) * DAY,
      from = period === 'today' ? today : today - 6 * DAY;
    const blocks = protection ? { burst: 0, codes: 0, transfers: 0 } : null;
    for (const bucket of protection?.blocks ?? [])
      if (bucket.hour >= from && bucket.hour <= now)
        for (const key of Object.keys(blocks)) blocks[key] += bucket[key];
    const blocked = blocks ? Object.values(blocks).reduce((a, b) => a + b, 0) : null;
    operations(from, now);
    get('health-period-label').textContent =
      period === 'today' ? 'Today, from 00:00 UTC' : 'Today and the previous six days · UTC';
    get('health-metrics').replaceChildren();
    for (const [label, value, hint] of [
      ['Transfers started', activity?.total, 'Recorded in this period'],
      ['Receiver confirmed', activity?.outcomes.complete, 'Received and verified · reported'],
      ['Reconnections', activity?.reconnections, 'Additional accepted connections'],
      ['Blocked attempts', blocked, 'Recorded limit rejections'],
    ]) {
      const card = el('div', undefined, 'health-metric');
      card.append(el('span', label), el('strong', number(value)), el('small', hint));
      get('health-metrics').append(card);
    }
    get('health-live').replaceChildren();
    const full = protection && protection.reservedTransfers >= protection.transferLimit;
    get('health-live').classList.toggle('at-capacity', Boolean(full));
    if (protection) {
      get('health-live').append(
        el(
          'span',
          `${number(protection.reservedTransfers)} / ${number(protection.transferLimit)} transfer slots reserved${full ? ' · New transfers at capacity' : ''}`,
          'health-live-primary',
        ),
        el(
          'span',
          `${number(protection.reservedConnections)} connection reservations · ${number(protection.networkLimit)} transfers per network`,
        ),
      );
      get('health-coverage').textContent =
        `Blocked-attempt recording began ${stamp(protection.recordingSince)}. Earlier blocks are not available.`;
    } else
      get('health-live').textContent = snapshot
        ? 'Connection reservations are unavailable.'
        : 'Connection reservations are loading…';
    bars('health-outcomes', [
      ['Receiver confirmed', activity?.outcomes.complete, 'health-green'],
      ['In progress · reported', activity?.outcomes.transferring, 'health-olive'],
      ['Waiting', activity?.outcomes.waiting, 'health-neutral'],
      ['Failed · reported', activity?.outcomes.error, 'health-rust'],
      ['Cancelled · reported', activity?.outcomes.cancelled, 'health-tan'],
      ['Unconfirmed / interrupted', activity?.outcomes.interrupted, 'health-rust'],
      ['Expired before pairing', activity?.outcomes.expired, 'health-neutral'],
    ]);
    bars('health-routes', [
      ['Direct reported', activity?.routes.direct, 'health-green'],
      ['Relay used', activity?.routes.relay, 'health-olive'],
      ['Unknown', activity?.routes.unknown, 'health-neutral'],
    ]);
    get('health-blocks').replaceChildren(el('h3', 'Protection activity'));
    const list = el('dl', undefined, 'health-block-list');
    for (const [label, key] of [
      ['Connection bursts', 'burst'],
      ['Code / connection limits', 'codes'],
      ['Transfer admission limits', 'transfers'],
    ]) {
      const row = el('div');
      row.append(el('dt', label), el('dd', number(blocks?.[key])));
      list.append(row);
    }
    get('health-blocks').append(list);
    if (snapshot) {
      get('health-updated').textContent =
        `Updated ${stamp(snapshot.generatedAt)} · refreshes every minute`;
      const missing = [
        !snapshot.activity && 'Transfer activity',
        !protection && 'Protection activity',
      ].filter(Boolean);
      if (missing.length) {
        get('health-error').textContent =
          `${missing.join(' and ')} unavailable. Available figures are shown below.`;
        get('health-error').hidden = false;
      }
    }
  }
  async function refresh() {
    if (busy || get('health-panel').hidden) return;
    busy = true;
    lastAttempt = Date.now();
    get('health').setAttribute('aria-busy', 'true');
    try {
      const response = await fetch('/api/health-overview', {
        cache: 'no-store',
        redirect: 'error',
      });
      if (response.status === 401 || response.status === 403)
        throw new Error('Your admin session ended. Reload this page to sign in again.');
      if (!response.ok) throw new Error('Could not update the health overview.');
      snapshot = await response.json();
      get('health-error').hidden = true;
      get('health').classList.remove('health-stale');
      render();
    } catch (error) {
      get('health').classList.add('health-stale');
      get('health-error').textContent =
        `${error.message || 'Could not update the health overview.'}${snapshot ? ` Showing the last snapshot from ${stamp(snapshot.generatedAt)}.` : ' Use Refresh to try again.'}`;
      get('health-error').hidden = false;
      get('health-updated').textContent = snapshot
        ? `Last successful update ${stamp(snapshot.generatedAt)}`
        : 'Overview unavailable';
    } finally {
      busy = false;
      get('health').setAttribute('aria-busy', 'false');
    }
  }
  document.querySelectorAll('[data-period]').forEach((button) =>
    button.addEventListener('click', () => {
      period = button.dataset.period;
      document
        .querySelectorAll('[data-period]')
        .forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      const staleText = get('health-updated').textContent;
      render();
      if (get('health').classList.contains('health-stale'))
        get('health-updated').textContent = staleText;
    }),
  );
  get('refresh').addEventListener('click', () => void refresh());
  const automaticRefresh = () => {
    if (!document.hidden && (!lastAttempt || Date.now() - lastAttempt >= 60000)) void refresh();
  };
  document.addEventListener('admin-tab-change', automaticRefresh);
  document.addEventListener('visibilitychange', automaticRefresh);
  setInterval(automaticRefresh, 60000);
  render();
})();
