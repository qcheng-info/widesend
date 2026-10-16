# Run your own WideSend

WideSend runs on Cloudflare: a Worker serves the site, Durable Objects pair devices and
relay encrypted data when they cannot connect directly, and an optional D1 database keeps
the activity record for the admin dashboard. The free Workers plan is enough for a person
or a team. Your instance is independent: its codes, rooms, limits and records are its own.

You need a Cloudflare account. For a custom domain, the domain's DNS must be on that
account. For the setup command you also need Node.js 22.14 or newer.

## Option 1: Deploy to Cloudflare button

The button copies this repository to your GitHub or GitLab account, then builds and
deploys it to your Cloudflare account. You get WideSend at
`https://widesend.<your-subdomain>.workers.dev`, with no activity record. Workers Builds
redeploys it whenever you push to your copy.

To add a custom domain or the admin dashboard later, clone your copy and run the setup
command below in it. It edits `wrangler.jsonc` (and adds `wrangler.admin.jsonc`): commit
and push those files so Workers Builds keeps deploying the same settings. Workers Builds
deploys only the site; the dashboard is a second Worker, which setup deploys from your
checkout. After an update, run `npm run deploy` there to update the dashboard too.

## Option 2: The setup command

```sh
git clone https://github.com/qcheng-info/widesend.git && cd widesend
npm ci
npx wrangler login        # or set CLOUDFLARE_API_TOKEN (see "API tokens" below)
npm run setup
```

Setup asks, showing the current value in brackets:

| Question                        | What it means                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Name of the Worker              | Usually `widesend`. The dashboard becomes `<name>-admin`, its database `<name>-activity`.                                           |
| Custom domain for the site      | For example `send.example.com`. Blank: `<name>.<your-subdomain>.workers.dev`.                                                       |
| Extra host for the command line | Optional, for a host that serves only the API (see `API_HOSTS` in [configuration.md](configuration.md)). Most sites leave it blank. |
| Add the admin dashboard?        | Adds the activity record and the dashboard to read it ([admin.md](admin.md)). Without it, the site records nothing.                 |
| Dashboard domain, sign-in       | Where the dashboard lives, and whether you sign in with a password (setup generates one) or Cloudflare Access.                      |
| Record file names?              | Whether the activity record keeps file names (sizes and fingerprints are kept either way).                                          |

It then creates the database if needed, writes the Wrangler files, builds, deploys both
Workers, sets the dashboard's sign-in, and prints the addresses. Keep the generated
password: it is shown once. Every question has an option for unattended use:

```sh
npm run setup -- --name widesend --domain send.example.com --admin \
  --admin-domain admin.example.com --yes
npm run setup -- --help
```

Run setup again at any time to change an instance. Press Enter to keep an answer, or type
`-` to clear it (for example, to go back from a custom domain to workers.dev).
`--no-deploy` only writes the files without calling Cloudflare; with the dashboard, give it
the database with `--database-id`.

## Use your instance

Open the site on both devices. Everyone using one code must use the same site.

The command line works with any instance:

```sh
npx widesend send report.pdf --server https://send.example.com
export WIDESEND_SERVER=https://send.example.com   # or set it once
npx widesend receive https://send.example.com/#A1B2C3   # a link carries its server
```

The "How it works" panel tells your visitors what your site records, from its actual
settings. To link it to your copy of the source, set `SOURCE_URL` (see
[configuration.md](configuration.md)).

## What it costs

WideSend uses no paid services. On the free Workers plan, Cloudflare gives each account
per day 100,000 Durable Object requests (incoming WebSocket messages count 1 for every 20)
and 13,000 GB-s of Durable Object time. Direct transfers use almost none of it; relayed
ones use about 410 requests per GiB. WideSend's relay budget (`RELAY_BUDGET`) stops new
relayed transfers at 40,000 units a day, roughly **98 GiB of relayed files a day**, so the
site keeps working for pairing and direct transfers. The allowance resets at 00:00 UTC, and
going over it is never billed on the free plan: Cloudflare pauses the affected requests
until the next day.

On Workers Paid (USD 5 a month) the allowance is monthly: 1 million requests (about
2.4 TiB of relayed files) and 400,000 GB-s, then USD 0.15 per million requests and USD
12.50 per million GB-s. Cloudflare charges nothing for bandwidth. Raise `RELAY_BUDGET`
if you move to Workers Paid. Several instances on one account share its allowance.

## Limits for a team or for everyone

The defaults suit a person or a team, even one behind a single office address: 200 new
transfers an hour per network, 20 at once. If you open your site to everyone, set stricter
`ABUSE_LIMITS` (the values widesend.app uses are in [configuration.md](configuration.md)),
and keep the relay budget, so that strangers cannot use up your allowance.

## Update

```sh
git pull                  # or merge the upstream repository into your copy
npm ci
npm run deploy            # applies database migrations, deploys both Workers
```

Workers Builds deploys a button copy's site by itself when you push the merge; run
`npm run deploy` in your checkout to update its dashboard.

## Several instances from one checkout

Setup can keep an instance's files in a folder instead of the repository's root, so one
checkout deploys several instances and `git pull` never touches their settings:

```sh
npm run setup -- --dir instances/team
npm run deploy -- --dir instances/team
npm run deploy -- --all            # every folder in instances/
```

The `instances/` folder is not committed. Instances on the same account get their own
rate-limit namespaces automatically (1001/1002, 2001/2002, …).

## API tokens

`npx wrangler login` stores a session for your user. To use an API token instead (for
CI, or a machine whose Wrangler session belongs to another account), create one with
**Workers Scripts: Edit**, **D1: Edit**, **Account Settings: Read** and, for custom
domains, **Workers Routes: Edit**, **DNS: Edit** and **SSL and Certificates: Edit** on the
zone. Put it in a git-ignored `.env`, which setup and Wrangler both read:

```sh
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...                  # if the token can see several accounts
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false   # keep them out of `wrangler dev`
```

## Remove an instance

```sh
npx wrangler delete --name widesend
npx wrangler delete --name widesend-admin      # if you added the dashboard
npx wrangler d1 delete widesend-activity       # deletes the activity record
```

## Troubleshooting

- **Setup says to log in**: run `npx wrangler login`, or set `CLOUDFLARE_API_TOKEN`.
- **A custom domain doesn't deploy**: the domain must be a zone on the same Cloudflare
  account. A new domain can take a few minutes to get its certificate.
- **"Server busy" or a page waiting to reconnect**: a limit was reached; the page retries
  by itself. See the dashboard's Health overview, and the limits in
  [configuration.md](configuration.md).
- **The dashboard says sign-in is not configured**: see [admin.md](admin.md#troubleshooting).
