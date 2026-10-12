// Lets the Python editor's worker wait for the page: real Python's input()
// and time.sleep() block, and a worker can only block on a synchronous
// request. The worker asks here and this answers once the page has written
// the reply, or once the sleep is over. The same approach as sync-message
// (MIT, Alex Hall), without SharedArrayBuffer, so CodeyKids needs no
// cross-origin isolation headers. Every other request passes through.

const PREFIX = "/__codeykids__/io/";
// A read holds the request open at most this long; the worker asks again.
const READ_TIMEOUT_MS = 20000;
const SLEEP_CAP_MS = 10000;

const waiting = new Map();
const early = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" }, status });

const read = async (request) => {
  const { id } = await request.json();

  if (early.has(id)) {
    const value = early.get(id);

    early.delete(id);
    return json({ value });
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve(json({ timeout: true }, 408));
    }, READ_TIMEOUT_MS);

    waiting.set(id, (value) => {
      clearTimeout(timer);
      resolve(json({ value }));
    });
  });
};

const write = async (request) => {
  const { id, value } = await request.json();
  const resolve = waiting.get(id);

  if (resolve) {
    waiting.delete(id);
    resolve(value);
  } else {
    early.set(id, value);
  }

  return json({ ok: true });
};

const sleep = (url) => {
  const ms = Math.min(Math.max(Number(url.searchParams.get("ms")) || 0, 0), SLEEP_CAP_MS);

  return new Promise((resolve) => setTimeout(() => resolve(json({ slept: ms })), ms));
};

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return;

  const action = url.pathname.slice(PREFIX.length);

  if (action === "read") event.respondWith(read(event.request));
  else if (action === "write") event.respondWith(write(event.request));
  else if (action === "sleep") event.respondWith(sleep(url));
  else if (action === "ping") event.respondWith(json({ ok: true }));
});
