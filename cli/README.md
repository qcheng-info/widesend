# widesend

Send files from the terminal with a six-character code, to one person or several. They
receive them in a browser at [widesend.app](https://widesend.app), or with this same command. Files travel
directly between the two devices when the network allows, otherwise through an encrypted
relay. The server never stores them.

```
$ widesend send report.pdf data.tar
Sending 2 files (1.4 GiB)

  Code   A1B2C3
  Link   https://widesend.app/#A1B2C3
  (a QR code of the link)

Open the link to receive in a browser, or run: widesend receive A1B2C3
Sending  ██████████░░░░░░  62%  870.0 MiB / 1.4 GiB  41.3 MiB/s  direct  00:14 left
✓ All 2 files arrived and passed the receiver's check (direct connection).
```

```
$ widesend receive a1b2c3
From A1B2C3 — 2 files, 1.4 GiB
  report.pdf  2.1 MiB
  data.tar    1.4 GiB
Save to /home/me? [Y/n]
✓ Saved and verified (direct connection):
  /home/me/report.pdf
  /home/me/data.tar
```

## Install

Requires Node.js 22.14 or newer.

```sh
npm install -g widesend      # then: widesend send file.zip
npx widesend send file.zip   # or run it without installing
```

Tested on macOS and Linux. Windows should work (the native module below ships Windows builds)
but hasn't been tested yet.

Direct connections use [`node-datachannel`](https://www.npmjs.com/package/node-datachannel),
which ships prebuilt native binaries for macOS, Linux and Windows (x64 and arm64). If it can't
load on your system, `widesend` says so and uses the encrypted relay instead.

## Sending

`widesend send <file>...` sends up to 100 files. It prints a code, a link and, on a terminal
at least 46 columns wide, a QR code of the link for a phone. Keep the command running until
the receiver has the files: it exits once they confirm every file arrived intact.

Folders are refused. Put them in an archive first, for example `tar -czf photos.tar.gz photos`.

## Using a code more than once

`widesend send --uses 3 slides.pdf` (or `-n 3`) prints one code that can be used three times,
by different people or the same person on several devices, each in a browser or with
`widesend receive`. Each use is its own transfer and the command prints a line as each one
finishes:

```
$ widesend send -n 3 slides.pdf
Sending 1 file (12.4 MiB). The code can be used 3 times.
  …
✓ Use 1: delivered (direct connection).
✓ Use 2: delivered (encrypted relay).
1 sending (62%) · code open 14:05
```

Every use must happen within 20 minutes. The command ends when every use is taken and each
has finished, or when the 20 minutes are over and the uses so far have finished. Ctrl-C while
a use is receiving cancels it (exit 130); while it is only waiting for further uses after a
delivery, it stops sharing the code and finishes. It exits 0 when the files were delivered at
least once and no use that started receiving failed.

## Receiving

`widesend receive <code|link>` accepts the code in any case (`a1b2c3`) or the whole link. A
link brings its own server, so links from other WideSend sites work too. It lists the files
and asks before saving.

- Files go to the current folder, or to `-o <folder>`.
- An existing file is never replaced: a second `report.pdf` is saved as `report (1).pdf`.
- Files are written as `<name>.part` and renamed only after their SHA-256 matches the
  sender's.
- Without a terminal (scripts, `nohup`), add `-y`; otherwise the command refuses rather than
  waiting for an answer nobody can give.

## Options

| Option                  | Meaning                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `-o, --output <folder>` | Where received files go (default: the current folder)               |
| `-y, --yes`             | Receive without asking                                              |
| `-n, --uses <n>`        | How many times the code can be used, 1 to 10 (default 1)            |
| `--relay`               | Skip the direct connection and use the encrypted relay              |
| `--server <url>`        | WideSend server; also `WIDESEND_SERVER` (default: `r.widesend.app`) |
| `-h, --help`            | Help                                                                |
| `-v, --version`         | Version                                                             |

| Exit code | Meaning                                                |
| --------- | ------------------------------------------------------ |
| 0         | Done: every file arrived and was verified              |
| 1         | Failed, declined, or the other side ended the transfer |
| 2         | The command was used wrongly (nothing was sent)        |
| 130       | Ctrl-C (129 for a closed terminal, 143 for `kill`)     |

## Interruptions

While the command runs, it rides out network trouble: a Wi-Fi switch, a server restart, the
receiver's phone locking or their browser reloading. It waits and continues from the
receiver's last saved position.

Ctrl-C cancels: the other side is told, and an unfinished `.part` file is removed. Files
already verified stay. A second Ctrl-C quits at once.

A transfer can't yet survive the command itself being killed (for example a dropped SSH
session). For long sends over SSH, run it inside `tmux` or `screen`.

## How it travels, and what the server sees

`widesend` runs the same transfer engine as the WideSend web app, so the two work together.

- **Keys.** The six-character code authenticates a SPAKE2 key exchange (RFC 9382, P-256), and
  both sides confirm it before anything is sent. The resulting AES-256-GCM keys encrypt file
  names, sizes and contents before they leave the device; the server never sees them. Each
  device then pins the other's per-transfer key, so a reconnection can't be taken over by
  someone who learns the code later.
- **The code.** It has about 31 bits of entropy and works for 20 minutes, for as many uses as
  the sender allowed. Anyone who knows a live code can receive with it, so share it only with
  the people meant to get the files.
- **The route.** Files go directly over WebRTC when the networks allow (a public STUN server
  finds the route), otherwise the server relays the already-encrypted data. It never stores
  files.
- **What the server keeps.** Like the web app, `widesend` reports transfer activity to the
  server it uses. widesend.app keeps connection IPs, the pairing code, and file names, sizes,
  fingerprints and outcomes in its private activity log for 90 days; a server can be set not
  to keep file names, and a self-hosted server without the admin dashboard keeps no log at
  all. The command says what the server keeps the first time it uses it. Transfers from the
  command line are logged like browser transfers and are not marked as coming from it.
- **Limits.** The code is only as strong as six characters against an operator who knows it,
  you trust the server that serves the web page, there has been no independent cryptographic
  audit, and none of this is post-quantum.

The command sends an `Origin` header naming the server, because the server only accepts
connections that do. That header is a browser cross-site check, not authentication.

## Your own server

WideSend is a Cloudflare Workers app you can deploy yourself. Point the command at it with
`--server https://send.example.com` or `WIDESEND_SERVER`. Both devices must use the same
deployment. If the server is newer than your `widesend`, the command asks you to update it
(`npm install -g widesend@latest`).

## Development

The command lives in `cli/` of the WideSend repository and reuses the web app's code without
changing it: `build.mjs` bundles `src/transfer.ts` as it is and swaps only its two
browser-only modules (`./storage`, `./recovery`) for the Node versions in `cli/src/`.
`src/contract.ts` and `test/unit/globals.test.ts` fail if the web code starts needing
something the Node versions don't provide.

```sh
npm ci                 # in the repository root
cd cli && npm ci
npm run check          # type-check, build, unit tests
npm run test:e2e       # CLI and Chrome/WebKit/Firefox against a local Worker
WIDESEND_LARGE=1 npx playwright test -c test/e2e/playwright.config.ts large   # 512 MiB each way
```

The end-to-end tests serve the web app from the repository's `dist/`; run `npm run build` in
the root first.

## License

Apache-2.0. See `LICENSE`.
