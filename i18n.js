const SUPPORTED = ['en', 'vi', 'ja', 'ko', 'ar', 'ru', 'fr', 'zh-Hans', 'fa', 'uk', 'de'];
const RTL = new Set(['ar', 'fa']);
let messages = {};
let english = {};

export function applyDirection(documentObject, locale) {
  documentObject.documentElement.lang = locale;
  documentObject.documentElement.dir = RTL.has(locale) ? 'rtl' : 'ltr';
}

export function normalizeLocale(value) {
  const locale = String(value ?? '').replace('_', '-');
  if (SUPPORTED.includes(locale)) return locale;
  const lower = locale.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-Hans';
  return SUPPORTED.find((item) => lower.startsWith(item.toLowerCase().split('-')[0])) ?? 'en';
}

async function getMessages(locale) {
  const response = await fetch(new URL(`i18n/${locale}.json`, import.meta.url));
  if (!response.ok) throw new Error(`Could not load locale ${locale}.`);
  return response.json();
}

export function t(key) {
  return messages[key] ?? english[key] ?? key;
}

export function translateDocument(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
    element.placeholder = t(element.dataset.i18nPlaceholder);
  });
  root.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
    element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
  });
}

export async function setLocale(requested, root = document) {
  const locale = normalizeLocale(requested);
  if (!Object.keys(english).length) english = await getMessages('en');
  messages = locale === 'en' ? english : await getMessages(locale);
  applyDirection(root, locale);
  translateDocument(root);
  root.getElementById('locale-select')?.setAttribute('value', locale);
  if (root.getElementById('locale-select')) root.getElementById('locale-select').value = locale;
  localStorage.setItem('anonymous-chat:locale', locale);
  return locale;
}

export async function initI18n(root = document) {
  const selected = localStorage.getItem('anonymous-chat:locale') || navigator.language || 'en';
  try {
    return await setLocale(selected, root);
  } catch {
    return setLocale('en', root);
  }
}
