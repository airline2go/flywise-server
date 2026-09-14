// Locale metadata for route SEO. Content generation remains evidence-first.
const SUPPORTED_ROUTE_SEO_LOCALES = ['de', 'en', 'fr', 'es', 'it', 'nl', 'pl', 'tr'];

const LOCALE_META = {
  de: { lang: 'de', label: 'Deutsch' },
  en: { lang: 'en', label: 'English' },
  fr: { lang: 'fr', label: 'Français' },
  es: { lang: 'es', label: 'Español' },
  it: { lang: 'it', label: 'Italiano' },
  nl: { lang: 'nl', label: 'Nederlands' },
  pl: { lang: 'pl', label: 'Polski' },
  tr: { lang: 'tr', label: 'Türkçe' },
};

function isSupportedRouteSeoLocale(locale) {
  return SUPPORTED_ROUTE_SEO_LOCALES.includes(String(locale || '').toLowerCase());
}

function getRouteSeoLocales() {
  return [...SUPPORTED_ROUTE_SEO_LOCALES];
}

function getLocaleMeta(locale) {
  return LOCALE_META[String(locale || '').toLowerCase()] || null;
}

module.exports = {
  SUPPORTED_ROUTE_SEO_LOCALES,
  LOCALE_META,
  isSupportedRouteSeoLocale,
  getRouteSeoLocales,
  getLocaleMeta,
};
