import { strToU8 } from "fflate";

import { bytesOf, packZip, ProjectFile, ProjectFiles, textMatcher, unpackZip } from "../zip";

// A kid's site: text files edited in place, binary files (images) kept as
// bytes. Saved as one zip so it also opens in VS Code.
export type WebFile = ProjectFile;
export type WebFiles = ProjectFiles;
export type Storage = Record<string, string>;
export type WebProject = { files: WebFiles; storage: Storage };

const MIME_TYPES: Record<string, string> = {
  css: "text/css",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

export const extensionOf = (name: string) => name.toLowerCase().slice(name.lastIndexOf(".") + 1);

export const isText = textMatcher([".css", ".htm", ".html", ".js", ".json", ".md", ".svg", ".txt"]);

export const isHtml = (name: string) => /\.html?$/i.test(name);

export const STARTER_FILES: WebFiles = {
  "index.html": {
    text: `<!doctype html>
<html>
  <head>
    <title>My website</title>
    <link rel="stylesheet" href="style.css">
  </head>
  <body>
    <h1>Hello, world!</h1>
    <p>Edit index.html and style.css to make this page yours.</p>
    <script src="script.js"></script>
  </body>
</html>
`,
  },
  "script.js": { text: `console.log("Hello from script.js");\n` },
  "style.css": {
    text: `body {\n  font-family: sans-serif;\n  margin: 2rem;\n}\n`,
  },
};

// What the page saved in localStorage travels with the site, out of the
// kid's file list.
const STORAGE_ENTRY = ".codeykids/storage.json";

export { bytesOf };

export const storageBytes = (storage: Storage) => strToU8(JSON.stringify(storage)).byteLength;

export const toZip = ({ files, storage }: WebProject) =>
  new Blob(
    [packZip(files, Object.keys(storage).length > 0 ? { [STORAGE_ENTRY]: JSON.stringify(storage) } : {}) as BlobPart],
    { type: "application/zip" },
  );

export const fromZip = async (blob: Blob): Promise<WebProject> => {
  const all = unpackZip(new Uint8Array(await blob.arrayBuffer()), {
    isText: (name) => isText(name) || name === STORAGE_ENTRY,
  });
  let storage: Storage = {};

  if (all[STORAGE_ENTRY]) {
    try {
      storage = JSON.parse(all[STORAGE_ENTRY].text ?? "{}") as Storage;
    } catch {
      storage = {};
    }
    delete all[STORAGE_ENTRY];
  }

  return { files: Object.keys(all).length > 0 ? all : structuredClone(STARTER_FILES), storage };
};

// Encoded once per file object: an edit replaces only the edited file, so
// the images keep their identity from one preview build to the next.
const dataURLs = new WeakMap<WebFile, string>();

const dataURL = (name: string, file: WebFile) => {
  const cached = dataURLs.get(file);

  if (cached) return cached;

  const type = MIME_TYPES[extensionOf(name)] ?? "application/octet-stream";
  const bytes = file.bytes ?? strToU8(file.text ?? "");
  let binary = "";

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  const url = `data:${type};base64,${btoa(binary)}`;

  dataURLs.set(file, url);

  return url;
};

// JSON that is safe inside a <script>: a stored "</script>" must not end it.
const inlineJSON = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

const OFFSETS_PLACEHOLDER = "__CODEYKIDS_OFFSETS__";

// Runs first inside the preview, kept free of backslashes (a template literal
// eats them). It gives the page what a sandboxed srcdoc lacks: console output
// and errors go to the editor's pane (a line typed there runs in the page);
// localStorage and sessionStorage are stand-ins, the first kept by the editor
// with the project; links to the site's other pages, #id links, links
// elsewhere and forms are handled, since the page has no address of its own.
// Every message carries the build's epoch so a page on its way out cannot
// speak for the next one.
const preludeScript = (pages: string[], current: string, storage: Storage, epoch: number) => `<script>
(() => {
  const EPOCH = ${epoch};
  const PAGES = ${inlineJSON(pages)};
  const CURRENT = ${inlineJSON(current)};
  const OFFSETS = ${OFFSETS_PLACEHOLDER};
  const QUOTA = 5 * 1024 * 1024;
  const post = (message) => window.parent.postMessage(Object.assign({ epoch: EPOCH }, message), "*");

  const makeStorage = (seed, remember) => {
    const items = Object.assign({}, seed);
    const size = () => Object.keys(items).reduce((total, key) => total + key.length + items[key].length, 0);
    const sync = () => { if (remember) post({ data: Object.assign({}, items), type: "preview:storage" }); };
    const api = {
      getItem: (key) => (Object.prototype.hasOwnProperty.call(items, String(key)) ? items[String(key)] : null),
      setItem: (key, value) => {
        const k = String(key), v = String(value);
        if (size() - (items[k] ? k.length + items[k].length : 0) + k.length + v.length > QUOTA) {
          throw new DOMException("Saved data is full (5 MB). Remove something first.", "QuotaExceededError");
        }
        items[k] = v; sync();
      },
      removeItem: (key) => { delete items[String(key)]; sync(); },
      clear: () => { for (const key of Object.keys(items)) delete items[key]; sync(); },
      key: (index) => Object.keys(items)[index] ?? null,
    };
    return new Proxy(api, {
      get: (target, prop) => (prop === "length" ? Object.keys(items).length : prop in target ? target[prop] : api.getItem(prop) ?? undefined),
      set: (target, prop, value) => { api.setItem(prop, value); return true; },
      deleteProperty: (target, prop) => { api.removeItem(prop); return true; },
    });
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: makeStorage(${inlineJSON(storage)}, true) });
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: makeStorage({}, false) });

  const show = (value) => {
    if (value === undefined) return "undefined";
    if (value instanceof Error) return value.name + ": " + value.message;
    if (typeof value === "string") return value;
    if (typeof value === "function") return value.toString();
    try { const text = JSON.stringify(value, null, 1); return text === undefined ? String(value) : text; } catch (e) { return String(value); }
  };
  const send = (level, args) => post({ level, text: args.map(show).join(" "), type: "preview:console" });
  const native = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    native[level] = console[level].bind(console);
    console[level] = (...args) => { native[level](...args); send(level, args); };
  }
  window.addEventListener("error", (e) => {
    const file = e.filename && !e.filename.startsWith("about:") ? e.filename : "";
    const line = e.lineno ? e.lineno - (OFFSETS[file] || 0) : 0;
    send("error", [e.message + " (" + (file || "this page") + (line > 0 ? ", line " + line : "") + ")"]);
  });
  window.addEventListener("unhandledrejection", (e) => send("error", ["Uncaught (in promise) " + show(e.reason)]));
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !e.data || e.data.type !== "preview:eval") return;
    try { send("result", [(0, eval)(e.data.code)]); } catch (error) { send("error", [error]); }
  });

  const go = (page) => post({ page, type: "preview:navigate" });
  const pageOf = (href) => {
    let name = href.split("#")[0].split("?")[0];
    if (name.startsWith("./")) name = name.slice(2);
    return PAGES.includes(name) ? name : null;
  };
  document.addEventListener("click", (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || e.defaultPrevented) return;
    const href = a.getAttribute("href") || "";
    if (href.startsWith("#")) {
      e.preventDefault();
      const id = decodeURIComponent(href.slice(1));
      const el = id ? document.getElementById(id) : null;
      if (el) el.scrollIntoView(); else if (!id) window.scrollTo(0, 0);
      return;
    }
    // The site's own files (already data: URLs) and downloads are the
    // browser's to handle.
    if (a.hasAttribute("download") || href.startsWith("data:") || href.startsWith("blob:")) return;
    const page = pageOf(href);
    if (page) { e.preventDefault(); go(page); return; }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
      e.preventDefault();
      window.open(a.href, "_blank");
    }
  });
  const submitTo = (form) => {
    const action = (form.getAttribute("action") || "").split("#")[0].split("?")[0];
    go(pageOf(action) || CURRENT);
  };
  document.addEventListener("submit", (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    submitTo(e.target);
  });
  // form.submit() fires no event, and a new tab must not keep a handle on
  // this page.
  HTMLFormElement.prototype.submit = function () { submitTo(this); };
  const nativeOpen = window.open.bind(window);
  window.open = (url, target, features) => nativeOpen(url, target || "_blank", features ? features + ",noopener" : "noopener");
})();
</script>`;

// One page of the site with everything it references inlined, so the sandboxed
// preview needs no server: stylesheets and scripts become inline tags and
// images become data URLs. Links to the site's other pages stay as they are
// and are handled by the prelude.
export const buildPreview = (files: WebFiles, page: string, storage: Storage = {}, epoch = 0) => {
  let html = files[page]?.text ?? "";

  html = html.replace(
    /<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi,
    (tag, href: string) =>
      files[href]?.text !== undefined && /rel=["']stylesheet["']/i.test(tag) ? `<style>${files[href].text}</style>` : tag,
  );
  html = html.replace(
    /<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi,
    // The sourceURL comment makes an error name the kid's file; the offset of
    // the tag, worked out below, makes it name the kid's line.
    (tag, before: string, src: string, after: string) =>
      files[src]?.text !== undefined
        ? `<script${before}${after} data-file="${src}">${files[src].text}\n//# sourceURL=${src}</script>`
        : tag,
  );
  html = html.replace(/\b(src|href)=["']([^"':]+)["']/gi, (attribute, key: string, path: string) => {
    const file = files[path];

    if (!file) return attribute;
    if (isHtml(path) && key === "href") return attribute;
    if (file.bytes || key === "src") return `${key}="${dataURL(path, file)}"`;

    return attribute;
  });

  const prelude = preludeScript(Object.keys(files).filter(isHtml), page, storage, epoch);

  // Before anything of the page runs, so its first console.log is caught,
  // and after the doctype and html tags, so the page keeps standards mode.
  const head = /<head(\s[^>]*)?>/i.exec(html) ?? /<html(\s[^>]*)?>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html);

  html = head ? `${html.slice(0, head.index + head[0].length)}${prelude}${html.slice(head.index + head[0].length)}` : `${prelude}${html}`;

  // How many lines each inlined script starts after, for the error listener.
  const offsets: Record<string, number> = {};

  for (const match of html.matchAll(/<script\b[^>]*\bdata-file="([^"]+)"[^>]*>/gi)) {
    offsets[match[1]] = html.slice(0, match.index).split("\n").length - 1;
  }

  return html.replace(OFFSETS_PLACEHOLDER, inlineJSON(offsets));
};
