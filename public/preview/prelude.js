// Runs first in every page of a kid's site on the preview host (sw.js puts
// it in, after window.__CODEYKIDS__ = the run's settings, and console.js). It
// gives the editor what a browser's DevTools would: console output and errors
// go to the editor's console (console.js), and a line typed there runs in
// this page. localStorage
// and sessionStorage are stand-ins: the first is the site's own saved data,
// kept by the editor with the project (so it is per project, not shared by
// every site on this host); both carry over from page to page of a run.
// Every message carries the run's epoch, so a page on its way out cannot
// speak for the next run.
(() => {
  const config = window.__CODEYKIDS__ || {};

  delete window.__CODEYKIDS__;

  const EDITOR = config.editorOrigin;
  const EPOCH = config.epoch;
  const SESSION = String(config.session || "");
  const QUOTA = 5 * 1024 * 1024;
  const marker = `/p/${encodeURIComponent(SESSION)}/`;
  const at = location.pathname.indexOf(marker);
  // The site's root, as a URL, and this page's path in the site.
  const ROOT = location.origin + location.pathname.slice(0, at + marker.length);
  const PAGE = decodeURIComponent(location.pathname.slice(at + marker.length)) || "index.html";
  const inEditor = window.parent !== window && typeof EDITOR === "string";
  const post = (message) => {
    if (inEditor) window.parent.postMessage(Object.assign({ epoch: EPOCH }, message), EDITOR);
  };

  // This host's real sessionStorage carries the stand-ins from page to page
  // within a run; the bridge puts the editor's copy there to start each run
  // (or in the run's settings, when it is too big for sessionStorage).
  let real = null;

  try {
    real = window.sessionStorage;
  } catch (error) {
    real = null;
  }

  const KEY = `codeykids:${SESSION}:${EPOCH}:`;
  // sessionStorage lasts across runs while the editor has this project open,
  // as a browser tab's does; it is never saved, and another project loaded
  // starts without it.
  const SESSION_KEY = `codeykids:${SESSION}:session:${Number(config.project) || 0}`;

  // Only this run's copies of localStorage are kept: earlier runs' would fill
  // the 5 MB sessionStorage has.
  try {
    for (let i = real ? real.length - 1 : -1; i >= 0; i -= 1) {
      const name = real.key(i);

      if (name && name.startsWith("codeykids:") && !name.startsWith(KEY) && name !== SESSION_KEY) real.removeItem(name);
    }
  } catch (error) {
    // Blocked: nothing to tidy.
  }
  const keyOf = (name) => (name === "session" ? SESSION_KEY : KEY + name);
  const carried = (name) => {
    try {
      const text = real && real.getItem(keyOf(name));

      return text ? JSON.parse(text) : null;
    } catch (error) {
      return null;
    }
  };
  const carry = (name, items) => {
    try {
      if (real) real.setItem(keyOf(name), JSON.stringify(items));
    } catch (error) {
      // Full or blocked: the stand-in still works for this page.
    }
  };

  const makeStorage = (name, seed, onChange) => {
    const items = Object.assign({}, carried(name) || seed || {});
    const size = () => Object.keys(items).reduce((total, key) => total + key.length + items[key].length, 0);
    const changed = () => {
      carry(name, items);
      if (onChange) onChange(Object.assign({}, items));
    };
    const api = {
      getItem: (key) => (Object.prototype.hasOwnProperty.call(items, String(key)) ? items[String(key)] : null),
      setItem: (key, value) => {
        const k = String(key);
        const v = String(value);

        if (size() - (items[k] ? k.length + items[k].length : 0) + k.length + v.length > QUOTA) {
          throw new DOMException("Saved data is full (5 MB). Remove something first.", "QuotaExceededError");
        }
        items[k] = v;
        changed();
      },
      removeItem: (key) => {
        delete items[String(key)];
        changed();
      },
      clear: () => {
        for (const key of Object.keys(items)) delete items[key];
        changed();
      },
      key: (index) => Object.keys(items)[index] ?? null,
    };

    return new Proxy(api, {
      get: (target, prop) => (prop === "length" ? Object.keys(items).length : prop in target ? target[prop] : api.getItem(prop) ?? undefined),
      set: (target, prop, value) => {
        api.setItem(prop, value);
        return true;
      },
      deleteProperty: (target, prop) => {
        api.removeItem(prop);
        return true;
      },
      has: (target, prop) => prop in target || Object.prototype.hasOwnProperty.call(items, String(prop)),
      ownKeys: () => Object.keys(items),
      getOwnPropertyDescriptor: (target, prop) =>
        Object.prototype.hasOwnProperty.call(items, String(prop))
          ? { configurable: true, enumerable: true, value: items[String(prop)], writable: true }
          : undefined,
    });
  };

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: makeStorage("local", config.storage, (items) => post({ data: items, type: "preview:storage" })),
  });
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: makeStorage("session", {}, null) });

  // A file of the site is named as the kid named it; other URLs stay whole.
  const nameOf = (url) => (url && url.startsWith(ROOT) ? decodeURIComponent(url.slice(ROOT.length).split(/[?#]/)[0]) : url);

  // console.js, which the preview host serves just before this.
  const install = window.__CODEYKIDS_CONSOLE__;

  delete window.__CODEYKIDS_CONSOLE__;

  // A host that started this page before a deploy added console.js leaves
  // the page without the console until the next run, not broken.
  const devConsole = typeof install === "function" ? install({
    page: PAGE,
    place: (url, line) => {
      if (!url) return null;
      // "/js/app.js" is the site's too (sw.js serves it from the site).
      if (!url.startsWith(ROOT) && url.startsWith(`${location.origin}/`)) {
        return { file: nameOf(ROOT + url.slice(location.origin.length + 1)), line };
      }

      return { file: nameOf(url), line };
    },
    post,
  }) : { evaluate: () => {} };

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== EDITOR || !event.data) return;
    // The editor is closing: the site's files and saved data leave this
    // host, so the next kid on this computer can't read them here.
    if (event.data.type === "preview:dispose") {
      if (window.caches) void caches.delete(`codeykids-preview-${SESSION}`);
      return;
    }
    if (event.data.type === "preview:eval") devConsole.evaluate(String(event.data.code));
  });

  // Links to other websites open in a new tab: most refuse to be shown
  // inside another page. The site's own pages open here, a new tab included,
  // since a new tab has no editor to serve them. Every address on this host
  // is the site's: sw.js serves "/about.html" from it too.
  const ownURL = (href) => {
    try {
      return new URL(href, location.href).origin === location.origin;
    } catch (error) {
      return false;
    }
  };

  document.addEventListener("click", (event) => {
    const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;

    if (!link || event.defaultPrevented || link.hasAttribute("download")) return;

    const href = link.getAttribute("href") || "";

    if (href.startsWith("#") || href.startsWith("data:") || href.startsWith("blob:") || href.startsWith("javascript:")) return;
    if (ownURL(link.href)) {
      // A link into a frame of the page (<iframe name="…">) stays the
      // browser's.
      const target = link.target;

      if (target && target !== "_self" && !(target.charAt(0) !== "_" && document.getElementsByName(target).length > 0)) {
        event.preventDefault();
        location.assign(link.href);
      }
      return;
    }
    event.preventDefault();
    window.open(link.href, "_blank", "noopener");
  });

  const nativeOpen = window.open.bind(window);

  window.open = (url, target, features) => {
    if (url && ownURL(String(url))) {
      location.assign(new URL(String(url), location.href).href);
      return null;
    }
    return nativeOpen(url, target || "_blank", features ? `${features},noopener` : "noopener");
  };

  // A service worker of the site's own would take over from the one serving
  // it.
  if (window.ServiceWorkerContainer) {
    ServiceWorkerContainer.prototype.register = () =>
      Promise.reject(new DOMException("Service workers can't be used in the CodeyKids preview.", "SecurityError"));
  }

  post({ page: PAGE, type: "preview:location" });
})();
