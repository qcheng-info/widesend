import type { About } from './site';

export type AboutLine = { text: string; values?: Record<string, number>; link?: string };

/** The "This site" sentences in How it works, as English source text to translate. */
export function aboutLines(about: About): AboutLine[] {
  const lines: AboutLine[] = [];
  if (about.activity === false)
    lines.push({ text: 'This site keeps no record of your transfers.' });
  if (about.activity === true)
    lines.push({
      text: about.fileNames
        ? 'This site keeps a {days}-day record of transfers and rooms for its operator: IP addresses and countries, transfer codes, display names in rooms, file names, types, sizes and fingerprints, and how many messages were sent — never file or message contents.'
        : 'This site keeps a {days}-day record of transfers and rooms for its operator: IP addresses and countries, transfer codes, display names in rooms, file types, sizes and fingerprints, and how many messages were sent — never file or message contents.',
      values: { days: about.retentionDays },
    });
  lines.push({
    text: 'Files go straight between devices when they can. Otherwise they pass through this site’s relay encrypted, and are never stored. If its daily relay allowance runs out, new relayed transfers wait for a direct connection or until 00:00 UTC.',
  });
  if (about.publicInstance)
    lines.push({
      text: 'This is a free public instance for trying WideSend. If you send a lot, please run your own.',
    });
  lines.push({ text: 'WideSend is open-source software under the Apache-2.0 license.' });
  if (about.source) lines.push({ text: 'Source code', link: about.source });
  return lines;
}
