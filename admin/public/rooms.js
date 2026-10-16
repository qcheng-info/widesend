// Rooms tab. Uses $, node, date, bytes, facts, api, closedText and refusalList from admin.js; every value is
// rendered as text, never HTML.
(() => {
  const roomStatus = { open: 'Open', dismissed: 'Closed by creator', expired: 'Expired' };
  const deliveryStatus = {
    offered: 'Offered',
    accepted: 'Accepted',
    declined: 'Declined',
    transferring: 'In progress · reported',
    complete: 'Received · reported',
    failed: 'Failed · reported',
    cancelled: 'Cancelled · reported',
  };
  const leftReason = {
    left: 'Left',
    removed: 'Removed by creator',
    dismissed: 'Room closed',
    expired: 'Room expired',
  };
  // Text messages are counted by members' browsers; contents never reach the server.
  const messages = (n) => `${n} ${n === 1 ? 'message' : 'messages'}`;
  let cursors = [null],
    page = 0,
    next = null,
    busy = false,
    loaded = false,
    current = null,
    version = 0;
  const fail = (error) => {
    $('room-error').textContent =
      error instanceof Error ? error.message : 'Could not load room activity.';
    $('room-error').hidden = false;
  };
  async function load() {
    if (busy) return;
    busy = true;
    loaded = true;
    $('room-error').hidden = true;
    $('room-summary').textContent = 'Loading…';
    const params = new URLSearchParams();
    if ($('room-q').value.trim()) params.set('q', $('room-q').value.trim());
    const cursor = cursors[page];
    if (cursor) for (const [key, value] of Object.entries(cursor)) params.set(key, value);
    try {
      const data = await api(`/api/rooms?${params}`);
      next = data.next;
      $('rooms').replaceChildren();
      for (const r of data.items) {
        const row = node('li');
        const button = node('button', undefined, 'record');
        button.type = 'button';
        button.dataset.id = r.id;
        button.setAttribute('aria-pressed', String(current === r.id));
        button.setAttribute('aria-controls', 'room-detail');
        const top = node('span', undefined, 'record-top');
        const identity = node('span', undefined, 'record-identity');
        const code = node('span', undefined, 'record-code');
        code.append(node('span', 'Code', 'small'), node('code', r.code, 'pairing-code'));
        identity.append(code, node('span', date(r.created_at), 'record-date'));
        top.append(identity, node('span', roomStatus[r.status] || 'Unknown', `badge ${r.status}`));
        const bottom = node('span', undefined, 'record-bottom');
        bottom.append(
          node('span', `Created by ${r.owner_name || 'unknown'}`),
          node(
            'span',
            `${r.member_count} ${r.member_count === 1 ? 'member' : 'members'} · ${r.offer_count} ${r.offer_count === 1 ? 'offer' : 'offers'}${r.message_count ? ` · ${messages(r.message_count)}` : ''}`,
          ),
        );
        button.append(top, bottom);
        button.addEventListener('click', () => void detail(r.id));
        row.append(button);
        $('rooms').append(row);
      }
      $('rooms-empty').hidden = data.items.length > 0;
      $('room-summary').textContent =
        `${data.items.length} ${data.items.length === 1 ? 'room' : 'rooms'} · page ${page + 1}`;
      $('rooms-previous').disabled = page === 0;
      $('rooms-next').disabled = !next;
    } catch (error) {
      fail(error);
      $('room-summary').textContent = 'Unavailable';
    } finally {
      busy = false;
    }
  }
  async function detail(id) {
    const mine = ++version;
    current = id;
    document
      .querySelectorAll('#rooms .record')
      .forEach((el) => el.setAttribute('aria-pressed', String(el.dataset.id === id)));
    $('room-placeholder').hidden = true;
    $('room-selected').hidden = false;
    $('room-id').textContent = id;
    $('room-detail').setAttribute('aria-busy', 'true');
    $('room-content').replaceChildren(node('p', 'Loading room…', 'detail-message'));
    try {
      const data = await api(`/api/rooms/${id}`);
      if (mine !== version) return;
      const r = data.room;
      const content = $('room-content');
      content.replaceChildren(
        facts(
          [
            ['Room code', r.code, 'pairing-code'],
            ['Status', roomStatus[r.status] || r.status],
            ['Created', date(r.created_at)],
            ['Expires', date(r.expires_at)],
            ['Ended', r.ended_at ? date(r.ended_at) : 'Still open'],
            ['Members', String(data.members.length)],
          ],
          'details-summary',
        ),
        node('h3', 'Members · server observed', 'section-heading'),
      );
      const members = node('div', undefined, 'detail-items');
      for (const m of data.members) {
        const card = node('article', undefined, 'connection-card');
        card.append(
          node('h4', `${m.name}${m.is_owner ? ' · creator' : ''}`),
          facts([
            ['Joined', date(m.joined_at)],
            [
              'Left',
              m.left_at
                ? `${date(m.left_at)} · ${leftReason[m.left_reason] || ''}`
                : 'Still a member',
            ],
            [
              'Messages',
              m.message_count
                ? `${messages(m.message_count)} · ${bytes(m.message_bytes)}`
                : 'No messages',
            ],
            ['Member ID', m.member_id, 'mono'],
          ]),
        );
        members.append(card);
      }
      content.append(members, node('h3', 'Offers · browser reports', 'section-heading'));
      const offers = node('div', undefined, 'detail-items');
      for (const o of data.offers) {
        const card = node('article', undefined, 'file-card');
        const head = node('div', undefined, 'file-heading');
        head.append(
          node('h4', `From ${o.sender_name || 'unknown'}`, 'file-name'),
          node('span', date(o.created_at), 'badge'),
        );
        card.append(
          head,
          node(
            'p',
            `${o.file_count} ${o.file_count === 1 ? 'file' : 'files'} · ${bytes(o.total_size)}`,
            'file-meta',
          ),
        );
        for (const f of o.files)
          card.append(
            node(
              'p',
              `${f.name || 'Not recorded'} · ${bytes(f.size)} · ${f.mime_type || 'Unknown type'}`,
              'file-meta',
            ),
            facts([
              ['MD5', f.md5 || 'Not reported', 'mono'],
              ['SHA-256', f.sha256 || 'Not reported', 'mono'],
            ]),
          );
        card.append(
          facts(
            o.deliveries.map((d) => [
              d.recipient_name || d.recipient_id,
              `${deliveryStatus[d.status] || d.status}${d.route !== 'connecting' ? ` · ${d.route}` : ''}`,
            ]),
          ),
        );
        offers.append(card);
      }
      if (!data.offers.length) offers.append(node('p', 'No offers were reported.', 'small'));
      content.append(
        offers,
        node('h3', 'Connections · server observed (latest 200)', 'section-heading'),
      );
      const connections = node('div', undefined, 'detail-items');
      for (const c of data.connections) {
        const card = node('article', undefined, 'connection-card');
        card.append(
          node('h4', c.member_name || 'Join request'),
          facts([
            ['Public IP', c.ip, 'mono'],
            ['Country', c.country || 'Unknown'],
            ['Connected', date(c.connected_at)],
            ['Disconnected', c.disconnected_at ? date(c.disconnected_at) : 'No close recorded'],
            ['Closed', closedText(c)],
          ]),
        );
        connections.append(card);
      }
      if (!data.connections.length)
        connections.append(node('p', 'No connections were recorded.', 'small'));
      content.append(
        connections,
        node('h3', 'Refused attempts · server observed (latest 100)', 'section-heading'),
        refusalList(data.refusals || []),
      );
    } catch (error) {
      if (mine === version) {
        fail(error);
        $('room-content').replaceChildren(
          node('p', 'Could not load this room. Select it to try again.', 'detail-message'),
        );
      }
    } finally {
      if (mine === version) $('room-detail').setAttribute('aria-busy', 'false');
    }
  }
  $('room-filters').addEventListener('submit', (event) => {
    event.preventDefault();
    cursors = [null];
    page = 0;
    void load();
  });
  $('rooms-next').addEventListener('click', () => {
    if (!next || busy) return;
    cursors[++page] = next;
    void load();
  });
  $('rooms-previous').addEventListener('click', () => {
    if (!page || busy) return;
    page--;
    void load();
  });
  $('refresh').addEventListener('click', () => {
    if ($('rooms-panel').hidden) return;
    void load();
    if (current) void detail(current);
  });
  document.addEventListener('admin-tab-change', () => {
    if (!$('rooms-panel').hidden && !loaded) void load();
  });
})();
