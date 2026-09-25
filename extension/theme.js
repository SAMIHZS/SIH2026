/* Shared light/dark theme preference for extension UI surfaces. */
(function() {
  'use strict';

  const STORAGE_KEY = 'sihTheme';
  const DEFAULT_THEME = 'light';

  function applyTheme(theme) {
    const nextTheme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.classList.toggle('theme-dark', nextTheme === 'dark');
    document.documentElement.classList.toggle('theme-light', nextTheme === 'light');
    return nextTheme;
  }

  function getStoredTheme(callback) {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      callback(applyTheme(DEFAULT_THEME));
      return;
    }
    chrome.storage.local.get([STORAGE_KEY], result => callback(applyTheme(result[STORAGE_KEY] || DEFAULT_THEME)));
  }

  function setTheme(theme) {
    const nextTheme = applyTheme(theme);
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ [STORAGE_KEY]: nextTheme });
    }
    return nextTheme;
  }

  function watchTheme() {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
    chrome.storage.onChanged.addListener(changes => {
      if (changes[STORAGE_KEY]) applyTheme(changes[STORAGE_KEY].newValue);
    });
  }

  window.SIH_Theme = { STORAGE_KEY, DEFAULT_THEME, applyTheme, getStoredTheme, setTheme, watchTheme };
  getStoredTheme(() => watchTheme());
})();
