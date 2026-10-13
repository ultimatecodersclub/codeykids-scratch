// The page's side of public/editor-sw.js: the service worker that lets real
// Python's worker block on input() and time.sleep(). It must control this
// page (and so the worker) before a program runs.

const SCRIPT = "/editor-sw.js";
// Built, the worker sits under /python/; in development Vite serves it from
// /src/, so the service worker has to reach the whole site.
const SCOPE = import.meta.env.DEV ? "/" : "/python/";
const CONTROL_TIMEOUT_MS = 5000;

let ready: Promise<boolean> | undefined;

const controlled = () =>
  new Promise<boolean>((resolve) => {
    if (navigator.serviceWorker.controller) {
      resolve(true);
      return;
    }

    const timer = setTimeout(() => resolve(false), CONTROL_TIMEOUT_MS);

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

// Registers once; later calls share the answer. False where service workers
// are unavailable (or blocked), in which case input() and sleep() cannot wait.
export const syncReady = () => {
  ready ??=
    "serviceWorker" in navigator
      ? navigator.serviceWorker
          .register(SCRIPT, { scope: SCOPE })
          .then(() => controlled())
          .catch(() => false)
      : Promise.resolve(false);

  return ready;
};

// Hands the worker its answer: the service worker releases the request the
// worker is blocked on.
export const writeReply = async (id: string, value: string) => {
  await fetch("/__codeykids__/io/write", {
    body: JSON.stringify({ id, value }),
    method: "POST",
  });
};

// A picture for the worker: bytes, not JSON.
export const writeBinaryReply = async (id: string, bytes: Uint8Array) => {
  await fetch(`/__codeykids__/io/write?binary&id=${encodeURIComponent(id)}`, {
    body: bytes as BodyInit,
    method: "POST",
  });
};
