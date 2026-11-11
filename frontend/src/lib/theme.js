// Colour scheme: "light", "dark" or "system" (follow the device). Saved per browser.
import { useSyncExternalStore } from 'react';

const KEY = 'edusphere.theme';
const subscribers = new Set();
const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function read() {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}
let preference = read();

const isDark = () => preference === 'dark' || (preference === 'system' && Boolean(media?.matches));

function apply() {
  const dark = isDark();
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#151826' : '#4f46e5');
  for (const fn of subscribers) fn();
}
media?.addEventListener?.('change', () => preference === 'system' && apply());

export function setTheme(next) {
  preference = next;
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    /* private mode: the choice lasts for this visit only */
  }
  apply();
}

const subscribe = (fn) => {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
};

/** { preference: 'light'|'dark'|'system', dark: boolean, setTheme } */
export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, () => `${preference}:${isDark()}`);
  const [pref, dark] = snapshot.split(':');
  return { preference: pref, dark: dark === 'true', setTheme };
}
