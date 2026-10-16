# WideSend activity dashboard

The public transfer site stays open. The optional dashboard is a separate Worker, `<name>-admin`, that serves the private activity record and its API. Both Workers bind the instance's D1 database, `<name>-activity`; without the dashboard there is no database and nothing below is recorded. No file contents are ever written to D1.

## What is recorded

- **Server observed:** connection IP, country when available, sender/receiver role, connection and disconnection times. IPs may identify a VPN or shared network rather than one person.
- **Browser reported:** filename, MIME type, size, MD5, SHA-256, connection route, and transfer result. Sender and receiver reports are retained separately and compared in the dashboard. These are not independent proof of file contents.
- The MD5 and SHA-256 fingerprints are calculated incrementally. The receiver calculates them while reading back its verified temporary file in browser storage. Interrupted files may have no complete fingerprint.
- **File names** are recorded unless the deployment sets `RECORD_FILE_NAMES` to `false` (setup asks; see [configuration.md](configuration.md)). Then every file shows **Not recorded**; sizes, types and fingerprints remain.
- **Transfer code:** the six uppercase letters/digits supplied by an admitted device at connection time, checked against the room hash. The first recorded code is preserved across reconnects, visible for active and completed transfers, and retained for the same 90 days. Older records without a reported code show **Not recorded**; codes are not reconstructed from historical metadata.
- **Code uses:** when a sender lets a code be used several times, each use is its own record with the shared code, labelled **Use 2 of 3** in the list and detail. Health statistics count each use as a transfer. A use nobody claimed in the 20-minute window appears as an expired record; one closed by **Stop sharing** as cancelled. Someone who arrives after every use is taken is listed under **Refused attempts** as `Code already used` (close code 4005).
- The session ID is derived from the sender's independent random connection credential. The connection credential and file contents are not stored in the activity database. For SPAKE2 transfers, traffic keys and private device keys never enter D1 and cannot be derived from the recorded code. Someone who knows a live code can still impersonate a device during initial pairing; private admin records remain sensitive. A paired device’s private signing key is additionally required on resume. Historical traffic from the previous code-derived protocol does not gain these protections. See [SECURITY.md](../SECURITY.md).
- Records begin at transfer creation, not ordinary homepage visits. Transfers made before logging was deployed cannot be recovered.

### Rooms

The **Rooms** tab lists share rooms newest first and searches by code, member name, IP, filename or fingerprint. A room shows:

- **Server observed:** when it was created, closed or expired; each member's display name, join and leave times (left, removed, room closed, expired); every connection's IP, country and times, including join requests that were never admitted.
- **Member reported:** each offer's sender, file names, types, sizes, MD5 and SHA-256, and for every recipient whether they accepted, declined or received it, with the route used. Only a recipient reports its own result; a sender can only mark a delivery cancelled or failed. Results never go back from complete to in progress.
- **Messages:** how many text messages each member sent and their total size, shown on the member's card and as a total in the room list. Browsers report these totals at most every 30 seconds; message contents never reach the server. A room records at most 1,000 updates to these totals.

Room records follow the same 90-day retention and hourly cleanup as transfers (migrations `0005_share_rooms.sql` and `0007_room_messages.sql`). `npm run deploy` applies new migrations before deploying.

### Diagnostics

To explain real-world failures later (migration `0006_diagnostics.sql`):

- **Why each connection closed.** Every transfer and room connection card shows **Closed**:
  - **By the server**, with its reason, e.g. `Room full`, `Declined`, `Removed`, `Connection replaced`, `Invalid message`.
  - **By the browser**, with the reason the page gave. Examples: `Key check with the room creator failed`, `No reply from the server for 45 s`, `Network changed`, `Transfer cancelled.`, `Room closed on this page`. Code 1001, `Page closed or went to the background`, is what browsers send when a tab closes.
  - **Connection lost** (code 1006): the network or page disappeared without saying goodbye. A phone whose screen locked usually looks like this. Code 1005, `Closed without a code`, is a page closing without saying why (older pages).
  - Browsers close their own connections with code 4100 (finished) or 4101 (replacing a connection that seems broken); the server's codes are 4000–4015.
- **Refused attempts.** Joins and transfer connections turned away before they started are listed under **Refused attempts** on the room or transfer they were for. Examples: room full, room or sender not found, rate-limited, a malformed handshake. Each shows the time, what was asked (create, join, send…), IP, country, code and reason. An attempt for a room that doesn't exist (a mistyped code, say) has no room to appear under; it stays searchable in the `refusals` table by IP. Recording is capped at 2,000 refused attempts a day overall and 50 per IP a day, so a flood cannot spend the database's free writes; edge rate-limit bursts are never recorded individually. Refused attempts follow the same 90-day retention and hourly cleanup.
- **Server errors in Workers Logs.** The public Worker writes one log line for each unexpected failure only: a rejected message (with its type and error), or a failed activity-database write. Automatic per-request logs are off. Log lines carry short room, member and connection ID prefixes, never IP addresses, names, codes or file details. On the Free plan Cloudflare keeps them for 3 days: **Workers & Pages → your Worker → Logs**.

Records older than **90 days from transfer creation** are excluded from all dashboard queries. An hourly scheduled job deletes expired transfers and related file/connection records in bounded batches, with a lease against overlapping jobs and a database write budget. Heavy backlogs or failed jobs may delay physical deletion; the admin API still hides expired records. The Health tab shows expired records remaining and the last cleanup result. D1 platform backups have their own retention: on Free, Time Travel can recover recent database states for up to seven days. Do not describe application cleanup as immediate deletion from all Cloudflare backups.

## Set up the dashboard

The dashboard is optional. Add it with the setup command (see [self-hosting.md](self-hosting.md)):

```sh
npm run setup -- --admin
```

It creates (or finds) the D1 database `<name>-activity`, binds it to the public Worker so transfers start being recorded, applies the migrations, deploys the dashboard as the Worker `<name>-admin` on workers.dev or on a domain you give (`--admin-domain admin.example.com`), and sets up sign-in. Running it again changes these choices; `npm run setup -- --no-admin` turns recording off again (the Worker and the database stay until you delete them).

Until sign-in is configured, **every dashboard page and API returns HTTP 503 and no records are exposed**. There is no bypass query parameter or development sign-in mode in the deployed Worker.

## Sign in with a password

The default. Setup generates a strong password, shows it once and stores it as the dashboard Worker's `ADMIN_PASSWORD` secret; nothing is written to your files. To choose your own (at least 12 characters), pass `--password` or answer no when asked to generate one: Wrangler then asks for it without showing what you type. To change it later:

```sh
npx wrangler secret put ADMIN_PASSWORD --config wrangler.admin.jsonc
```

Changing the password signs everyone out. A session lasts 12 hours in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie signed with a key derived from the password. Sign-in attempts are limited per network (a public IPv4 address or an IPv6 /64) to 10 every 15 minutes and 100 a day. There is no shared limit, so guesses from other networks never lock you out; that is why the password must be long. A password shorter than 12 characters is refused (503). **Sign out** ends the session.

## Sign in with Cloudflare Access

For one-time PIN e-mails or your identity provider. Visitors to the public site never sign in.

1. In the Cloudflare dashboard, open **Zero Trust / Cloudflare One**. If this is your first use, create a team and select the **Free** plan (up to 50 users). Note the team domain, such as `your-team.cloudflareaccess.com`.
2. Under **Integrations → Identity providers**, add **One-time PIN** if it is not already available.
3. Under **Access → Applications**, choose **Add an application → Self-hosted**.
4. Name it **WideSend Admin** and set its public hostname to your dashboard's address, for example `admin.example.com`. Leave the path empty so the whole hostname, including `/api/*`, is protected. Do **not** use the public site's hostname. (A dashboard on workers.dev can be protected from the Worker's **Settings → Domains & Routes** in the Cloudflare dashboard.)
5. Add an **Allow** policy. Under **Include**, select **Emails** and enter your exact admin e-mail address. Do not choose Everyone, a wildcard or a Bypass policy.
6. Save the application, open its details and copy the **Application Audience (AUD) tag** (normally 64 hexadecimal characters).
7. Run setup with Access:

   ```sh
   npm run setup -- --admin --sign-in access \
     --access-team your-team.cloudflareaccess.com \
     --access-aud YOUR_APPLICATION_AUD_TAG \
     --access-email you@example.com
   ```

   The three values are stored as the dashboard Worker's secrets (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ADMIN_EMAILS`), so they stay out of your files; they may also be set as `vars` in `wrangler.admin.jsonc`. When Access is configured, it is the only way in, and setup removes any dashboard password.

8. Open the dashboard and sign in with your approved e-mail and the PIN Cloudflare sends you.

The Worker verifies the Access token's signature, issuer, application audience, expiry and e-mail allowlist before serving **any** asset or API. A forged e-mail header is not sufficient. If you later add another dashboard hostname, protect that hostname with Access too.

## Use the dashboard

The dashboard opens on **History**, with the transfer list, filters, and record details. Select **Health overview** to view the statistics. Switching tabs preserves your search, selected record, and health period; reloading the page opens History again. The tabs also support the left/right arrow, Home, and End keys.

Health statistics load when you first open **Health overview**. **Today** starts at 00:00 UTC; **Last 7 days** includes today and the previous six UTC calendar days. The overview refreshes every minute while its tab and the browser page are visible, on returning when due, and with **Refresh**. Switching periods uses the same snapshot. History filters affect only the record list.

- **Transfers started, outcomes, and routes:** summaries of transfers created in the selected period, using the same outcome rules as the record list. Completion requires a receiver report. A sender-only completion stays in progress; missing results and routes stay unconfirmed/unknown. Any reported relay use takes precedence over direct use. Each transfer is counted once, regardless of file count or the number of connections.
- **Reconnections:** additional admitted connections for the same transfer and sender/receiver role, occurring in the selected period. Initial connections and unsuccessful retries do not count. A reopened tab counts; this is not a count of distinct people or necessarily a network fault.
- **Connection reservations:** the current admission guard's reserved transfer slots, connection reservations, and configured capacity, independent of the selected history period. Completed open tabs still reserve slots. A missing close event may leave a reservation for up to 15 minutes, so these are not a promise of live byte transmission.
- **Blocked attempts:** recorded rejections from connection bursts, code/connection limits, and transfer admission limits. History starts with this update; earlier blocks cannot be reconstructed. Counts are best effort, batched about every ten seconds, and can have gaps after a restart or outage. They count attempts, not people, and exclude requests blocked by Cloudflare before the Worker runs.
- **Relay usage:** server-observed forwarded bytes (including public key exchange, encrypted signaling, overhead and retries), handled incoming WebSocket messages, estimated units (messages ÷ 20), and transfers declined for relay (each counted once per UTC day). Direct file traffic and automatic heartbeats are excluded. Totals follow the selected UTC period; the admission budget always applies to today. Counters begin at deployment and cannot reconstruct earlier traffic.
- **Relay budget:** by default, new relay admissions stop at 40,000 estimated request units, 80% of a 50,000-unit planning budget. Already admitted sessions keep access until their original expiry, including after reconnecting. Updated browsers keep direct connectivity available and retry declined relays automatically. This is an early admission cutoff, not a hard quota cap. Edit `vars.RELAY_BUDGET` in `wrangler.jsonc` and run `npm run deploy` to change it (see [configuration.md](configuration.md)).
- **90-day cleanup:** the latest hourly run, transfer records deleted, database row writes, and expired records still physically present. A job can finish successfully with a backlog; subsequent hourly batches continue it. Failed, unfinished, or overdue runs are identified. New deployments show “Waiting for first cleanup” until the next scheduled run.

Unavailable sources display **—**, not zero. If an overview request fails, the last successful snapshot remains visible with an explicit stale notice and timestamp. Activity searches and record details work independently.

The footer links to the Cloudflare dashboard for actual account usage. App counters and message-derived request estimates are not billing/quota measurements. They exclude HTTP requests, internal calls, alarms, runtime, database usage and other apps. WideSend does not store a Cloudflare API token or request additional login settings for this view. Relay counters normally flush during activity every 30 seconds or 512 messages, at completion/disconnection, and during five-minute maintenance. Outages may leave gaps; unreported traffic is not assumed to be zero usage on the Cloudflare account.

The dashboard Worker reads aggregate protection information through a `GUARD` binding to the public Worker's `AbuseGuard`; setup sets its `script_name` to the public Worker's name. `npm run deploy` applies new database migrations before deploying both Workers.

Blocked counts are stored as hourly aggregates in the guard's SQLite database for 90 days, without IPs, filenames, transfer codes, or credentials in those counters. Edge isolates batch before making a guard call; the guard also batches its own rejected admissions. There are no monitoring writes per file chunk and no individual rows for edge-blocked bursts. Refused joins and transfer connections are recorded individually, with caps; see **Diagnostics**. The history queries use date and per-participant connection indexes.

- Search by exact six-character code (case-insensitive), IP, MD5, SHA-256, or session ID; filename search matches part of the name.
- Filter by result and date (date boundaries are UTC; displayed times use your browser's local timezone).
- Select a transfer record in the left panel to view per-file sender/receiver reports, hash comparisons, and the most recent 200 connection records in the right panel. On mobile, the details appear below the list.
- **Receiver confirmed** means the receiving browser reported receiving and verifying all bytes. It does not confirm that the browser finished saving its ordinary download, or that the server inspected the file.
- **Reports match** means both browsers supplied matching filenames, sizes, and hashes. It does not establish the identities of those browsers or guarantee they were honest.
- **In progress** is a browser report. An abruptly closed tab may remain unconfirmed until its maximum session lifetime ends. No heartbeat database write is performed for every packet.
- **Refresh** updates the selected tab: the list and selected record in History, or the statistics in Health overview. Separate sessions may reuse a code; they remain distinct records. **Sign out** ends the session (Cloudflare Access or password).

## Reliability and limits

Logging is best effort and does not block the encrypted file path. Reports are bounded, tied to an admitted sender/receiver socket, acknowledged after database writes, and retried a limited number of times. Retries preserve terminal statuses and do not duplicate file records. A closed browser, database outage, free-tier quota exhaustion, or a modified client can leave incomplete or missing records. There is no claim of a complete forensic audit trail.

There are no database writes per file chunk. D1 writes happen for connections, manifests, file fingerprints, and changes to transfer status. Retention is 90 days. Without the dashboard, the public Worker has no database and records nothing.

Application D1 queries use parameters; filenames are rendered as text in the dashboard. All admin responses use `no-store` and a restrictive Content Security Policy. No CSV export or public metadata-reading endpoint is included in this version.

## Troubleshooting

- **503 “Admin sign-in is not configured”**: run `npm run setup -- --admin` again, or set the password with `npx wrangler secret put ADMIN_PASSWORD --config wrangler.admin.jsonc` (12+ characters).
- **“That password is not right” / too many attempts**: wait 15 minutes after ten tries, or set a new password as above.
- **403 after signing in with Access**: check the team domain, application AUD tag and e-mail allowlist you gave setup, and that the Access application protects the exact dashboard hostname.
- **No e-mail arrives**: confirm the exact e-mail is allowed by the Access policy, enable One-time PIN, and check spam.
- **Activity unavailable**: run `npm run deploy` (it applies pending migrations) and check D1 usage limits. Do not remove sign-in checks to debug this.
- **Someone couldn't connect or kept dropping**: open their transfer or room and read **Closed** on each connection and the **Refused attempts** list (see Diagnostics). For server-side errors, check the Worker's Logs in the Cloudflare dashboard within 3 days.
- **Empty history**: recording starts when the dashboard is set up; earlier transfers were never recorded. Old tabs may still run a previous version; refresh both devices before testing.

## Local verification

```sh
npm run check
npm run test:e2e
npm run deploy:dry
```

Unit tests cover signed Access tokens, password sessions and sign-in limits, denied requests, database queries, pagination, record retention, report validation and fingerprints. Browser tests cover actual transfer paths and the dashboard with mocked activity responses; tests contain no production sign-in bypass.

References: [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [one-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).
