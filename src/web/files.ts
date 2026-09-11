import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

// A kid's site: text files edited in place, binary files (images) kept as
// bytes. Saved as one zip so it also opens in VS Code.
export type WebFile = { bytes?: Uint8Array; text?: string };
export type WebFiles = Record<string, WebFile>;

const TEXT_EXTENSIONS = [".css", ".htm", ".html", ".js", ".json", ".md", ".svg", ".txt"];
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

export const extensionOf = (name: string) =>
  name.toLowerCase().slice(name.lastIndexOf(".") + 1);

export const isText = (name: string) =>
  TEXT_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension));

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

export const toZip = (files: WebFiles) => {
  const entries: Record<string, Uint8Array> = {};

  for (const [name, file] of Object.entries(files)) {
    entries[name] = file.bytes ?? strToU8(file.text ?? "");
  }

  return new Blob([zipSync(entries, { level: 6 })], { type: "application/zip" });
};

export const fromZip = async (blob: Blob): Promise<WebFiles> => {
  const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const files: WebFiles = {};

  for (const [path, bytes] of Object.entries(entries)) {
    // Folders and macOS resource forks are not files of the site.
    if (path.endsWith("/") || path.startsWith("__MACOSX/")) continue;

    // A zip made elsewhere may wrap the site in one top folder.
    const name = path.replace(/^[^/]+\/(?=[^/]+$)/, "");

    files[name] = isText(name) ? { text: strFromU8(bytes) } : { bytes };
  }

  return Object.keys(files).length > 0 ? files : structuredClone(STARTER_FILES);
};

export const bytesOf = (files: WebFiles) =>
  Object.values(files).reduce(
    (total, file) => total + (file.bytes?.byteLength ?? (file.text?.length ?? 0)),
    0,
  );

const dataURL = (name: string, file: WebFile) => {
  const type = MIME_TYPES[extensionOf(name)] ?? "application/octet-stream";
  const bytes = file.bytes ?? strToU8(file.text ?? "");
  let binary = "";

  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));

  return `data:${type};base64,${btoa(binary)}`;
};

// Runs first inside the preview (kept free of backslashes: a template literal
// eats them): console output, errors and unhandled rejections go to the
// editor's console pane, and a line typed there is run in the page.
const consoleScript = `<script>
(() => {
  const post = (message) => window.parent.postMessage(message, "*");
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
    const where = e.filename && !e.filename.startsWith("about:") ? e.filename : "this page";
    send("error", [e.message + " (" + where + (e.lineno ? ", line " + e.lineno : "") + ")"]);
  });
  window.addEventListener("unhandledrejection", (e) => send("error", ["Uncaught (in promise) " + show(e.reason)]));
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !e.data || e.data.type !== "preview:eval") return;
    try { send("result", [(0, eval)(e.data.code)]); } catch (error) { send("error", [error]); }
  });
})();
</script>`;

// Runs inside the preview (kept free of backslashes: a template literal eats
// them): a click on a link to another page of the site
// asks the editor to show that page (a sandboxed page cannot load a blob of
// it), `#id` links scroll, links elsewhere open a new tab, and a form the page
// did not handle itself shows its page again instead of leaving the preview.
const previewScript = (pages: string[], current: string) => `<script>
(() => {
  const PAGES = ${JSON.stringify(pages)};
  const CURRENT = ${JSON.stringify(current)};
  const go = (page) => window.parent.postMessage({ page, type: "preview:navigate" }, "*");
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
    const page = pageOf(href);
    if (page) { e.preventDefault(); go(page); return; }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
      e.preventDefault();
      window.open(a.href, "_blank", "noopener");
    }
  });
  document.addEventListener("submit", (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    const action = (e.target.getAttribute("action") || "").split("#")[0].split("?")[0];
    go(pageOf(action) || CURRENT);
  });
})();
</script>`;

// One page of the site with everything it references inlined, so the sandboxed
// preview needs no server: stylesheets and scripts become inline tags and
// images become data URLs. Links to the site's other pages stay as they are
// and are handled by the preview script.
export const buildPreview = (files: WebFiles, page: string) => {
  let html = files[page]?.text ?? "";

  html = html.replace(
    /<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi,
    (tag, href: string) =>
      files[href]?.text !== undefined && /rel=["']stylesheet["']/i.test(tag)
        ? `<style>${files[href].text}</style>`
        : tag,
  );
  html = html.replace(
    /<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi,
    // The sourceURL comment makes an error name the kid's file and its line.
    (tag, before: string, src: string, after: string) =>
      files[src]?.text !== undefined
        ? `<script${before}${after}>${files[src].text}\n//# sourceURL=${src}</script>`
        : tag,
  );
  html = html.replace(
    /\b(src|href)=["']([^"':]+)["']/gi,
    (attribute, key: string, path: string) => {
      const file = files[path];

      if (!file || isHtml(path)) return attribute;
      if (file.bytes || key === "src") return `${key}="${dataURL(path, file)}"`;

      return attribute;
    },
  );

  const script = previewScript(Object.keys(files).filter(isHtml), page);

  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${script}</body>`) : `${html}${script}`;

  // Before anything of the page runs, so its first console.log is caught.
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (tag) => `${tag}${consoleScript}`)
    : `${consoleScript}${html}`;
};
