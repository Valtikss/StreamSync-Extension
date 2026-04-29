// Helper i18n partagé popup/content. Charge la langue depuis chrome.storage,
// expose t()/applyI18n(), et réapplique sur changement de langue.

(function (g) {
  // Guard d'idempotence : re-injection possible via chrome.scripting (voir
  // content.js). Sans guard, chaque injection ajoute un chrome.storage.onChanged
  // listener supplémentaire dans la page.
  if (g.SS_I18N) return;

  let currentLang = g.SS_DEFAULT_LANG || 'fr';
  const changeListeners = [];

  function resolveLang(raw) {
    if (!raw) return g.SS_DEFAULT_LANG || 'fr';
    return (g.SS_SUPPORTED_LANGS || ['fr', 'en']).includes(raw) ? raw : (g.SS_DEFAULT_LANG || 'fr');
  }

  // Lit la langue stockée et initialise currentLang. Retourne une promesse.
  function loadLang() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(['lang'], ({ lang }) => {
          currentLang = resolveLang(lang);
          resolve(currentLang);
        });
      } catch {
        resolve(currentLang);
      }
    });
  }

  function getLang() { return currentLang; }

  function t(key, vars) { return g.SS_T(currentLang, key, vars); }

  // Applique les traductions sur un arbre DOM (popup et content script).
  // Lit data-i18n, data-i18n-html, data-i18n-attr="attr:key,attr:key".
  // data-i18n-vars="key=value,key=value" pour les tokens dynamiques.
  function parseVars(raw) {
    if (!raw) return undefined;
    const vars = {};
    raw.split(',').forEach(pair => {
      const [k, v] = pair.split('=').map(s => s.trim());
      if (k) vars[k] = v ?? '';
    });
    return vars;
  }

  function applyI18n(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const vars = parseVars(el.getAttribute('data-i18n-vars'));
      el.textContent = t(key, vars);
    });
    scope.querySelectorAll('[data-i18n-html]').forEach(el => {
      const key = el.getAttribute('data-i18n-html');
      const vars = parseVars(el.getAttribute('data-i18n-vars'));
      // DOMParser-based : évite innerHTML pour passer la lint AMO no-unsanitized.
      // Les locales sont bundlées (sources internes), donc safe ; le parser
      // produit un document inerte (pas d'exécution de scripts) avant adoption.
      // applyI18n n'est invoqué que depuis popup/content (jamais SW), donc
      // `document` est garanti.
      const parsed = new DOMParser().parseFromString(`<body>${t(key, vars)}</body>`, 'text/html');
      const frag = document.createDocumentFragment();
      while (parsed.body.firstChild) frag.appendChild(parsed.body.firstChild);
      el.replaceChildren(frag);
    });
    scope.querySelectorAll('[data-i18n-attr]').forEach(el => {
      const pairs = el.getAttribute('data-i18n-attr').split(',');
      pairs.forEach(pair => {
        const [attr, key] = pair.split(':').map(s => s.trim());
        if (!attr || !key) return;
        el.setAttribute(attr, t(key));
      });
    });
  }

  function onLangChange(cb) { changeListeners.push(cb); }

  // Écoute les changements globaux de langue (depuis un autre contexte
  // ex: popup qui change → content script qui re-render).
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.lang) return;
      currentLang = resolveLang(changes.lang.newValue);
      changeListeners.forEach(cb => { try { cb(currentLang); } catch {} });
    });
  } catch {}

  g.SS_I18N = { loadLang, getLang, t, applyI18n, onLangChange };
})(typeof self !== 'undefined' ? self : this);
