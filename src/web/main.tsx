import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { listenToPage, postToPage } from "../bridge";
import { CodeEditor } from "./CodeEditor";
import {
  buildPreview,
  bytesOf,
  fromZip,
  isHtml,
  isText,
  STARTER_FILES,
  Storage,
  storageBytes,
  toZip,
  WebFiles,
} from "./files";
import "./web.css";

const SIZE_LIMIT = 20 * 1024 * 1024;
const PREVIEW_DELAY_MS = 400;
const CHANGED_THROTTLE_MS = 1000;
// A page that saves state on every frame must not push the autosave back for
// ever: its writes count as one change a minute at most.
const STORAGE_CHANGED_THROTTLE_MS = 60_000;
const CONSOLE_CAP = 500;

type ConsoleLine = { id: number; level: string; text: string };

const WebEditor = () => {
  const [files, setFiles] = useState<WebFiles>(() => structuredClone(STARTER_FILES));
  const [active, setActive] = useState("index.html");
  const [readOnly, setReadOnly] = useState(false);
  const [previewPage, setPreviewPage] = useState("index.html");
  const [srcdoc, setSrcdoc] = useState("");
  // Bumped on every load so the code editor takes the new document even when
  // the active file keeps its name.
  const [generation, setGeneration] = useState(0);
  const [reloads, setReloads] = useState(0);
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]);
  const [command, setCommand] = useState("");

  const filesRef = useRef(files);
  const readOnlyRef = useRef(readOnly);
  const previewPageRef = useRef(previewPage);
  // What the page keeps in localStorage; saved with the site. A ref, not
  // state: a write must not rebuild (and so reload) the preview.
  const storageRef = useRef<Storage>({});
  // Each build gets an epoch; messages from an older page are dropped.
  const epochRef = useRef(0);
  const lastChangedAt = useRef(0);
  const lastStorageChangedAt = useRef(0);
  const previewRef = useRef<HTMLIFrameElement>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  // Console output arrives one message per line; lines are batched into one
  // render a frame or so.
  const pendingLines = useRef<ConsoleLine[]>([]);
  const flushTimer = useRef<number>();
  const lineId = useRef(0);

  filesRef.current = files;
  readOnlyRef.current = readOnly;
  previewPageRef.current = previewPage;

  const names = useMemo(() => Object.keys(files).sort(), [files]);

  const changed = useCallback(() => {
    const now = Date.now();
    if (now - lastChangedAt.current < CHANGED_THROTTLE_MS) return;

    lastChangedAt.current = now;
    postToPage({ type: "changed" });
  }, []);

  const update = useCallback(
    (next: WebFiles) => {
      setFiles(next);
      changed();
    },
    [changed],
  );

  const pushLine = useCallback((level: string, text: string) => {
    pendingLines.current.push({ id: (lineId.current += 1), level, text });

    if (flushTimer.current !== undefined) return;

    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = undefined;

      const batch = pendingLines.current;

      pendingLines.current = [];
      setConsoleLines((current) => [...current, ...batch].slice(-CONSOLE_CAP));
    }, 16);
  }, []);

  // The page is shown again from the start: blank first, so the old page is
  // gone and the rebuilt document is a change even when nothing else moved.
  const reload = useCallback(() => {
    setSrcdoc("");
    setReloads((i) => i + 1);
  }, []);

  // The page drives loading and saving over postMessage.
  useEffect(() => {
    postToPage({ type: "ready" });

    return listenToPage(async (message) => {
      switch (message.type) {
        case "load":
          try {
            const blob = message.file ?? (message.url ? await (await fetch(message.url)).blob() : undefined);
            const project = blob ? await fromZip(blob) : { files: structuredClone(STARTER_FILES), storage: {} };
            const next = project.files;

            // The old page goes away before the new project is in, so
            // nothing it still does lands on the new one.
            setSrcdoc("");
            storageRef.current = project.storage;
            setFiles(next);
            setActive(next["index.html"] ? "index.html" : Object.keys(next)[0]);
            setPreviewPage(next["index.html"] ? "index.html" : (Object.keys(next).find(isHtml) ?? "index.html"));
            if (message.readOnly !== undefined) setReadOnly(message.readOnly);
            setGeneration((i) => i + 1);
            postToPage({ type: "loaded" });
          } catch (error) {
            postToPage({ message: String(error), type: "loadFailed" });
          }
          break;
        case "save": {
          const size = bytesOf(filesRef.current) + storageBytes(storageRef.current);

          if (size > SIZE_LIMIT) {
            postToPage({
              message: `The site is ${Math.round(size / 1024 / 1024)} MB with what it saved; the limit is 20 MB.`,
              requestId: message.requestId,
              type: "saveFailed",
            });
            break;
          }

          postToPage({
            file: toZip({ files: filesRef.current, storage: storageRef.current }),
            requestId: message.requestId,
            type: "saved",
          });
          break;
        }
        case "setReadOnly":
          setReadOnly(message.value);
          break;
      }
    });
  }, []);

  // The prelude in the preview asks for another page of the site when a link
  // to it is clicked or a form is sent, forwards console output and errors,
  // and reports what the page saved.
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== previewRef.current?.contentWindow) return;
      if (event.data?.epoch !== epochRef.current) return;

      if (event.data.type === "preview:navigate") {
        const page = String(event.data.page);

        if (!isHtml(page) || !filesRef.current[page]) return;
        if (page === previewPageRef.current) reload();
        else setPreviewPage(page);
      } else if (event.data.type === "preview:console") {
        pushLine(String(event.data.level), String(event.data.text));
      } else if (event.data.type === "preview:storage") {
        const data = event.data.data as Storage;

        if (JSON.stringify(data) === JSON.stringify(storageRef.current)) return;

        storageRef.current = { ...data };

        const now = Date.now();

        if (readOnlyRef.current || now - lastStorageChangedAt.current < STORAGE_CHANGED_THROTTLE_MS) return;

        lastStorageChangedAt.current = now;
        changed();
      }
    };

    window.addEventListener("message", listener);

    return () => window.removeEventListener("message", listener);
  }, [changed, pushLine, reload]);

  // The preview follows the files, a moment after the last keystroke; the
  // console starts over with it.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      epochRef.current += 1;
      pendingLines.current = [];
      setConsoleLines([]);
      setSrcdoc(buildPreview(files, previewPage, storageRef.current, epochRef.current));
    }, PREVIEW_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [files, previewPage, reloads]);

  useEffect(() => () => window.clearTimeout(flushTimer.current), []);

  useEffect(() => {
    consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
  }, [consoleLines]);

  // Replaces DevTools > Application for a kid: forgets what the page saved
  // and shows it again from scratch.
  const clearStorage = () => {
    if (!window.confirm("Forget everything this site saved in localStorage?")) return;

    storageRef.current = {};
    reload();
    if (!readOnly) changed();
  };

  // A line typed into the console runs in the page, like a browser's own.
  const runCommand = () => {
    const code = command.trim();

    if (!code) return;

    pushLine("input", code);
    previewRef.current?.contentWindow?.postMessage({ code, type: "preview:eval" }, "*");
    setCommand("");
  };

  const addFile = () => {
    const name = window.prompt("File name, for example about.html or style.css")?.trim();

    if (!name || files[name]) return;

    update({ ...files, [name]: isText(name) ? { text: "" } : { bytes: new Uint8Array() } });
    setActive(name);
  };

  const addImage = async (list: FileList | null) => {
    if (!list?.length) return;

    const next = { ...files };

    for (const file of Array.from(list)) {
      next[file.name] = { bytes: new Uint8Array(await file.arrayBuffer()) };
    }

    update(next);
  };

  const renameFile = (name: string) => {
    const next = window.prompt("New name", name)?.trim();

    if (!next || next === name || files[next]) return;

    const { [name]: file, ...rest } = files;

    update({ ...rest, [next]: file });
    if (active === name) setActive(next);
    if (previewPage === name) setPreviewPage(next);
  };

  const deleteFile = (name: string) => {
    if (!window.confirm(`Delete ${name}?`)) return;

    const { [name]: _removed, ...rest } = files;

    update(rest);
    if (active === name) setActive(Object.keys(rest)[0] ?? "");
  };

  const activeFile = files[active];

  return (
    <div className="layout">
      <aside className="files">
        <div className="files-header">
          <span>Files</span>
          {!readOnly && (
            <span className="files-actions">
              <button onClick={addFile} title="New file" type="button">+</button>
              <label title="Add an image">
                🖼
                <input accept="image/*" hidden multiple onChange={(e) => void addImage(e.target.files)} type="file" />
              </label>
            </span>
          )}
        </div>
        <ul>
          {names.map((name) => (
            <li className={name === active ? "active" : ""} key={name}>
              <button className="file-name" onClick={() => setActive(name)} type="button">
                {name}
              </button>
              {!readOnly && (
                <span className="file-actions">
                  <button onClick={() => renameFile(name)} title="Rename" type="button">✎</button>
                  <button onClick={() => deleteFile(name)} title="Delete" type="button">×</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </aside>

      <main className="code">
        {activeFile?.text !== undefined ? (
          <CodeEditor
            key={generation}
            name={active}
            onChange={(text) => update({ ...filesRef.current, [active]: { text } })}
            readOnly={readOnly}
            value={activeFile.text}
          />
        ) : activeFile ? (
          <div className="binary">
            <img alt={active} src={URL.createObjectURL(new Blob([(activeFile.bytes ?? new Uint8Array()) as BlobPart]))} />
            <p>{active} · {Math.round((activeFile.bytes?.byteLength ?? 0) / 1024)} KB</p>
          </div>
        ) : (
          <div className="binary">No file selected.</div>
        )}
      </main>

      <section className="preview">
        <div className="preview-header">
          <span>Preview</span>
          <select onChange={(e) => setPreviewPage(e.target.value)} value={previewPage}>
            {names.filter(isHtml).map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
        {/* Forms, downloads and new tabs are the kid's page's to use; without
            allow-same-origin the page stays walled off from the editor. */}
        <iframe
          ref={previewRef}
          sandbox="allow-scripts allow-modals allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox"
          srcDoc={srcdoc}
          title="Preview"
        />
        <div className="console-pane">
          <div className="console-header">
            <span>Console</span>
            <span>
              <button onClick={reload} title="Show the page again from the start" type="button">
                Reload
              </button>
              <button onClick={clearStorage} title="Forget what the page saved in localStorage" type="button">
                Clear saved data
              </button>
              <button onClick={() => setConsoleLines([])} type="button">Clear</button>
            </span>
          </div>
          <div className="console-lines" ref={consoleRef}>
            {consoleLines.length === 0 && <span className="console-hint">console.log and errors from your page show here.</span>}
            {consoleLines.map((line) => (
              <div className={`console-line ${line.level}`} key={line.id}>
                {line.text}
              </div>
            ))}
          </div>
          <form
            className="console-input"
            onSubmit={(e) => {
              e.preventDefault();
              runCommand();
            }}
          >
            <span>›</span>
            <input
              aria-label="Run JavaScript in the page"
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Type JavaScript and press Enter"
              value={command}
            />
          </form>
        </div>
      </section>
    </div>
  );
};

createRoot(document.getElementById("app")!).render(<WebEditor />);
