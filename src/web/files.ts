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

// One page of the site with everything it references inlined, so the sandboxed
// preview needs no server: stylesheets and scripts become inline tags, images
// become data URLs, and links to the site's other pages become blob URLs of
// those pages built the same way.
export const buildPreview = (files: WebFiles, page: string) => {
  const pageURLs = new Map<string, string>();

  const build = (name: string, depth: number): string => {
    let html = files[name]?.text ?? "";

    html = html.replace(
      /<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi,
      (tag, href: string) =>
        files[href]?.text !== undefined && /rel=["']stylesheet["']/i.test(tag)
          ? `<style>${files[href].text}</style>`
          : tag,
    );
    html = html.replace(
      /<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi,
      (tag, before: string, src: string, after: string) =>
        files[src]?.text !== undefined
          ? `<script${before}${after}>${files[src].text}</script>`
          : tag,
    );
    html = html.replace(
      /\b(src|href)=["']([^"':]+)["']/gi,
      (attribute, key: string, path: string) => {
        const file = files[path];

        if (!file) return attribute;
        if (isHtml(path) && key === "href") {
          if (depth < 4 && !pageURLs.has(path)) {
            pageURLs.set(path, "");
            pageURLs.set(
              path,
              URL.createObjectURL(
                new Blob([build(path, depth + 1)], { type: "text/html" }),
              ),
            );
          }

          return `${key}="${pageURLs.get(path) ?? attribute}"`;
        }
        if (file.bytes || key === "src") return `${key}="${dataURL(path, file)}"`;

        return attribute;
      },
    );

    return html;
  };

  return build(page, 0);
};
