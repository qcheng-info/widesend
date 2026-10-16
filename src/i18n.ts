import { useEffect, useState } from 'react';
import { translations } from './locales';

export const languages = [
  { code: 'en', name: 'English' },
  { code: 'zh', name: '简体中文' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Español' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
] as const;
export type Language = (typeof languages)[number]['code'];
const preferenceKey = 'widesend-language';
export function detectLanguage(preferences: readonly string[]): Language {
  for (const preference of preferences) {
    const base = preference.toLowerCase().split(/[-_]/)[0];
    if (languages.some((language) => language.code === base)) return base as Language;
  }
  return 'en';
}
export function translate(
  language: Language,
  text: string,
  values: Record<string, string | number> = {},
): string {
  const index = languages.findIndex((item) => item.code === language) - 1;
  const row = translations[text as keyof typeof translations];
  const template = index >= 0 && row ? row[index] : text;
  return template.replace(/\{(\w+)\}/g, (match, key) => String(values[key] ?? match));
}
export function useLanguage() {
  const [language, setLanguage] = useState<Language>(() => {
    try {
      const saved = localStorage.getItem(preferenceKey);
      if (languages.some((item) => item.code === saved)) return saved as Language;
    } catch {
      /* Language selection also works when browser storage is blocked. */
    }
    return detectLanguage(navigator.languages?.length ? navigator.languages : [navigator.language]);
  });
  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-Hans' : language;
    document.title = `WideSend — ${translate(language, 'Send files anywhere.')}`;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute(
        'content',
        translate(language, 'Choose files, share a code, and keep both devices open.'),
      );
    try {
      localStorage.setItem(preferenceKey, language);
    } catch {
      /* Optional preference. */
    }
  }, [language]);
  return {
    language,
    setLanguage,
    t: (text: string, values?: Record<string, string | number>) =>
      translate(language, text, values),
  };
}
