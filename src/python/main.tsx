import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { answerSnapshot, listenToPage, postToPage } from "../bridge";
import { codeCard, pictureOf } from "../snapshot";
import { CodeEditor } from "../web/CodeEditor";
import { Engine, engineFor } from "./engine";
import { pressKey, showWindow } from "./full/camera";
import { AiAccess, runFullPython, stopFullPython, warmUpFullPython } from "./full/client";
import { runGame, stopGame, warmUpGame } from "./game/engine";
import { bytesOf, fromBytes, isText, MAIN, PythonFiles, starterFiles, toBlob } from "./project";
import { RunError, runPython } from "./runner";
import { syncReady } from "./syncio";
import { useImageUrl } from "./useImageUrl";
import "./python.css";

const SIZE_LIMIT = 20 * 1024 * 1024;
const CHANGED_THROTTLE_MS = 1000;
const TURTLE_TARGET = "turtle";
// A runaway loop would otherwise grow the console without end.
const CONSOLE_CAP = 2000;

type Line = { id: number; kind: "error" | "info" | "out"; text: string } | { id: number; kind: "image"; url: string };
type NewLine = Line extends infer L ? (L extends Line ? Omit<L, "id"> : never) : never;
type Pending = { prompt: string; resolve: (value: string) => void };

const TRIMMED: NewLine = { kind: "info", text: "… earlier output trimmed …\n" };
// Output arrives a line at a time; the console redraws at most this often.
const FLUSH_MS = 30;
const IMAGE_TYPES: Record<string, string> = {
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

const imageType = (name: string) => IMAGE_TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()];

// A name a file can have in the project: a path inside it, never outside.
const isProjectPath = (name: string) =>
  name !== "" && !name.startsWith("/") && !name.split("/").some((part) => part === "" || part === "." || part === "..");

const asFile = (name: string, bytes: Uint8Array) =>
  isText(name) ? { text: new TextDecoder().decode(bytes) } : { bytes };

const fileBytes = (file: PythonFiles[string]) => file.bytes ?? new TextEncoder().encode(file.text ?? "");

const PythonEditor = () => {
  const [files, setFiles] = useState<PythonFiles>(starterFiles);
  const [active, setActive] = useState(MAIN);
  const [generation, setGeneration] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [pending, setPending] = useState<Pending>();
  const [readOnly, setReadOnly] = useState(false);
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState("");
  // The engine of the last Run, which decides what the top of the output
  // shows: turtle's drawing, a game, or nothing (real Python draws charts
  // into the console).
  const [runEngine, setRunEngine] = useState<Engine>();
  // Whether a program's cv2.imshow window is up.
  const [windowOpen, setWindowOpen] = useState(false);

  const filesRef = useRef(files);
  const lastChangedAt = useRef(0);
  const stopRef = useRef(false);
  const engineRef = useRef<Engine>("skulpt");
  const aiRef = useRef<AiAccess>();
  const gameRef = useRef<HTMLCanvasElement>(null);
  const windowRef = useRef<HTMLCanvasElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const turtleRef = useRef<HTMLDivElement>(null);
  const consoleRef = useRef<HTMLDivElement>(null);

  filesRef.current = files;

  // main.py first, then the rest by name.
  const names = useMemo(
    () => Object.keys(files).sort((a, b) => (a === MAIN ? -1 : b === MAIN ? 1 : a.localeCompare(b))),
    [files],
  );

  const lineId = useRef(0);
  const queued = useRef<Line[]>([]);
  const flushTimer = useRef<number>();
  const imageUrls = useRef<string[]>([]);

  // Lines wait a moment and go in together, so a program printing in a loop
  // redraws the console a few times a second rather than once per line. Past
  // the cap the console drops down to half.
  const flush = useCallback(() => {
    flushTimer.current = undefined;

    const incoming = queued.current;

    queued.current = [];
    setLines((current) => {
      const next = [...current, ...incoming];

      return next.length <= CONSOLE_CAP
        ? next
        : [{ ...TRIMMED, id: (lineId.current += 1) }, ...next.slice(-(CONSOLE_CAP / 2))];
    });
  }, []);

  const append = useCallback(
    (line: NewLine) => {
      queued.current.push({ ...line, id: (lineId.current += 1) } as Line);
      flushTimer.current ??= window.setTimeout(flush, FLUSH_MS);
    },
    [flush],
  );

  const clearLines = useCallback(() => {
    window.clearTimeout(flushTimer.current);
    flushTimer.current = undefined;
    queued.current = [];
    imageUrls.current.forEach((url) => URL.revokeObjectURL(url));
    imageUrls.current = [];
    setLines([]);
  }, []);

  const appendImage = useCallback(
    (bytes: Uint8Array) => {
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));

      imageUrls.current.push(url);
      append({ kind: "image", url });
    },
    [append],
  );

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
    // Registered early, so the service worker real Python's input() needs
    // controls the page by the time a program runs.
    void syncReady();
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
            clearLines();
            setRunEngine(undefined);
            if (engineFor(next) === "full") warmUpFullPython();
            if (engineFor(next) === "game") warmUpGame();
            if (message.readOnly !== undefined) setReadOnly(message.readOnly);
            if (message.ai) aiRef.current = message.ai;
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
            const game = gameRef.current;
            const shown = [...(consoleRef.current?.querySelectorAll("img") ?? [])].at(-1);

            // Skulpt stacks a canvas per layer; together they are the
            // drawing. Else the last chart or image the program showed; a
            // program that showed nothing shows its code instead.
            if (game && game.width > 0 && engineRef.current === "game")
              return pictureOf([{ height: game.height, source: game, width: game.width }]);
            if (drawn.length > 0)
              return pictureOf(drawn.map((canvas) => ({ height: canvas.height, source: canvas, width: canvas.width })));
            if (shown?.naturalWidth)
              return pictureOf([{ height: shown.naturalHeight, source: shown, width: shown.naturalWidth }]);

            return codeCard({ accent: "#DBFF00", lines: (filesRef.current[MAIN]?.text ?? "").split("\n"), title: MAIN });
          });
          break;
        case "setAi":
          aiRef.current = message.ai;
          break;
        case "setReadOnly":
          setReadOnly(message.value);
          break;
      }
    });
  }, [clearLines]);

  useEffect(() => {
    consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
  }, [lines, pending]);

  const report = (error: RunError | undefined) => {
    if (!error) append({ kind: "info", text: "Finished." });
    else if (error.message === "Stopped") append({ kind: "info", text: "Stopped." });
    else
      append({
        kind: "error",
        text: error.line ? `${error.file ? `${error.file}, line` : "Line"} ${error.line}: ${error.message}` : error.message,
      });
  };

  // What a program changed in its folder becomes part of the project; the
  // editor reopens the open file if the program rewrote it.
  const takeChanges = (changes: Record<string, Uint8Array>, deleted: string[]) => {
    const names = Object.keys(changes);

    if (names.length === 0 && deleted.length === 0) return;

    const next = { ...filesRef.current };

    for (const name of names) next[name] = asFile(name, changes[name]);
    for (const name of deleted) if (name !== MAIN) delete next[name];

    update(next);
    if (names.includes(active)) setGeneration((i) => i + 1);
    if (deleted.includes(active) && active !== MAIN) setActive(MAIN);
  };

  const ask = (prompt: string) => new Promise<string>((resolve) => setPending({ prompt, resolve }));

  const runFull = async () => {
    const bytes: Record<string, Uint8Array> = {};

    for (const [name, file] of Object.entries(filesRef.current)) bytes[name] = fileBytes(file);

    const result = await runFullPython(
      bytes,
      {
        image: appendImage,
        input: ask,
        output: (text, kind) => append({ kind, text }),
        window: (picture) => {
          const canvas = windowRef.current;

          // The first picture takes the keys, so "press q to quit" works
          // without a click on the window first.
          if (picture && canvas && canvas.width === 0) canvas.focus();
          setWindowOpen(!!picture);
          if (picture && canvas) showWindow(canvas, picture.bytes, picture.width, picture.height);
        },
      },
      aiRef.current,
    );

    takeChanges(result.changed, result.deleted);

    return result.error;
  };

  const runPygameZero = async () => {
    const bytes: Record<string, Uint8Array> = {};

    for (const [name, file] of Object.entries(filesRef.current)) bytes[name] = fileBytes(file);

    if (!gameRef.current) return { message: "The game area is missing." };

    const result = await runGame(bytes, gameRef.current, { output: (text, kind) => append({ kind, text }) });

    return result.error;
  };

  const runSkulpt = () => {
    const size = turtleRef.current
      ? { height: turtleRef.current.clientHeight, width: turtleRef.current.clientWidth }
      : { height: 300, width: 400 };
    const texts: Record<string, string> = {};

    for (const [name, file] of Object.entries(filesRef.current)) {
      if (file.text !== undefined) texts[name] = file.text;
    }

    return runPython(
      texts[MAIN] ?? "",
      {
        files: texts,
        input: ask,
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
  };

  const run = async () => {
    if (running) return;

    const engine = engineFor(filesRef.current);

    stopRef.current = false;
    engineRef.current = engine;
    setRunEngine(engine);
    clearLines();
    setPending(undefined);
    setWindowOpen(false);
    if (windowRef.current) windowRef.current.width = 0;
    if (turtleRef.current) turtleRef.current.innerHTML = "";
    setRunning(true);

    const error =
      engine === "pygame"
        ? {
            message:
              "This program uses pygame on its own. CodeyKids runs Pygame Zero games: start with `import pgzrun` and end with `pgzrun.go()`.",
          }
        : engine === "game"
          ? await runPygameZero()
          : engine === "full"
            ? await runFull()
            : await runSkulpt();

    setPending(undefined);
    setRunning(false);
    // Stop answers a waiting input() with "", so int(input()) fails after
    // the kid pressed Stop: that is the stop, not an error in their code.
    report(stopRef.current ? { message: "Stopped" } : error);
  };

  const stop = () => {
    stopRef.current = true;
    if (engineRef.current === "full") stopFullPython();
    if (engineRef.current === "game") stopGame();
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
    const next = window.prompt("New name, for example images/cat.png", name)?.trim();

    if (!next || next === name || files[next] || !isProjectPath(next)) return;
    // A text file stays a kind the editor can open; a picture or sound can
    // move into a folder under any name.
    if (files[name].text !== undefined && !isText(next)) return;

    const { [name]: file, ...rest } = files;

    update({ ...rest, [next]: file });
    if (active === name) setActive(next);
  };

  // Pictures, sounds and data from the kid's computer, for programs that open
  // them (Image.open("photo.jpg"), a game's images/ folder).
  const addFromComputer = async (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;

    const next = { ...filesRef.current };

    for (const file of [...picked]) {
      if (next[file.name] && !window.confirm(`Replace ${file.name}?`)) continue;

      next[file.name] = asFile(file.name, new Uint8Array(await file.arrayBuffer()));
    }

    if (bytesOf(next) > SIZE_LIMIT) {
      window.alert("That would take the project over 20 MB.");
      return;
    }

    update(next);
  };

  const deleteFile = (name: string) => {
    if (!window.confirm(`Delete ${name}?`)) return;

    const { [name]: _removed, ...rest } = files;

    update(rest);
    if (active === name) setActive(MAIN);
  };

  const projectEngine = useMemo(() => engineFor(files), [files]);
  const shownEngine = runEngine ?? projectEngine;
  const activeFile = files[active];
  const activePreview = useImageUrl(activeFile?.bytes, imageType(active));
  // A read-only single-file project needs no list.
  const showFiles = names.length > 1 || !readOnly;

  return (
    <div className={showFiles ? "layout with-files" : "layout"}>
      {showFiles && (
        <aside className="files">
          <div className="files-header">
            <span>Files</span>
            {!readOnly && (
              <span className="files-buttons">
                <button onClick={addFile} title="New file" type="button">
                  +
                </button>
                <button onClick={() => uploadRef.current?.click()} title="Add files from your computer" type="button">
                  ⇪
                </button>
                <input
                  hidden
                  multiple
                  onChange={(e) => {
                    void addFromComputer(e.target.files);
                    e.target.value = "";
                  }}
                  ref={uploadRef}
                  type="file"
                />
              </span>
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
            {activePreview && <img alt={active} src={activePreview} />}
            <span>
              {active} · {Math.round((activeFile?.bytes?.byteLength ?? 0) / 1024)} KB, kept with the project
            </span>
          </div>
        )}
      </main>

      <section className={`output ${shownEngine}${windowOpen ? " window-open" : ""}`}>
        <div className="turtle" id={TURTLE_TARGET} ref={turtleRef} />
        <div className="game">
          {/* pygame draws here; tabIndex lets it take the keys. */}
          <canvas id="canvas" ref={gameRef} tabIndex={0} />
        </div>
        <div className="window">
          {/* cv2.imshow draws here; cv2.waitKey reads the keys pressed on it. */}
          <canvas onKeyDown={(e) => pressKey(e.key)} ref={windowRef} tabIndex={0} />
        </div>
        <div className="console" ref={consoleRef}>
          {lines.map((line) =>
            line.kind === "image" ? (
              <img alt="" className="figure" key={line.id} src={line.url} />
            ) : (
              <span className={line.kind} key={line.id}>
                {line.text}
              </span>
            ),
          )}
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
