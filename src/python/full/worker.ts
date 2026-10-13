/// <reference lib="webworker" />

// Runs a kid's program in real Python (Pyodide) off the page's thread, for
// programs that import what Skulpt lacks: matplotlib, PIL, numpy, os,
// requests and the like. The project's files are its working folder; what
// the program changes there goes back to the page when it ends. input() and
// time.sleep() block on a synchronous request that public/editor-sw.js holds
// open until the page answers.

import { MODULES } from "./modules";
import { PRELUDE } from "./prelude";

declare const self: DedicatedWorkerGlobalScope & Record<string, unknown>;

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
const PROJECT = "/home/pyodide/project";
const IO = "/__codeykids__/io/";
// Stand-ins for libraries a browser cannot run (see modules.ts); the
// project's own files come first on the path.
const MODULES_DIR = "/home/pyodide/.codeykids";

const AI_CHAT = `mutation aiChat($input: AiChatInput!) {
  aiChat(input: $input) {
    blocked
    content
  }
}`;

type FS = {
  mkdirTree: (path: string) => void;
  readdir: (path: string) => string[];
  readFile: (path: string) => Uint8Array;
  rmdir: (path: string) => void;
  stat: (path: string) => { mode: number };
  isDir: (mode: number) => boolean;
  unlink: (path: string) => void;
  writeFile: (path: string, data: Uint8Array) => void;
  analyzePath: (path: string) => { exists: boolean };
};

type Pyodide = {
  FS: FS;
  loadPackage: (names: string[], options?: { messageCallback?: (message: string) => void }) => Promise<unknown>;
  loadPackagesFromImports: (code: string, options?: { messageCallback?: (message: string) => void }) => Promise<unknown>;
  runPython: (code: string) => unknown;
  setStderr: (options: { write: (buffer: Uint8Array) => number; isatty?: boolean }) => void;
  setStdout: (options: { write: (buffer: Uint8Array) => number; isatty?: boolean }) => void;
};

// Where the ollama stand-in asks, and the token that lets it.
export type AiAccess = { token: string; url: string };

export type RunMessage = {
  ai?: AiAccess;
  files: Record<string, Uint8Array>;
  syncAvailable: boolean;
  type: "run";
};
export type LoadMessage = { type: "load" };

export type WorkerMessage =
  | { text: string; type: "status" }
  | { text: string; type: "stdout" | "stderr" }
  | { id: string; prompt: string; type: "input" }
  | { bytes: Uint8Array; type: "image" }
  // cv2 and mediapipe asking the page for the camera, a window or hands.
  | { action: string; bytes?: Uint8Array; id: string; payload: string; type: "camera" }
  | { type: "ready" }
  | {
      changed: Record<string, Uint8Array>;
      deleted: string[];
      error?: { file?: string; line?: number; message: string };
      type: "done";
    };

const post = (message: WorkerMessage, transfer: Transferable[] = []) => self.postMessage(message, transfer);

let pyodide: Promise<Pyodide> | undefined;
let syncAvailable = false;
let ai: AiAccess | undefined;
let nextId = 0;

const request = (path: string, body?: unknown) => {
  const xhr = new XMLHttpRequest();

  xhr.open(body === undefined ? "GET" : "POST", path, false);
  xhr.send(body === undefined ? null : JSON.stringify(body));

  return xhr;
};

const nextRequestId = () => `${Date.now()}-${(nextId += 1)}`;

// Blocks until the page has answered request `id`: its JSON value, or the
// bytes it wrote (a camera picture) when `binary`.
const awaitReply = (id: string, binary = false): unknown => {
  for (;;) {
    const xhr = new XMLHttpRequest();

    xhr.open("POST", `${IO}read`, false);
    if (binary) xhr.responseType = "arraybuffer";
    xhr.send(JSON.stringify({ id }));

    if (xhr.status === 200) {
      const isJson = xhr.getResponseHeader("Content-Type")?.includes("json");

      if (!binary) return JSON.parse(xhr.responseText).value;

      return isJson ? JSON.parse(decoder.decode(xhr.response as ArrayBuffer)).value : xhr.response;
    }
    if (xhr.status !== 408) throw new Error(`no answer (${xhr.status})`);
  }
};

// Called by input(): asks the page, then blocks until it answers.
self.codeykidsInput = (prompt: string) => {
  if (!syncAvailable) throw new Error("no service worker");

  const id = nextRequestId();

  post({ id, prompt, type: "input" });

  return awaitReply(id) as string;
};

// Actions the page answers; the rest (show, hide, close) it just carries out.
const CAMERA_REPLIES = new Set(["detect", "key", "open", "read"]);

// Called by the cv2 and mediapipe stand-ins. Answers JSON text, or the bytes
// of a picture for "read".
self.codeykidsCamera = (action: string, payload = "", bytes?: Uint8Array) => {
  if (!syncAvailable) throw new Error("no service worker");

  const id = nextRequestId();
  const copy = bytes?.slice();

  post({ action, bytes: copy, id, payload, type: "camera" }, copy ? [copy.buffer] : []);

  return CAMERA_REPLIES.has(action) ? awaitReply(id, action === "read") : undefined;
};

// Called by time.sleep(): waits without spinning, a slice at a time.
self.codeykidsSleep = (ms: number) => {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const left = end - Date.now();

    if (syncAvailable) {
      const xhr = request(`${IO}sleep?ms=${Math.ceil(Math.min(left, 10000))}`);

      if (xhr.status === 200) continue;
    }

    // No service worker: spin, as Python itself would without one.
    while (Date.now() < end) {
      // waiting
    }
  }
};

// Called by the ollama stand-in with the request as JSON; answers JSON with
// either the reply's content or an error a kid can read.
self.codeykidsAiChat = (payload: string) => {
  if (!ai) return JSON.stringify({ error: "The AI works when this lesson is opened in CodeyKids." });

  const xhr = new XMLHttpRequest();

  xhr.open("POST", ai.url, false);
  xhr.setRequestHeader("Content-Type", "application/json");

  try {
    xhr.send(JSON.stringify({ query: AI_CHAT, variables: { input: { ...JSON.parse(payload), token: ai.token } } }));
  } catch {
    return JSON.stringify({ error: "The AI could not be reached. Check the internet connection." });
  }

  const body = JSON.parse(xhr.responseText || "{}");
  const error = body.errors?.[0]?.message;

  if (error) return JSON.stringify({ error });
  if (!body.data?.aiChat) return JSON.stringify({ error: `The AI did not answer (${xhr.status}).` });

  return JSON.stringify(body.data.aiChat);
};

// Called by plt.show() and Image.show().
self.codeykidsImage = (bytes: Uint8Array) => {
  const copy = bytes.slice();

  post({ bytes: copy, type: "image" }, [copy.buffer]);
};

// Stand-ins that need packages the program's own imports do not name.
const STANDIN_PACKAGES: [RegExp, string[]][] = [[/^[ \t]*(?:import|from)[ \t]+mediapipe/m, ["numpy", "opencv-python"]]];

const stream = (type: "stdout" | "stderr") => {
  const decoder = new TextDecoder();

  return {
    isatty: true,
    write: (buffer: Uint8Array) => {
      const text = decoder.decode(buffer, { stream: true });

      if (text) post({ text, type });

      return buffer.length;
    },
  };
};

const load = () => {
  pyodide ??= (async () => {
    const { loadPyodide } = await import(/* @vite-ignore */ `${PYODIDE_URL}pyodide.mjs`);
    const instance = (await loadPyodide({ indexURL: PYODIDE_URL })) as Pyodide;

    instance.setStdout(stream("stdout"));
    instance.setStderr(stream("stderr"));
    instance.FS.mkdirTree(PROJECT);
    instance.FS.mkdirTree(MODULES_DIR);

    for (const [name, source] of Object.entries(MODULES)) {
      const slash = name.lastIndexOf("/");

      if (slash > 0) instance.FS.mkdirTree(`${MODULES_DIR}/${name.slice(0, slash)}`);
      instance.FS.writeFile(`${MODULES_DIR}/${name}`, new TextEncoder().encode(source));
    }

    instance.runPython(PRELUDE);
    post({ type: "ready" });

    return instance;
  })().catch((error: unknown) => {
    // Not kept: the next Run tries again, the page having been offline, say.
    pyodide = undefined;
    throw error;
  });

  return pyodide;
};

const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

// Every file under the project folder, by its path inside it.
const listFiles = (fs: FS, dir = ""): string[] =>
  fs
    .readdir(joinPath(PROJECT, dir) || PROJECT)
    .filter((name) => name !== "." && name !== ".." && name !== "__pycache__")
    .flatMap((name) => {
      const path = joinPath(dir, name);

      return fs.isDir(fs.stat(`${PROJECT}/${path}`).mode) ? listFiles(fs, path) : [path];
    });

const removeTree = (fs: FS, path: string) => {
  for (const name of fs.readdir(path)) {
    if (name === "." || name === "..") continue;

    const child = `${path}/${name}`;

    if (fs.isDir(fs.stat(child).mode)) {
      removeTree(fs, child);
      fs.rmdir(child);
    } else {
      fs.unlink(child);
    }
  }
};

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

const decoder = new TextDecoder();

const run = async ({ ai: access, files, syncAvailable: available }: RunMessage) => {
  let python: Pyodide;

  try {
    python = await load();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const message = `Python did not start (${reason}). Check the internet connection, then press Run again.`;

    post({ changed: {}, deleted: [], error: { message }, type: "done" });
    return;
  }

  const fs = python.FS;

  syncAvailable = available;
  ai = access;

  removeTree(fs, PROJECT);

  for (const [name, bytes] of Object.entries(files)) {
    const slash = name.lastIndexOf("/");

    if (slash > 0) fs.mkdirTree(`${PROJECT}/${name.slice(0, slash)}`);
    fs.writeFile(`${PROJECT}/${name}`, bytes);
  }

  const code = Object.entries(files)
    .filter(([name]) => name.endsWith(".py"))
    .map(([, bytes]) => decoder.decode(bytes))
    .join("\n");

  let error: { file?: string; line?: number; message: string } | undefined;

  try {
    const extra = STANDIN_PACKAGES.filter(([pattern]) => pattern.test(code)).flatMap(([, names]) => names);
    // "Loading matplotlib, numpy…" while packages download; the rest is noise.
    const messageCallback = (message: string) => {
      if (message.startsWith("Loading ")) post({ text: `${message.replace(/\.*$/, "")}…`, type: "status" });
    };

    if (extra.length > 0) await python.loadPackage(extra, { messageCallback });
    await python.loadPackagesFromImports(code, { messageCallback });

    const result = python.runPython("_codeykids.run_main()") as string | undefined;

    if (result) error = JSON.parse(result);
  } catch (e) {
    error = { message: String(e) };
  }

  const changed: Record<string, Uint8Array> = {};
  const now = listFiles(fs);

  for (const path of now) {
    const bytes = fs.readFile(`${PROJECT}/${path}`);
    const before = files[path];

    if (!before || !same(before, bytes)) changed[path] = bytes;
  }

  const deleted = Object.keys(files).filter((path) => !now.includes(path));

  post({ changed, deleted, error, type: "done" }, Object.values(changed).map((bytes) => bytes.buffer));
};

self.onmessage = (event: MessageEvent<RunMessage | LoadMessage>) => {
  // A warm-up that fails says nothing; the Run after it reports why.
  if (event.data.type === "load") load().catch(() => undefined);
  else void run(event.data);
};
