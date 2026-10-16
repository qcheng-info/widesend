// Turning typed answers into settings, for npm run setup.

/** Blank keeps the current value; "-" clears it (no domain: workers.dev). */
export function resolveAnswer(answer, fallback) {
  const typed = answer.trim();
  if (typed === '-') return '';
  return typed || fallback;
}

/** "https://Send.Example.com/, b.example.com" → ["send.example.com", "b.example.com"] */
export const hosts = (text) =>
  text
    .split(/[\s,]+/)
    .map((host) =>
      host
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, ''),
    )
    .filter(Boolean);
