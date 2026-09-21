// The message contract between the lesson page (CodeyKids) and this editor.
// The editor never holds the kid's session: the page hands it a URL to load
// and asks for a Blob to save. See the CodeyKids Studio plan.

export type PageToEditor =
  // `file` is the project itself; `url` is fetched by the editor. A page that
  // already has the bytes passes `file` and skips CORS on this origin.
  | { type: "load"; file?: Blob; url?: string | null; readOnly?: boolean }
  | { type: "save"; requestId: string }
  // A picture of the work as it stands, for the project card.
  | { type: "snapshot"; requestId: string }
  | { type: "setReadOnly"; value: boolean };

export type EditorToPage =
  | { type: "ready" }
  | { type: "loaded" }
  | { type: "loadFailed"; message: string }
  | { type: "changed" }
  | { type: "saved"; requestId: string; file: Blob }
  | { type: "saveFailed"; requestId: string; message: string }
  | { type: "snapshot"; requestId: string; image: Blob }
  | { type: "snapshotFailed"; requestId: string; message: string };

// Origins allowed to drive the editor. `*` only for the local spike host page.
const allowedOrigins = (import.meta.env.VITE_ALLOWED_ORIGINS ?? "*")
  .split(",")
  .map((origin: string) => origin.trim());

export const isAllowedOrigin = (origin: string) =>
  allowedOrigins.includes("*") || allowedOrigins.includes(origin);

export const postToPage = (message: EditorToPage) => {
  if (window.parent === window) return;

  // Reply to whichever allowed origin embeds us. With a single allowed origin
  // this pins the target; with `*` (spike only) it broadcasts.
  const target = allowedOrigins.length === 1 ? allowedOrigins[0] : "*";
  window.parent.postMessage(message, target);
};

export const listenToPage = (handler: (message: PageToEditor) => void) => {
  const listener = (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    if (!isAllowedOrigin(event.origin)) return;
    if (!event.data || typeof event.data.type !== "string") return;

    handler(event.data as PageToEditor);
  };

  window.addEventListener("message", listener);

  return () => window.removeEventListener("message", listener);
};

// Answers a `snapshot` with the picture, or says why there is none. The page
// treats either as final, so this never throws.
export const answerSnapshot = async (requestId: string, take: () => Promise<Blob>) => {
  try {
    postToPage({ image: await take(), requestId, type: "snapshot" });
  } catch (error) {
    postToPage({ message: String(error), requestId, type: "snapshotFailed" });
  }
};
