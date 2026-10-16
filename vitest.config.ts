import { defineConfig } from 'vitest/config';
// Many tests run the real Worker and Durable Objects in Miniflare; CI machines are slower
// than a laptop, so they get more than the default five seconds.
export default defineConfig({
  test: { include: ['tests/unit/**/*.test.ts'], testTimeout: 30_000 },
});
