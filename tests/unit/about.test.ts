import { describe, expect, it } from 'vitest';
import { aboutLines } from '../../src/about';
import { translations } from '../../src/locales';
import type { About } from '../../src/site';

const site = (about: Partial<About> = {}): About => ({
  activity: false,
  fileNames: true,
  retentionDays: 90,
  publicInstance: false,
  ...about,
});
const texts = (about: About) => aboutLines(about).map((line) => line.text);

describe('This site', () => {
  it('says a site without an activity record keeps none', () => {
    expect(texts(site())[0]).toBe('This site keeps no record of your transfers.');
  });
  it('lists what a site with a record keeps, and for how long', () => {
    const [first] = aboutLines(site({ activity: true }));
    // Everything the activity record keeps (docs/admin.md), and what it never does.
    for (const kept of [
      'IP addresses and countries',
      'transfer codes',
      'display names in rooms',
      'file names, types, sizes and fingerprints',
      'how many messages were sent',
      'never file or message contents',
    ])
      expect(first.text).toContain(kept);
    expect(first.values).toEqual({ days: 90 });
    const unnamed = texts(site({ activity: true, fileNames: false }))[0];
    expect(unnamed).toContain('file types, sizes and fingerprints');
    expect(unnamed).not.toContain('file names');
  });
  it('makes no claim about records when the server did not say', () => {
    expect(texts(site({ activity: undefined })).join(' ')).not.toMatch(/record/);
  });
  it('always explains the relay and the license', () => {
    for (const about of [site(), site({ activity: true }), site({ activity: undefined })]) {
      expect(texts(about).some((t) => t.includes('relay'))).toBe(true);
      expect(texts(about)).toContain(
        'WideSend is open-source software under the Apache-2.0 license.',
      );
    }
  });
  it('mentions a public instance only on one', () => {
    const note =
      'This is a free public instance for trying WideSend. If you send a lot, please run your own.';
    expect(texts(site())).not.toContain(note);
    expect(texts(site({ publicInstance: true }))).toContain(note);
  });
  it('links to the source only when the site gives one', () => {
    expect(aboutLines(site()).some((line) => line.link)).toBe(false);
    expect(aboutLines(site({ source: 'https://example.com/widesend' })).at(-1)).toMatchObject({
      link: 'https://example.com/widesend',
    });
  });
  it('has every sentence translated', () => {
    const all = new Set<string>(['This site', 'Source code']);
    for (const activity of [true, false, undefined])
      for (const fileNames of [true, false])
        for (const publicInstance of [true, false])
          for (const line of aboutLines(
            site({ activity, fileNames, publicInstance, source: 'https://example.com' }),
          ))
            all.add(line.text);
    for (const text of all) expect(translations, text).toHaveProperty(text);
  });
});
