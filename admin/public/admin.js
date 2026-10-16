const $ = (id) => document.getElementById(id);
(() => {
  const tabs = [...document.querySelectorAll('.admin-tabs [role="tab"]')];
  function select(tab) {
    for (const item of tabs) {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      $(item.getAttribute('aria-controls')).hidden = !active;
    }
    document.dispatchEvent(new Event('admin-tab-change'));
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (event) => {
      const next = {
        ArrowRight: (index + 1) % tabs.length,
        ArrowLeft: (index + tabs.length - 1) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      tabs[next].focus();
      select(tabs[next]);
    });
  });
})();
const statusLabels = {
  waiting: 'Waiting',
  transferring: 'In progress · reported',
  complete: 'Receiver confirmed',
  error: 'Failed · reported',
  cancelled: 'Cancelled · reported',
  interrupted: 'Unconfirmed / interrupted',
  expired: 'Expired before pairing',
};
let cursors = [null],
  pageIndex = 0,
  next = null,
  loading = false;
let currentDetail = null,
  detailVersion = 0;
const date = (value) => (value ? new Date(value).toLocaleString() : '—');
function bytes(value) {
  if (value === null || value === undefined) return 'Unknown';
  if (!value) return '0 B';
  const i = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** i).toFixed(i ? 1 : 0)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][i]}`;
}
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function route(t) {
  const routes = [t.sender_route, t.receiver_route];
  return routes.includes('relay') ? 'Relay used' : routes.includes('direct') ? 'Direct' : 'Unknown';
}
function receiverLabel(t) {
  return `Use ${t.slot + 1} of ${t.uses}`;
}
function transferCode(t) {
  return typeof t.code === 'string' && /^[A-Z0-9]{6}$/.test(t.code) ? t.code : null;
}
async function api(path) {
  const response = await fetch(path, { cache: 'no-store', redirect: 'error' });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new Error('Your admin session ended. Reload this page to sign in again.');
    throw new Error('Could not load activity. Try again shortly.');
  }
  return response.json();
}
function showError(error) {
  $('error').textContent = error instanceof Error ? error.message : 'Could not load activity.';
  $('error').hidden = false;
}
async function load() {
  if (loading) return;
  loading = true;
  $('error').hidden = true;
  $('summary').textContent = 'Loading…';
  $('refresh').disabled = true;
  const params = new URLSearchParams();
  for (const id of ['q', 'status', 'from', 'to']) if ($(id).value) params.set(id, $(id).value);
  const cursor = cursors[pageIndex];
  if (cursor) for (const [key, value] of Object.entries(cursor)) params.set(key, value);
  try {
    const data = await api(`/api/transfers?${params}`);
    next = data.next;
    $('transfers').replaceChildren();
    for (const t of data.items) {
      const row = node('li');
      const button = node('button', undefined, 'record');
      button.type = 'button';
      button.dataset.id = t.id;
      button.setAttribute('aria-pressed', String(currentDetail === t.id));
      button.setAttribute('aria-controls', 'detail');
      const top = node('span', undefined, 'record-top');
      const identity = node('span', undefined, 'record-identity');
      const code = node('span', undefined, 'record-code');
      code.append(
        node('span', 'Code', 'small'),
        transferCode(t)
          ? node('code', transferCode(t), 'pairing-code')
          : node('span', 'Not recorded', 'small'),
      );
      identity.append(code, node('span', date(t.started_at), 'record-date'));
      // A code used several times: each use is its own record.
      if (t.uses > 1) identity.append(node('span', receiverLabel(t), 'small'));
      top.append(identity, node('span', statusLabels[t.status] || 'Unknown', `badge ${t.status}`));
      const peers = node('span', undefined, 'record-peers');
      for (const [label, value] of [
        ['Sender', t.sender_ip || 'Unknown'],
        ['Receiver', t.receiver_ip || 'Not connected'],
      ]) {
        const peer = node('span');
        peer.append(node('span', label, 'small'), node('span', value, 'mono'));
        peers.append(peer);
      }
      const bottom = node('span', undefined, 'record-bottom');
      bottom.append(
        node(
          'span',
          `${t.file_count || 0} ${(t.file_count || 0) === 1 ? 'file' : 'files'} · ${bytes(t.total_size)}`,
        ),
        node('span', route(t)),
      );
      button.append(top, peers, bottom);
      button.addEventListener('click', () => void details(t.id, true));
      row.append(button);
      $('transfers').append(row);
    }
    $('empty').hidden = data.items.length > 0;
    $('summary').textContent =
      `${data.items.length} ${data.items.length === 1 ? 'transfer' : 'transfers'} · page ${pageIndex + 1}`;
    $('previous').disabled = pageIndex === 0;
    $('next').disabled = !next;
  } catch (error) {
    showError(error);
    $('summary').textContent = 'Unavailable';
  } finally {
    loading = false;
    $('refresh').disabled = false;
  }
}
function highlightSelection() {
  document
    .querySelectorAll('.record')
    .forEach((el) => el.setAttribute('aria-pressed', String(el.dataset.id === currentDetail)));
}
function clearSelection() {
  detailVersion++;
  currentDetail = null;
  $('detail').setAttribute('aria-busy', 'false');
  $('detail-selected').hidden = true;
  $('detail-placeholder').hidden = false;
  $('close-detail').hidden = true;
  highlightSelection();
}
function facts(entries, className = 'fact-list') {
  const list = node('dl', undefined, className);
  for (const [label, value, style] of entries) {
    const item = node('div');
    item.append(node('dt', label), node('dd', value || 'Unknown', style));
    list.append(item);
  }
  return list;
}
// Who ended a connection and why, as the server recorded it.
function closedText(c) {
  if (!c.closed_by) return c.disconnected_at ? 'Not recorded' : 'Still connected';
  if (c.closed_by === 'lost') return `Connection lost (${c.close_code})`;
  const who = c.closed_by === 'server' ? 'By the server' : 'By the browser';
  return `${who}: ${c.close_reason || 'No reason given'} (${c.close_code})`;
}
const attemptRole = {
  send: 'Send',
  receive: 'Receive',
  create: 'Create the room',
  join: 'Join',
  rejoin: 'Rejoin',
};
// Attempts turned away before they became connections.
function refusalList(refusals) {
  const list = node('div', undefined, 'detail-items');
  for (const r of refusals) {
    const card = node('article', undefined, 'connection-card refusal-card');
    card.append(
      node('h4', r.reason),
      facts([
        ['When', date(r.at)],
        ['Asked to', attemptRole[r.role] || 'Unknown'],
        ['Public IP', r.ip, 'mono'],
        ['Country', r.country || 'Unknown'],
        ['Code', String(r.code), 'mono'],
      ]),
    );
    list.append(card);
  }
  if (!refusals.length) list.append(node('p', 'No attempts were refused.', 'small'));
  return list;
}
async function details(id, navigate = false) {
  const version = ++detailVersion;
  const changed = currentDetail !== id;
  currentDetail = id;
  highlightSelection();
  $('error').hidden = true;
  $('close-detail').hidden = false;
  $('detail-placeholder').hidden = true;
  $('detail-selected').hidden = false;
  $('detail').setAttribute('aria-busy', 'true');
  $('detail-id').textContent = id;
  if (changed)
    $('detail-content').replaceChildren(node('p', 'Loading transfer…', 'detail-message'));
  if (navigate && matchMedia('(max-width: 1000px)').matches) {
    $('detail-heading').focus({ preventScroll: true });
    $('detail').scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      block: 'start',
    });
  }
  try {
    const data = await api(`/api/transfers/${id}`);
    if (version !== detailVersion) return;
    const t = data.transfer;
    const content = $('detail-content');
    content.replaceChildren();
    const finished = t.receiver_finished_at || t.sender_finished_at;
    content.append(
      facts(
        [
          [
            'Transfer code',
            transferCode(t) || 'Not recorded',
            transferCode(t) ? 'pairing-code' : '',
          ],
          ...(t.uses > 1 ? [['Use', `${t.slot + 1} of ${t.uses}`]] : []),
          ['Started', date(t.started_at)],
          ['Last activity', date(t.updated_at)],
          [
            'Duration',
            finished
              ? `${Math.max(0, Math.round((finished - t.started_at) / 1000))} seconds`
              : 'Not confirmed',
          ],
          ['Route reported', route(t)],
          [
            'Sender reports',
            t.sender_status === 'complete'
              ? 'Complete · reported'
              : statusLabels[t.sender_status] || t.sender_status || 'Unknown',
          ],
          [
            'Receiver reports',
            t.receiver_status === 'complete'
              ? 'Complete · reported'
              : statusLabels[t.receiver_status] || t.receiver_status || 'Unknown',
          ],
        ],
        'details-summary',
      ),
    );
    content.append(node('h3', 'Files · browser reports', 'section-heading'));
    const files = node('div', undefined, 'detail-items');
    for (const f of data.files) {
      const counterpart = data.files.find(
        (other) => other.file_id === f.file_id && other.role !== f.role,
      );
      const item = node('article', undefined, 'file-card');
      const head = node('div', undefined, 'file-heading');
      head.append(
        // A deployment that doesn't record file names stores them empty.
        node('h4', f.name || 'Not recorded', 'file-name'),
        node('span', f.role === 'send' ? 'Sender' : 'Receiver', 'badge'),
      );
      item.append(
        head,
        node('p', `${bytes(f.size)} · ${f.mime_type || 'Unknown type'}`, 'file-meta'),
      );
      item.append(
        facts([
          ['MD5', f.md5 || 'Not reported', 'mono'],
          ['SHA-256', f.sha256 || 'Not reported', 'mono'],
        ]),
      );
      let comparison = 'Awaiting both fingerprints',
        style = 'small';
      if (counterpart?.sha256 && f.sha256) {
        const match =
          counterpart.sha256 === f.sha256 &&
          counterpart.md5 === f.md5 &&
          counterpart.size === f.size &&
          counterpart.name === f.name;
        comparison = match ? 'Reports match' : 'Reports differ';
        style = match ? 'match' : 'warning';
      }
      item.append(node('p', comparison, `comparison ${style}`));
      files.append(item);
    }
    if (!data.files.length) files.append(node('p', 'No file metadata was reported.', 'small'));
    content.append(
      files,
      node('h3', 'Connections · server observed (latest 200)', 'section-heading'),
    );
    const connections = node('div', undefined, 'detail-items');
    for (const c of data.connections) {
      const item = node('article', undefined, 'connection-card');
      item.append(node('h4', c.role === 'send' ? 'Sender' : 'Receiver'));
      item.append(
        facts([
          ['Public IP', c.ip, 'mono'],
          ['Country', c.country || 'Unknown'],
          ['Connected', date(c.connected_at)],
          ['Disconnected', c.disconnected_at ? date(c.disconnected_at) : 'No close recorded'],
          ['Closed', closedText(c)],
        ]),
      );
      connections.append(item);
    }
    if (!data.connections.length)
      connections.append(node('p', 'No connections were recorded.', 'small'));
    content.append(
      connections,
      node('h3', 'Refused attempts · server observed (latest 100)', 'section-heading'),
      refusalList(data.refusals || []),
    );
  } catch (error) {
    if (version === detailVersion) {
      showError(error);
      $('detail-content').replaceChildren(
        node(
          'p',
          'Could not load this transfer. Select the record to try again.',
          'detail-message',
        ),
      );
    }
  } finally {
    if (version === detailVersion) $('detail').setAttribute('aria-busy', 'false');
  }
}
$('filters').addEventListener('submit', (event) => {
  event.preventDefault();
  if (loading) return;
  clearSelection();
  cursors = [null];
  pageIndex = 0;
  void load();
});
$('refresh').addEventListener('click', () => {
  if ($('history-panel').hidden) return;
  void load();
  if (currentDetail) void details(currentDetail);
});
document.addEventListener('admin-tab-change', () => {
  $('refresh').disabled = loading && !$('history-panel').hidden;
});
$('next').addEventListener('click', () => {
  if (!next || loading) return;
  clearSelection();
  cursors[++pageIndex] = next;
  void load();
});
$('previous').addEventListener('click', () => {
  if (pageIndex === 0 || loading) return;
  clearSelection();
  pageIndex--;
  void load();
});
$('close-detail').addEventListener('click', () => {
  const selected = document.querySelector('.record[aria-pressed="true"]');
  clearSelection();
  selected?.focus();
});
void api('/api/me')
  .then((me) => {
    $('email').textContent = me.email;
    if (me.signOut) $('sign-out').href = me.signOut;
  })
  .catch(showError);
void load();
