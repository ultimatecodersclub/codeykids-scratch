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

// Called by input(): asks the page, then blocks until it answers.
self.codeykidsInput = (prompt: string) => {
  if (!syncAvailable) throw new Error("no service worker");

  const id = `${Date.now()}-${(nextId += 1)}`;

  post({ id, prompt, type: "input" });

  for (;;) {
    const xhr = request(`${IO}read`, { id });

    if (xhr.status === 200) return JSON.parse(xhr.responseText).value as string;
    if (xhr.status !== 408) throw new Error(`no answer (${xhr.status})`);
  }
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
      instance.FS.writeFile(`${MODULES_DIR}/${name}`, new TextEncoder().encode(source));
    }

    instance.runPython(PRELUDE);
    post({ type: "ready" });

    return instance;
  })();

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
  const python = await load();
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
    await python.loadPackagesFromImports(code, {
      messageCallback: (message) => {
        if (message.startsWith("Loading ")) post({ text: `${message.replace(/\.*$/, "")}…`, type: "status" });
      },
    });

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
  if (event.data.type === "load") void load();
  else void run(event.data);
};
