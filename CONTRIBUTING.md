# Contributing

Thank you for helping. Bug reports and pull requests are welcome; for a larger change,
open an issue first to agree on the approach.

## Set up

Node.js 22.14 or newer and npm. The browser tests use an installed Google Chrome; to use
Playwright's own Chromium instead, remove `channel: 'chrome'` in `playwright.config.ts` and
run `npx playwright install chromium` (and `webkit firefox` for the other two browsers).

```sh
npm ci
cd cli && npm ci
```

`npm run dev` runs the site locally on http://localhost:8787.

## Before a pull request

```sh
npm run check            # type checks, build, unit tests
npm run format:check
cd cli && npm run check  # the command line
npm run test:e2e         # for changes to pages or transfers: Chrome, WebKit and Firefox
```

Add or change tests with your change; a bug fix comes with a test that failed before it.
Keep commits focused, with a subject that says what changes for people using WideSend.

## Rules of the repository

- **No personal configuration.** `wrangler.jsonc` is a template that deploys as is; your
  instances belong in the git-ignored `instances/` folder or in your own copy. Never
  commit `.env`, API tokens, account or database IDs. `tests/unit/template.test.ts` checks
  part of this.
- **Dependencies** are pinned to exact versions, preferably releases at least two weeks
  old.
- **Security problems** are reported privately: see [SECURITY.md](SECURITY.md).

Contributions are licensed under Apache-2.0, like the rest of the project ([LICENSE](LICENSE)).
