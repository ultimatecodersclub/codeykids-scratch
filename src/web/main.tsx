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
  toZip,
  WebFiles,
} from "./files";
import "./web.css";

const SIZE_LIMIT = 20 * 1024 * 1024;
const PREVIEW_DELAY_MS = 400;
const CHANGED_THROTTLE_MS = 1000;

const WebEditor = () => {
  const [files, setFiles] = useState<WebFiles>(() => structuredClone(STARTER_FILES));
  const [active, setActive] = useState("index.html");
  const [readOnly, setReadOnly] = useState(false);
  const [previewPage, setPreviewPage] = useState("index.html");
  const [srcdoc, setSrcdoc] = useState("");
  // Bumped on every load so the code editor takes the new document even when
  // the active file keeps its name.
  const [generation, setGeneration] = useState(0);

  const filesRef = useRef(files);
  const lastChangedAt = useRef(0);

  filesRef.current = files;

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

  // The page drives loading and saving over postMessage.
  useEffect(() => {
    postToPage({ type: "ready" });

    return listenToPage(async (message) => {
      switch (message.type) {
        case "load":
          try {
            const blob = message.file ?? (message.url ? await (await fetch(message.url)).blob() : undefined);
            const next = blob ? await fromZip(blob) : structuredClone(STARTER_FILES);

            setFiles(next);
            setActive(next["index.html"] ? "index.html" : Object.keys(next)[0]);
            setPreviewPage(next["index.html"] ? "index.html" : Object.keys(next).find(isHtml) ?? "index.html");
            if (message.readOnly !== undefined) setReadOnly(message.readOnly);
            setGeneration((i) => i + 1);
            postToPage({ type: "loaded" });
          } catch (error) {
            postToPage({ message: String(error), type: "loadFailed" });
          }
          break;
        case "save": {
          const size = bytesOf(filesRef.current);

          if (size > SIZE_LIMIT) {
            postToPage({
              message: `The site is ${Math.round(size / 1024 / 1024)} MB; the limit is 20 MB.`,
              requestId: message.requestId,
              type: "saveFailed",
            });
            break;
          }

          postToPage({ file: toZip(filesRef.current), requestId: message.requestId, type: "saved" });
          break;
        }
        case "setReadOnly":
          setReadOnly(message.value);
          break;
      }
    });
  }, []);

  // The preview follows the files, a moment after the last keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setSrcdoc(buildPreview(files, previewPage)), PREVIEW_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [files, previewPage]);

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
        <iframe sandbox="allow-scripts allow-modals" srcDoc={srcdoc} title="Preview" />
      </section>
    </div>
  );
};

createRoot(document.getElementById("app")!).render(<WebEditor />);
