// What DevTools' Network and Rendering panels would do to a kid's page, run
// in the page because the browser's own DevTools look at CodeyKids, not at
// the preview. Used by the preview host's prelude and by the built page the
// editor falls back to. Sets window.__CODEYKIDS_TOOLS__, which the prelude
// calls and removes:
//   install({ network, reducedMotion }) -> { set({ network, reducedMotion }) }
// network is "online", "slow" (every request waits SLOW_MS first) or
// "offline" (requests fail as they do with the wifi off); reducedMotion makes
// the page see prefers-reduced-motion: reduce, in its CSS and in matchMedia.
// Scripts and pictures already loaded keep working, as in a browser that goes
// offline after the page has loaded.
window.__CODEYKIDS_TOOLS__ = (initial) => {
  const SLOW_MS = 2000;
  let network = "online";
  let reducedMotion = false;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A data: or blob: address is in the page already: no network needed.
  const local = (url) => /^(data|blob):/i.test(url);

  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;

  if (nativeFetch) {
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);

      if (!local(url)) {
        if (network === "slow") await wait(SLOW_MS);
        // The message Chrome gives when the wifi is off.
        if (network === "offline") throw new TypeError("Failed to fetch");
      }

      return nativeFetch(input, init);
    };
  }

  if (window.XMLHttpRequest) {
    const proto = XMLHttpRequest.prototype;
    const nativeOpen = proto.open;
    const nativeSend = proto.send;
    const urls = new WeakMap();

    proto.open = function (method, url, async, ...rest) {
      urls.set(this, { async: async !== false, url: String(url) });
      return nativeOpen.call(this, method, url, async === undefined ? true : async, ...rest);
    };
    proto.send = function (...args) {
      const request = urls.get(this) || { async: true, url: "" };

      if (local(request.url) || !request.async || network === "online") return nativeSend.apply(this, args);
      if (network === "offline") {
        // As a failed request: an error, then loadend, and status 0.
        setTimeout(() => {
          this.dispatchEvent(new ProgressEvent("error"));
          this.dispatchEvent(new ProgressEvent("loadend"));
        }, 0);
        return undefined;
      }
      setTimeout(() => {
        if (network === "offline") {
          this.dispatchEvent(new ProgressEvent("error"));
          this.dispatchEvent(new ProgressEvent("loadend"));
        } else {
          nativeSend.apply(this, args);
        }
      }, SLOW_MS);
      return undefined;
    };
  }

  // prefers-reduced-motion. matchMedia answers for it from here; the page's
  // own stylesheets have the condition swapped for one that is always true
  // (or never), and put back when the setting is off.
  const MOTION = /\(\s*prefers-reduced-motion\s*(?::\s*(reduce|no-preference)\s*)?\)/gi;
  const ALWAYS = "(min-width: 0px)";
  const NEVER = "(max-width: -1px)";
  const originals = new WeakMap();
  const nativeMatchMedia = window.matchMedia ? window.matchMedia.bind(window) : null;
  const lists = new Set();

  const forced = (query) =>
    String(query).replace(MOTION, (match, value) => ((value || "reduce").toLowerCase() === "reduce" ? ALWAYS : NEVER));

  const fakeList = (query) => {
    const listeners = new Set();
    const list = {
      addEventListener: (type, listener) => type === "change" && listeners.add(listener),
      addListener: (listener) => listeners.add(listener),
      dispatchEvent: () => true,
      get matches() {
        return nativeMatchMedia(reducedMotion ? forced(query) : query).matches;
      },
      media: String(query),
      onchange: null,
      removeEventListener: (type, listener) => listeners.delete(listener),
      removeListener: (listener) => listeners.delete(listener),
    };

    list.changed = () => {
      const event = { matches: list.matches, media: list.media };

      for (const listener of listeners) listener.call(list, event);
      if (typeof list.onchange === "function") list.onchange.call(list, event);
    };

    return list;
  };

  if (nativeMatchMedia) {
    window.matchMedia = (query) => {
      if (!/prefers-reduced-motion/i.test(String(query))) return nativeMatchMedia(query);

      const list = fakeList(query);

      lists.add(list);
      return list;
    };
  }

  const rewriteRules = (rules) => {
    for (const rule of Array.from(rules)) {
      if (rule.media && rule.cssRules && typeof rule.media.mediaText === "string") {
        const original = originals.has(rule) ? originals.get(rule) : rule.media.mediaText;

        if (/prefers-reduced-motion/i.test(original)) {
          originals.set(rule, original);
          rule.media.mediaText = reducedMotion ? forced(original) : original;
        }
      }
      if (rule.cssRules) rewriteRules(rule.cssRules);
    }
  };
  const rewriteSheets = () => {
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        rewriteRules(sheet.cssRules);
      } catch (error) {
        // Another website's stylesheet can't be read; it keeps its own rules.
      }
    }
  };

  document.addEventListener("DOMContentLoaded", rewriteSheets);
  window.addEventListener("load", rewriteSheets);
  // Stylesheets that arrive later (a <link> added by a script, say).
  if (window.MutationObserver) {
    const isSheet = (node) => node.localName === "style" || node.localName === "link";

    // Only for a stylesheet added: a game that changes the page every frame
    // must not pay for this.
    new MutationObserver((records) => {
      if (reducedMotion && records.some((record) => Array.from(record.addedNodes).some(isSheet))) rewriteSheets();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  document.addEventListener(
    "load",
    (event) => {
      if (reducedMotion && event.target && event.target.localName === "link") rewriteSheets();
    },
    true,
  );

  const set = (settings) => {
    const next = settings || {};
    const motion = next.reducedMotion === true;

    network = next.network === "slow" || next.network === "offline" ? next.network : "online";
    if (motion !== reducedMotion) {
      reducedMotion = motion;
      rewriteSheets();
      for (const list of lists) list.changed();
    }
    // Like a browser's own online flag and events.
    try {
      Object.defineProperty(navigator, "onLine", { configurable: true, get: () => network !== "offline" });
    } catch (error) {
      // Left as the browser has it.
    }
  };

  const wasOffline = () => network === "offline";

  set(initial);

  return {
    set: (settings) => {
      const before = wasOffline();

      set(settings);
      if (before !== wasOffline()) window.dispatchEvent(new Event(wasOffline() ? "offline" : "online"));
    },
  };
};
