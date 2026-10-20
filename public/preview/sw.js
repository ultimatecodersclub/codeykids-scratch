// Serves a kid's site from the web editor at real addresses on the preview
// host, a different origin from CodeyKids and the editor: index.html,
// images/cat.png, ../tokens.css, fetch("data.json") and module imports all
// work as on a web server. The bridge page (index.html here) writes the
// project into a cache for its session, `p/<session>/...`, and this answers
// from it. Every page gets the prelude first (prelude.js), which talks to the
// editor. Nothing here keeps state between requests: a restarted worker
// serves the same.

// The host's own files sit beside this worker ("/" on the preview host,
// "/preview/" in development); sites are served from the origin's root, at
// /p/<session>/, so "/about.html" in a site means the site's own.
const HOST = self.location.pathname.slice(0, self.location.pathname.lastIndexOf("/") + 1);
const SESSIONS = "/p/";
const CACHE_PREFIX = "codeykids-preview-";
const META = "__codeykids__/meta.json";
const PRELUDE = "__codeykids__/prelude.js";

const TYPES = {
  avif: "image/avif",
  bin: "application/octet-stream",
  css: "text/css; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  gif: "image/gif",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  m4a: "audio/mp4",
  md: "text/markdown; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  otf: "font/otf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
};

const typeOf = (path) => TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// A path as the kid wrote it. A stray "%" (a file called "100%.html") is
// left as it is rather than throwing.
const decode = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

// The session and path a URL on this host stands for, or null for the
// host's own files (the bridge, this worker, the prelude).
const locate = (url) => {
  if (!url.pathname.startsWith(SESSIONS)) return null;

  const rest = decode(url.pathname.slice(SESSIONS.length));
  const slash = rest.indexOf("/");

  if (slash <= 0) return null;

  return { path: rest.slice(slash + 1), session: rest.slice(0, slash) };
};

// A request for "/style.css" from a page of a site means that site's
// style.css, as it would on a server serving the site at its root.
const sessionOfRequest = async (event, url) => {
  const sources = [];

  if (event.clientId) {
    const client = await self.clients.get(event.clientId);

    if (client) sources.push(client.url);
  }
  if (event.request.referrer) sources.push(event.request.referrer);

  for (const source of sources) {
    try {
      const found = locate(new URL(source));

      if (found && new URL(source).origin === url.origin) return found.session;
    } catch {
      // Not a URL of ours.
    }
  }

  return null;
};

// Asked for afresh each page (the host serves them uncached), so a deploy
// that changes only the prelude reaches pages already open at their next run.
// The console comes first: the prelude starts it.
const prelude = async () => {
  const [devConsole, own] = await Promise.all(
    ["console.js", "prelude.js"].map(async (name) => (await fetch(`${HOST}${name}`, { cache: "no-cache" })).text()),
  );

  return `${devConsole}\n${own}`;
};

// What a server says for a page that isn't there. It has the prelude too, so
// the editor's address bar shows the address that was asked for.
const notFound = (session, path, html) =>
  new Response(
    html
      ? withPrelude(
          `<!doctype html><html><head><meta charset="utf-8"><title>Page not found</title></head>` +
            `<body style="font: 16px system-ui, sans-serif; margin: 2rem; color: #333">` +
            `<h1 style="font-size: 1.4rem">Page not found</h1>` +
            `<p>Your site has no file called <code>${escapeHtml(path || "/")}</code>.</p>` +
            `<p>Check the link's spelling, capital letters included, and that the file is in the right folder.</p>` +
            `</body></html>`,
          session,
        )
      : "",
    { headers: { ...HEADERS, "Content-Type": html ? "text/html; charset=utf-8" : "text/plain" }, status: 404 },
  );

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Before anything of the page runs and on the line the page's own first tag
// is on, so line numbers in the page's errors stay the kid's.
const withPrelude = (html, session) => {
  const tag = `<script src="${SESSIONS}${encodeURIComponent(session)}/${PRELUDE}"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html) ?? /<html(\s[^>]*)?>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html);

  return head
    ? `${html.slice(0, head.index + head[0].length)}${tag}${html.slice(head.index + head[0].length)}`
    : `${tag}${html}`;
};

// A script from another website only says what went wrong (not just "Script
// error.") when it is fetched with CORS. These CDNs allow that for every
// file, so asking can't stop a script loading; other websites are left alone.
// The editor's built page does the same (src/web/files.ts).
const CORS_CDNS = /^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|code\.jquery\.com|ajax\.googleapis\.com|esm\.sh|cdn\.skypack\.dev)\//i;

const withCors = (html) =>
  html.replace(/<script\b[^>]*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);

    return src && CORS_CDNS.test(src[1]) && !/\bcrossorigin\b/i.test(tag) ? `${tag.slice(0, -1)} crossorigin="anonymous">` : tag;
  });

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// Audio and video ask for byte ranges when they seek.
const ranged = (request, blob, type) => {
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") ?? "");

  if (!range) {
    return new Response(blob, {
      headers: { ...HEADERS, "Accept-Ranges": "bytes", "Content-Length": String(blob.size), "Content-Type": type },
    });
  }

  const size = blob.size;
  let start = range[1] === "" ? size - Number(range[2]) : Number(range[1]);
  let end = range[1] === "" || range[2] === "" ? size - 1 : Number(range[2]);

  start = Math.max(0, start);
  end = Math.min(size - 1, end);

  if (start > end || start >= size) {
    return new Response("", { headers: { "Content-Range": `bytes */${size}` }, status: 416 });
  }

  return new Response(blob.slice(start, end + 1), {
    headers: {
      ...HEADERS,
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Type": type,
    },
    status: 206,
  });
};

const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

// Where the bridge stored a file of a session (index.html writes the same).
const keyOf = (session, path) =>
  new Request(`${self.location.origin}${SESSIONS}${encodeURIComponent(session)}/${encodePath(path)}`);

const serve = async (event, session, path) => {
  const cache = await caches.open(CACHE_PREFIX + session);
  const isNavigation = event.request.mode === "navigate";

  if (path === PRELUDE) {
    const meta = await cache.match(keyOf(session, META));
    const config = meta ? await meta.text() : "{}";

    return new Response(`window.__CODEYKIDS__ = ${config};\n${await prelude()}`, {
      headers: { ...HEADERS, "Content-Type": "text/javascript; charset=utf-8" },
    });
  }

  // A folder means its index.html, as on a server.
  let name = path === "" || path.endsWith("/") ? `${path}index.html` : path;
  let stored = name.startsWith("__codeykids__/") ? undefined : await cache.match(keyOf(session, name));

  if (!stored && isNavigation && !/\.[^/]+$/.test(name)) {
    stored = await cache.match(keyOf(session, `${name}/index.html`));
    if (stored) name = `${name}/index.html`;
  }
  if (!stored) return notFound(session, path, isNavigation);

  const type = typeOf(name);

  if (type.startsWith("text/html")) {
    return new Response(withPrelude(withCors(await stored.text()), session), {
      headers: { ...HEADERS, "Content-Type": type },
    });
  }

  return ranged(event.request, await stored.blob(), type);
};

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return;

  const found = locate(url);

  if (found) {
    event.respondWith(serve(event, found.session, found.path));
    return;
  }

  // The bridge page, opened by the editor for each run (always with its
  // build number), even while the frame still shows a page of a site.
  if (url.pathname === `${HOST}index.html` && url.searchParams.has("build")) return;

  // A site's root-relative address ("/style.css", or a link to "/") is served
  // from the site that asked, even where the host has a file of that name.
  // A page goes to its address in the site, so its own relative links work.
  // Anything else goes to the network.
  event.respondWith(
    (async () => {
      const session = await sessionOfRequest(event, url);

      if (!session) return fetch(event.request);

      const path = decode(url.pathname.slice(1));

      if (event.request.mode === "navigate") {
        return Response.redirect(`${self.location.origin}${SESSIONS}${encodeURIComponent(session)}/${encodePath(path)}${url.search}`, 302);
      }

      return serve(event, session, path);
    })(),
  );
});
