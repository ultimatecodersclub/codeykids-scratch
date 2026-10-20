import { strToU8 } from "fflate";

import consoleScript from "../../public/preview/console.js?raw";
import toolsScript from "../../public/preview/tools.js?raw";
import { bytesOf, packZip, ProjectFile, ProjectFiles, textMatcher, unpackZip } from "../zip";

// A kid's site: text files edited in place, binary files (images) kept as
// bytes. Saved as one zip so it also opens in VS Code.
export type WebFile = ProjectFile;
export type WebFiles = ProjectFiles;
export type Storage = Record<string, string>;
export type WebProject = { files: WebFiles; storage: Storage };
// The preview's stand-ins for DevTools' network and motion settings
// (public/preview/tools.js).
export type PreviewTools = { network: "offline" | "online" | "slow"; reducedMotion: boolean };

const MIME_TYPES: Record<string, string> = {
  avif: "image/avif",
  css: "text/css",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  png: "image/png",
  svg: "image/svg+xml",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
};

export const extensionOf = (name: string) => name.toLowerCase().slice(name.lastIndexOf(".") + 1);

export const isText = textMatcher([".css", ".htm", ".html", ".js", ".json", ".md", ".svg", ".txt"]);

export const isHtml = (name: string) => /\.html?$/i.test(name);

// A name a file of the site can have: a path inside the site (folders
// included) that a web address spells the same way, so no "." or ".." parts
// and none of ? # % \. The editor's own folders are not the kid's.
export const isSitePath = (name: string) =>
  name !== "" &&
  !name.startsWith("/") &&
  !/[?#%\\]/.test(name) &&
  !name.split("/").some((part) => part === "" || part === "." || part === "..") &&
  !name.startsWith("__codeykids__/") &&
  !name.startsWith(".codeykids/");

// "images/cat.png" is in "images"; "index.html" is at the top ("").
export const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

export const inFolder = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

// A picture's type, for showing it in the editor; undefined for anything else.
export const imageType = (name: string) => {
  const type = MIME_TYPES[extensionOf(name)];

  return type?.startsWith("image/") ? type : undefined;
};

// A file from the kid's computer as the site keeps it.
export const asSiteFile = (name: string, bytes: Uint8Array): WebFile =>
  isText(name) ? { text: new TextDecoder().decode(bytes) } : { bytes };

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
  // A file whose name no web address could reach would only break the
  // preview, so it stays out.
  const all = unpackZip(new Uint8Array(await blob.arrayBuffer()), {
    isText: (name) => isText(name) || name === STORAGE_ENTRY,
    keep: (name) => isSitePath(name) || name === STORAGE_ENTRY,
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
const PAGE_LINES_PLACEHOLDER = "__CODEYKIDS_PAGE_LINES__";

// A script from another website only says what went wrong (not just "Script
// error.") when it is fetched with CORS. These CDNs allow that for every
// file, so asking can't stop a script loading. The preview host does the
// same (public/preview/sw.js).
const CORS_CDNS = /^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|code\.jquery\.com|ajax\.googleapis\.com|esm\.sh|cdn\.skypack\.dev)\//i;

// Runs first inside the preview, kept free of backslashes (a template literal
// eats them). It gives the page what a sandboxed srcdoc lacks: console output
// and errors go to the editor's pane through console.js, as on the preview
// host (a line typed there runs in the page);
// localStorage and sessionStorage are stand-ins, the first kept by the editor
// with the project; links to the site's other pages, #id links, links
// elsewhere and forms are handled, since the page has no address of its own.
// Every message carries the build's epoch so a page on its way out cannot
// speak for the next one.
const preludeScript = (pages: string[], current: string, storage: Storage, epoch: number, tools: PreviewTools) => `<script>${consoleScript}
//# sourceURL=__codeykids__/console.js
</script><script>${toolsScript}
//# sourceURL=__codeykids__/tools.js
</script><script>
(() => {
  const EPOCH = ${epoch};
  const PAGES = ${inlineJSON(pages)};
  const CURRENT = ${inlineJSON(current)};
  const OFFSETS = ${OFFSETS_PLACEHOLDER};
  const PAGE_LINES = ${PAGE_LINES_PLACEHOLDER};
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

  // console.js, in the script before this one.
  const install = window.__CODEYKIDS_CONSOLE__;
  delete window.__CODEYKIDS_CONSOLE__;
  // An error's line in the built page, or in a file inlined into it, as the
  // line in the kid's file.
  const place = (url, line, fromStack) => {
    if (!url) return null;
    if (url.startsWith("about:")) {
      let mapped = line;
      for (const [built, original] of PAGE_LINES) if (built <= line) mapped = original + line - built;
      return { file: CURRENT, line: mapped };
    }
    if (Object.prototype.hasOwnProperty.call(OFFSETS, url)) return { file: url, line: fromStack ? line : line - OFFSETS[url] };
    return { file: url, line };
  };
  const devConsole = install({ page: CURRENT, place, post });
  // tools.js, in the script before the console's.
  const tools = window.__CODEYKIDS_TOOLS__(${inlineJSON(tools)}, post);
  delete window.__CODEYKIDS_TOOLS__;
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !e.data) return;
    if (e.data.type === "preview:eval") devConsole.evaluate(String(e.data.code));
    if (e.data.type === "preview:tools") tools.set(e.data.tools);
    if (e.data.type === "preview:aiReply") tools.answer(e.data);
  });
  // So the editor sends any setting changed while this page was built.
  post({ page: CURRENT, type: "preview:location" });

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
export const buildPreview = (
  files: WebFiles,
  page: string,
  storage: Storage = {},
  epoch = 0,
  tools: PreviewTools = { network: "online", reducedMotion: false },
) => {
  let html = files[page]?.text ?? "";

  // The page's own scripts are marked with the line they start on, before
  // anything inlined above them moves them down.
  html = html.replace(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/gi, (tag, offset: number) =>
    `${tag.slice(0, -1)} data-line="${html.slice(0, offset).split("\n").length}">`,
  );
  html = html.replace(/<script\b[^>]*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);

    return src && CORS_CDNS.test(src[1]) && !/\bcrossorigin\b/i.test(tag) ? `${tag.slice(0, -1)} crossorigin="anonymous">` : tag;
  });

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

  const prelude = preludeScript(Object.keys(files).filter(isHtml), page, storage, epoch, tools);

  // Before anything of the page runs, so its first console.log is caught,
  // and after the doctype and html tags, so the page keeps standards mode.
  const head = /<head(\s[^>]*)?>/i.exec(html) ?? /<html(\s[^>]*)?>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html);

  html = head ? `${html.slice(0, head.index + head[0].length)}${prelude}${html.slice(head.index + head[0].length)}` : `${prelude}${html}`;

  // How many lines each inlined script starts after, for the error listener.
  const offsets: Record<string, number> = {};

  for (const match of html.matchAll(/<script\b[^>]*\bdata-file="([^"]+)"[^>]*>/gi)) {
    offsets[match[1]] = html.slice(0, match.index).split("\n").length - 1;
  }

  // Where each of the page's own scripts is now, and was in the kid's file.
  const pageLines: [number, number][] = [];

  for (const match of html.matchAll(/<script\b[^>]*\bdata-line="(\d+)"[^>]*>/gi)) {
    pageLines.push([html.slice(0, match.index).split("\n").length, Number(match[1])]);
  }

  return html.replace(OFFSETS_PLACEHOLDER, inlineJSON(offsets)).replace(PAGE_LINES_PLACEHOLDER, inlineJSON(pageLines));
};
