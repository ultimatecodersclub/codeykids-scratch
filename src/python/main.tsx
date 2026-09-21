import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { answerSnapshot, listenToPage, postToPage } from "../bridge";
import { codeCard, pictureOf } from "../snapshot";
import { CodeEditor } from "../web/CodeEditor";
import { bytesOf, fromBytes, isText, MAIN, PythonFiles, starterFiles, toBlob } from "./project";
import { RunError, runPython } from "./runner";
import "./python.css";

const SIZE_LIMIT = 20 * 1024 * 1024;
const CHANGED_THROTTLE_MS = 1000;
const TURTLE_TARGET = "turtle";
// A runaway loop would otherwise grow the console without end.
const CONSOLE_CAP = 2000;

type Line = { id: number; kind: "error" | "info" | "out"; text: string };
type Pending = { prompt: string; resolve: (value: string) => void };

const TRIMMED: Omit<Line, "id"> = { kind: "info", text: "… earlier output trimmed …\n" };

const PythonEditor = () => {
  const [files, setFiles] = useState<PythonFiles>(starterFiles);
  const [active, setActive] = useState(MAIN);
  const [generation, setGeneration] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [pending, setPending] = useState<Pending>();
  const [readOnly, setReadOnly] = useState(false);
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState("");

  const filesRef = useRef(files);
  const lastChangedAt = useRef(0);
  const stopRef = useRef(false);
  const turtleRef = useRef<HTMLDivElement>(null);
  const consoleRef = useRef<HTMLDivElement>(null);

  filesRef.current = files;

  // main.py first, then the rest by name.
  const names = useMemo(
    () => Object.keys(files).sort((a, b) => (a === MAIN ? -1 : b === MAIN ? 1 : a.localeCompare(b))),
    [files],
  );

  const lineId = useRef(0);

  // Past the cap the console drops down to half, so a runaway loop costs one
  // copy per thousand lines rather than one per line.
  const append = useCallback((line: Omit<Line, "id">) => {
    const next = { ...line, id: (lineId.current += 1) };

    setLines((current) =>
      current.length < CONSOLE_CAP
        ? [...current, next]
        : [{ ...TRIMMED, id: (lineId.current += 1) }, ...current.slice(-(CONSOLE_CAP / 2)), next],
    );
  }, []);

  const changed = useCallback(() => {
    const now = Date.now();
    if (now - lastChangedAt.current < CHANGED_THROTTLE_MS) return;

    lastChangedAt.current = now;
    postToPage({ type: "changed" });
  }, []);

  const update = useCallback(
    (next: PythonFiles) => {
      setFiles(next);
      changed();
    },
    [changed],
  );

  useEffect(() => {
    postToPage({ type: "ready" });

    return listenToPage(async (message) => {
      switch (message.type) {
        case "load":
          try {
            const blob = message.file ?? (message.url ? await (await fetch(message.url)).blob() : undefined);
            const next = blob ? fromBytes(new Uint8Array(await blob.arrayBuffer())) : starterFiles();

            setFiles(next);
            setActive(MAIN);
            setGeneration((i) => i + 1);
            setLines([]);
            if (message.readOnly !== undefined) setReadOnly(message.readOnly);
            postToPage({ type: "loaded" });
          } catch (error) {
            postToPage({ message: String(error), type: "loadFailed" });
          }
          break;
        case "save": {
          if (bytesOf(filesRef.current) > SIZE_LIMIT) {
            postToPage({ message: "The project is over 20 MB.", requestId: message.requestId, type: "saveFailed" });
            break;
          }

          postToPage({ file: toBlob(filesRef.current), requestId: message.requestId, type: "saved" });
          break;
        }
        case "snapshot":
          void answerSnapshot(message.requestId, () => {
            const drawn = [...(turtleRef.current?.querySelectorAll("canvas") ?? [])];

            // Skulpt stacks a canvas per layer; together they are the
            // drawing. A program that never drew shows its code instead.
            return drawn.length > 0
              ? pictureOf(drawn.map((canvas) => ({ height: canvas.height, source: canvas, width: canvas.width })))
              : codeCard({ accent: "#DBFF00", lines: (filesRef.current[MAIN]?.text ?? "").split("\n"), title: MAIN });
          });
          break;
        case "setReadOnly":
          setReadOnly(message.value);
          break;
      }
    });
  }, []);

  useEffect(() => {
    consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
  }, [lines, pending]);

  const run = async () => {
    if (running) return;

    stopRef.current = false;
    setLines([]);
    setPending(undefined);
    if (turtleRef.current) turtleRef.current.innerHTML = "";
    setRunning(true);

    const size = turtleRef.current
      ? { height: turtleRef.current.clientHeight, width: turtleRef.current.clientWidth }
      : { height: 300, width: 400 };
    const texts: Record<string, string> = {};

    for (const [name, file] of Object.entries(filesRef.current)) {
      if (file.text !== undefined) texts[name] = file.text;
    }

    const error: RunError | undefined = await runPython(
      texts[MAIN] ?? "",
      {
        files: texts,
        input: (prompt) => new Promise((resolve) => setPending({ prompt, resolve })),
        // A file the program wrote shows up in the list and saves with the
        // project.
        onFileWrite: (name, text) => {
          setFiles((current) => ({ ...current, [name]: { text } }));
          changed();
        },
        output: (text) => append({ kind: "out", text }),
        turtleSize: size,
        turtleTarget: TURTLE_TARGET,
      },
      () => stopRef.current,
    );

    setPending(undefined);
    setRunning(false);

    if (!error) append({ kind: "info", text: "Finished." });
    else if (error.message === "Stopped") append({ kind: "info", text: "Stopped." });
    else
      append({
        kind: "error",
        text: error.line ? `${error.file ? `${error.file}, line` : "Line"} ${error.line}: ${error.message}` : error.message,
      });
  };

  const stop = () => {
    stopRef.current = true;
    // A program waiting on input() has nothing to suspend on, so answer it.
    pending?.resolve("");
    setPending(undefined);
  };

  const submitAnswer = () => {
    if (!pending) return;

    append({ kind: "out", text: `${pending.prompt}${answer}\n` });
    pending.resolve(answer);
    setPending(undefined);
    setAnswer("");
  };

  const addFile = () => {
    const name = window.prompt("File name, for example helpers.py or data.txt")?.trim();

    if (!name || files[name]) return;
    if (!isText(name)) {
      window.alert("Give it a .py, .txt, .csv, .json or .md name.");
      return;
    }

    update({ ...files, [name]: { text: "" } });
    setActive(name);
  };

  const renameFile = (name: string) => {
    const next = window.prompt("New name", name)?.trim();

    if (!next || next === name || files[next] || !isText(next)) return;

    const { [name]: file, ...rest } = files;

    update({ ...rest, [next]: file });
    if (active === name) setActive(next);
  };

  const deleteFile = (name: string) => {
    if (!window.confirm(`Delete ${name}?`)) return;

    const { [name]: _removed, ...rest } = files;

    update(rest);
    if (active === name) setActive(MAIN);
  };

  const activeFile = files[active];
  // A read-only single-file project needs no list.
  const showFiles = names.length > 1 || !readOnly;

  return (
    <div className={showFiles ? "layout with-files" : "layout"}>
      {showFiles && (
        <aside className="files">
          <div className="files-header">
            <span>Files</span>
            {!readOnly && (
              <button onClick={addFile} title="New file" type="button">
                +
              </button>
            )}
          </div>
          <ul>
            {names.map((name) => (
              <li className={name === active ? "active" : ""} key={name}>
                <button className="file-name" onClick={() => setActive(name)} type="button">
                  {name}
                </button>
                {!readOnly && name !== MAIN && (
                  <span className="file-actions">
                    <button onClick={() => renameFile(name)} title="Rename" type="button">
                      ✎
                    </button>
                    <button onClick={() => deleteFile(name)} title="Delete" type="button">
                      ×
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </aside>
      )}

      <main className="code">
        <div className="bar">
          <span className="filename">{active}</span>
          <span className="spacer" />
          {running ? (
            <button className="stop" onClick={stop} type="button">
              ■ Stop
            </button>
          ) : (
            <button className="run" onClick={() => void run()} title="Runs main.py" type="button">
              ▶ Run
            </button>
          )}
        </div>
        {activeFile?.text !== undefined ? (
          <CodeEditor
            key={`${generation}:${active}`}
            name={active}
            onChange={(text) => update({ ...filesRef.current, [active]: { text } })}
            readOnly={readOnly}
            value={activeFile.text}
          />
        ) : (
          <div className="binary">
            {active} · {Math.round((activeFile?.bytes?.byteLength ?? 0) / 1024)} KB, kept with the project
          </div>
        )}
      </main>

      <section className="output">
        <div className="turtle" id={TURTLE_TARGET} ref={turtleRef} />
        <div className="console" ref={consoleRef}>
          {lines.map((line) => (
            <span className={line.kind} key={line.id}>
              {line.text}
            </span>
          ))}
          {pending && (
            <form
              className="prompt"
              onSubmit={(e) => {
                e.preventDefault();
                submitAnswer();
              }}
            >
              <span>{pending.prompt}</span>
              <input autoFocus onChange={(e) => setAnswer(e.target.value)} value={answer} />
            </form>
          )}
          {lines.length === 0 && !pending && <span className="info">Press Run to see what your program does.</span>}
        </div>
      </section>
    </div>
  );
};

createRoot(document.getElementById("app")!).render(<PythonEditor />);
