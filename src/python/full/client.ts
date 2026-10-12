// The page's side of the real-Python worker: starts it, runs a project in it,
// answers its input() through the service worker, and stops a program by
// ending the worker (the next run starts a fresh one).

import { syncReady, writeBinaryReply, writeReply } from "../syncio";
import { cameraClose, cameraOpen, cameraRead, detectHands, waitKey } from "./camera";
import type { AiAccess, LoadMessage, RunMessage, WorkerMessage } from "./worker";

export type { AiAccess };

export type Picture = { bytes: Uint8Array; height: number; width: number };

export type FullRunHandlers = {
  image: (bytes: Uint8Array) => void;
  input: (prompt: string) => Promise<string>;
  output: (text: string, kind: "out" | "info") => void;
  // What cv2.imshow shows, or undefined once the program closes its windows.
  window: (picture?: Picture) => void;
};

export type FullRunResult = {
  changed: Record<string, Uint8Array>;
  deleted: string[];
  error?: { file?: string; line?: number; message: string };
};

let worker: Worker | undefined;
let loaded = false;
let finish: ((result: FullRunResult) => void) | undefined;
let handlers: FullRunHandlers | undefined;

const STOPPED: FullRunResult = { changed: {}, deleted: [], error: { message: "Stopped" } };

type CameraMessage = Extract<WorkerMessage, { type: "camera" }>;

const answerCamera = async ({ action, bytes, id, payload }: CameraMessage) => {
  const data = payload ? JSON.parse(payload) : {};

  try {
    switch (action) {
      case "open":
        await writeReply(id, JSON.stringify(await cameraOpen()));
        break;
      case "read": {
        const picture = cameraRead();

        await (picture ? writeBinaryReply(id, picture) : writeReply(id, "null"));
        break;
      }
      case "detect":
        await writeReply(id, JSON.stringify(await detectHands(bytes!, data.width, data.height, data.maxHands ?? 2)));
        break;
      case "key":
        await writeReply(id, String(await waitKey(data.delay ?? 0)));
        break;
      case "show":
        handlers?.window({ bytes: bytes!, height: data.height, width: data.width });
        break;
      case "hide":
        handlers?.window(undefined);
        break;
      case "close":
        cameraClose();
        break;
    }
  } catch (error) {
    if (action === "detect" || action === "open")
      await writeReply(id, JSON.stringify({ error: `The camera tools stopped: ${String(error)}`, open: false }));
  }
};

const onMessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;

  switch (message.type) {
    case "status":
      handlers?.output(`${message.text}\n`, "info");
      break;
    case "stdout":
      handlers?.output(message.text, "out");
      break;
    case "stderr":
      handlers?.output(message.text, "info");
      break;
    case "input":
      void handlers?.input(message.prompt).then((value) => writeReply(message.id, value));
      break;
    case "image":
      handlers?.image(message.bytes);
      break;
    case "camera":
      void answerCamera(message);
      break;
    case "ready":
      loaded = true;
      break;
    case "done":
      cameraClose();
      finish?.({ changed: message.changed, deleted: message.deleted, error: message.error });
      finish = undefined;
      handlers = undefined;
      break;
  }
};

const start = () => {
  if (!worker) {
    loaded = false;
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = onMessage;
    worker.onerror = (event) => {
      finish?.({ changed: {}, deleted: [], error: { message: `Python stopped: ${event.message}` } });
      finish = undefined;
      handlers = undefined;
      worker = undefined;
    };
  }

  return worker;
};

// Loads Python ahead of the first Run, so it is ready when the kid is.
export const warmUpFullPython = () => {
  void syncReady();
  start().postMessage({ type: "load" } satisfies LoadMessage);
};

export const runFullPython = async (
  files: Record<string, Uint8Array>,
  runHandlers: FullRunHandlers,
  ai?: AiAccess,
): Promise<FullRunResult> => {
  const syncAvailable = await syncReady();
  const target = start();

  handlers = runHandlers;
  // The worker's own "Starting" went out before this run was listening.
  if (!loaded) runHandlers.output("Starting Python…\n", "info");

  return new Promise((resolve) => {
    finish = resolve;
    target.postMessage({ ai, files, syncAvailable, type: "run" } satisfies RunMessage);
  });
};

// A worker blocked in Python cannot be interrupted from here, so it goes.
export const stopFullPython = () => {
  cameraClose();
  worker?.terminate();
  worker = undefined;
  handlers = undefined;
  finish?.(STOPPED);
  finish = undefined;
};
