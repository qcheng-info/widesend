# Configuration

An instance is configured by two Wrangler files: `wrangler.jsonc` for the public Worker and,
with the admin dashboard, `wrangler.admin.jsonc`. `npm run setup` writes the settings it
asks about; you can edit the others by hand and run `npm run deploy`. Settings that are not
written use the defaults in the code, so updates can improve them.

## Public Worker variables (`vars` in `wrangler.jsonc`)

| Variable            | Default                     | Meaning                                                                                                                                                                                                                                     |
| ------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SITE`              | the page's own address      | Your site's address, such as `https://send.example.com`. Browsers and the command line put it into their key exchanges, so every address of your instance pairs with the others. Setup sets it when the instance has more than one address. |
| `API_HOSTS`         | none                        | Hosts that serve only the API, for the command line (widesend.app uses `r.widesend.app`). Pages there redirect to `SITE`.                                                                                                                   |
| `RECORD_FILE_NAMES` | `true`                      | `false` keeps no file names in the activity record: browsers and the command line report placeholders, and the Worker stores no name whatever a page sends. Sizes, types and fingerprints are still recorded.                               |
| `PUBLIC_INSTANCE`   | `false`                     | `true` tells visitors (in How it works) that this is a free public instance and that heavy users should run their own.                                                                                                                      |
| `SOURCE_URL`        | none                        | An `http(s)` address where How it works links to the source code, such as your copy of the repository.                                                                                                                                      |
| `ABUSE_LIMITS`      | see below                   | Per-network and site-wide admission limits.                                                                                                                                                                                                 |
| `RELAY_BUDGET`      | `50000` units, stop at 80 % | `{ "dailyRequestUnits": 50000, "stopNewAtPercent": 80 }`: new relayed transfers wait once the day's estimated relay use reaches 40,000 units (about 98 GiB). See [self-hosting.md](self-hosting.md#what-it-costs).                          |
| `ROOM_LIMITS`       | `{ "maxMembers": 20 }`      | The largest room size a creator can choose (2 to 20).                                                                                                                                                                                       |

Pages learn the site name from `/api/health` when they open, trying three times. A page that
still can't reach it uses its own address, so it pairs only with pages on that address until
it is reloaded. Changing `SITE` on a running instance means transfers in progress resume only
after both pages reload.

### `ABUSE_LIMITS`

A network is a public IPv4 address or an IPv6 /64. The defaults suit a team; the second
column is what a site open to everyone (widesend.app) uses.

| Key                    | Default | Public site | Meaning                                               |
| ---------------------- | ------: | ----------: | ----------------------------------------------------- |
| `attemptsPerMinute`    |      60 |          20 | Unrecognized code or participant attempts per network |
| `attemptsPerHour`      |   1,000 |         250 | The same, per hour                                    |
| `createsPerHour`       |     200 |          20 | New transfers or rooms per network                    |
| `createsPerDay`        |   1,000 |         100 | The same, per day                                     |
| `createsGlobalPerDay`  |   2,000 |         500 | New transfers or rooms across the site per day        |
| `concurrentPerNetwork` |      20 |           5 | Open transfers per network                            |
| `concurrentGlobal`     |      50 |          25 | Open transfers across the site                        |
| `roomsPerNetwork`      |      10 |           3 | Open rooms per network                                |
| `roomsGlobal`          |      50 |          25 | Open rooms across the site                            |

Give only the keys you change, for example `"ABUSE_LIMITS": { "createsPerHour": 50 }`.
The `ratelimits` bindings (`NETWORK_RATE`, 120 a minute per network; `SITE_RATE`, 1,200 a
minute) catch short bursts at each Cloudflare location. Their `namespace_id` must differ
between instances on the same account; setup takes care of that. More on how the limits
work: [how-it-works.md](how-it-works.md#public-use-protection).

## Dashboard settings (`wrangler.admin.jsonc`)

| Setting                                            | Kind          | Meaning                                                                                                                                                                      |
| -------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_PASSWORD`                                   | secret        | The dashboard password, at least 12 characters. `npx wrangler secret put ADMIN_PASSWORD --config wrangler.admin.jsonc`.                                                      |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ADMIN_EMAILS` | secret or var | Cloudflare Access sign-in: the team domain, the application's AUD tag and the allowed e-mail addresses (comma-separated). When all three are set, Access is the only way in. |
| `GUARD` binding                                    | binding       | The public Worker's `AbuseGuard`, for the health overview; `script_name` is the public Worker's name.                                                                        |
| `ACTIVITY` binding                                 | binding       | The activity database, shared with the public Worker.                                                                                                                        |

See [admin.md](admin.md) for signing in.

## Bindings and resources

| Binding                     | Type                    | Notes                                                                                 |
| --------------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `ROOMS`                     | Durable Object (SQLite) | One per transfer code: pairing, the encrypted relay, 24-hour session records.         |
| `SHARE`                     | Durable Object (SQLite) | One per room.                                                                         |
| `GUARD`                     | Durable Object (SQLite) | Admission limits, the relay budget and the health counters.                           |
| `NETWORK_RATE`, `SITE_RATE` | Rate limit              | Burst limits per Cloudflare location.                                                 |
| `ASSETS`                    | Static assets           | The built site in `dist/`.                                                            |
| `ACTIVITY`                  | D1                      | Only with the dashboard. Migrations in `migrations/` are applied by `npm run deploy`. |
| Cron `17 * * * *`           | Trigger                 | Hourly cleanup of activity older than 90 days; does nothing without `ACTIVITY`.       |

Durable Object migrations (`v1`–`v3`) are part of the template: keep them when you edit
the file. The Worker logs only unexpected errors, without IP addresses or file details
(`observability` in the template).
