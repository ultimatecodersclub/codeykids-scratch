// What DevTools' Network and Rendering panels would do to a kid's page, run
// in the page because the browser's own DevTools look at CodeyKids, not at
// the preview. Used by the preview host's prelude and by the built page the
// editor falls back to. Sets window.__CODEYKIDS_TOOLS__, which the prelude
// calls and removes:
//   install({ network, reducedMotion }, post)
//     -> { answer(reply), set({ network, reducedMotion }) }
// network is "online", "slow" (every request waits SLOW_MS first) or
// "offline" (requests fail as they do with the wifi off); reducedMotion makes
// the page see prefers-reduced-motion: reduce, in its CSS and in matchMedia.
// Scripts and pictures already loaded keep working, as in a browser that goes
// offline after the page has loaded.
// It also gives the page CodeyKids' AI: codeykids.ai.chat(), and answers for
// Ollama at localhost:11434 (which no kid's computer here runs). The editor
// asks the AI for the page (post sends it a question, answer takes the reply
// back), so the page never holds the key to it.
window.__CODEYKIDS_TOOLS__ = (initial, post) => {
  const SLOW_MS = 2000;
  let network = "online";
  let reducedMotion = false;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A data: or blob: address is in the page already: no network needed.
  const local = (url) => /^(data|blob):/i.test(url);

  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;

  // Questions waiting for the editor's answer, by id. A page asking in a
  // loop would use up the kid's questions for the day, so only a few may wait
  // at once.
  const AI_WAITING = 3;
  const AI_TIMEOUT_MS = 60000;
  const asked = new Map();
  let lastId = 0;
  const PAGE_KEY = Math.random().toString(36).slice(2);

  const askAi = (request) =>
    new Promise((resolve, reject) => {
      if (typeof post !== "function") {
        reject(new Error("The AI works when this lesson is opened in CodeyKids."));
        return;
      }
      if (asked.size >= AI_WAITING) {
        reject(new Error("Too many questions at once: wait for an answer first."));
        return;
      }

      lastId += 1;

      // Unique to this page: a reply to a question an earlier page or run
      // asked (whose count also started at 1) is never taken for this one's.
      const id = `${PAGE_KEY}-${lastId}`;
      const timer = setTimeout(() => {
        asked.delete(id);
        reject(new Error("The AI took too long to answer. Try again."));
      }, AI_TIMEOUT_MS);

      asked.set(id, { reject, resolve, timer });
      post({ id, request, type: "preview:ai" });
    });

  const messagesOf = (list) =>
    (Array.isArray(list) ? list : []).map((item) => ({
      content: String((item && item.content) ?? ""),
      role: ["assistant", "system", "user"].includes(item && item.role) ? item.role : "user",
    }));

  // codeykids.ai.chat("a question") or codeykids.ai.chat({ messages, json,
  // maxTokens, temperature }): the answer's text.
  const chat = async (question) => {
    const options = typeof question === "string" ? { messages: [{ content: question, role: "user" }] } : question || {};
    const reply = await askAi({
      json: options.json === true,
      maxTokens: typeof options.maxTokens === "number" ? options.maxTokens : undefined,
      messages: messagesOf(options.messages),
      temperature: typeof options.temperature === "number" ? options.temperature : undefined,
    });

    return reply.content;
  };

  Object.defineProperty(window, "codeykids", {
    configurable: true,
    value: Object.freeze({ ai: Object.freeze({ chat }) }),
  });

  // Ollama's API, as the lessons call it, answered by CodeyKids' AI whatever
  // model is named. A reply comes whole: one line, so both r.json() and
  // reading Ollama's stream line by line work.
  const OLLAMA = /^http:\/\/(localhost|127\.0\.0\.1):11434(\/[^?#]*)/i;
  const ollamaJSON = (body, status) =>
    new Response(`${JSON.stringify(body)}\n`, { headers: { "Content-Type": "application/json" }, status: status || 200 });

  const ollama = async (path, init, input) => {
    const now = new Date().toISOString();

    if (path === "/api/tags" || path === "/api/ps") {
      return ollamaJSON({ models: [{ model: "llama3.2", name: "llama3.2" }] });
    }
    if (path === "/" || path === "") return new Response("Ollama is running", { status: 200 });
    if (path !== "/api/generate" && path !== "/api/chat") return ollamaJSON({ error: `${path} isn't something CodeyKids' AI does` }, 404);

    let body = {};

    try {
      const text = init && init.body !== undefined ? String(init.body) : input instanceof Request ? await input.text() : "{}";

      body = JSON.parse(text || "{}");
    } catch (error) {
      return ollamaJSON({ error: "The request's body isn't JSON." }, 400);
    }

    const options = body.options || {};
    const messages =
      path === "/api/chat"
        ? messagesOf(body.messages)
        : [...(body.system ? [{ content: String(body.system), role: "system" }] : []), { content: String(body.prompt ?? ""), role: "user" }];

    try {
      const reply = await askAi({
        json: body.format === "json" || (body.format !== null && typeof body.format === "object"),
        maxTokens: typeof options.num_predict === "number" ? options.num_predict : undefined,
        messages,
        temperature: typeof options.temperature === "number" ? options.temperature : undefined,
      });
      const model = String(body.model || "llama3.2");
      const done = { created_at: now, done: true, done_reason: "stop", model };

      return ollamaJSON(
        path === "/api/chat"
          ? { ...done, message: { content: reply.content, role: "assistant" } }
          : { ...done, response: reply.content },
      );
    } catch (error) {
      return ollamaJSON({ error: error.message }, 500);
    }
  };

  if (nativeFetch) {
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);

      if (!local(url)) {
        if (network === "slow") await wait(SLOW_MS);
        // The message Chrome gives when the wifi is off.
        if (network === "offline") throw new TypeError("Failed to fetch");
      }

      const toOllama = OLLAMA.exec(url);

      if (toOllama) return ollama(toOllama[2], init, input);

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
    // The editor's reply to a question: { id, content, blocked } or
    // { id, error }.
    answer: (reply) => {
      const waiting = reply && asked.get(reply.id);

      if (!waiting) return;
      asked.delete(reply.id);
      clearTimeout(waiting.timer);
      if (typeof reply.error === "string") waiting.reject(new Error(reply.error));
      else waiting.resolve({ blocked: reply.blocked === true, content: String(reply.content ?? "") });
    },
    set: (settings) => {
      const before = wasOffline();

      set(settings);
      if (before !== wasOffline()) window.dispatchEvent(new Event(wasOffline() ? "offline" : "online"));
    },
  };
};
