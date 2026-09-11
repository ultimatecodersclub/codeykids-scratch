import { strFromU8, unzipSync } from "fflate";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { listenToPage, postToPage } from "../bridge";
import { CodeEditor } from "../web/CodeEditor";
import { RunError, runPython } from "./runner";
import "./python.css";

const SIZE_LIMIT = 20 * 1024 * 1024;
const CHANGED_THROTTLE_MS = 1000;
const TURTLE_TARGET = "turtle";
// A runaway loop would otherwise grow the console without end.
const CONSOLE_CAP = 2000;
const TRIMMED: Line = { kind: "info", text: "… earlier output trimmed …\n" };

const STARTER = `# Write your Python here, then press Run.
name = input("What is your name? ")
print("Hello, " + name + "!")
`;

type Line = { kind: "error" | "info" | "out"; text: string };
type Pending = { prompt: string; resolve: (value: string) => void };

// A zip from elsewhere: take main.py, else the first .py file.
const codeFromZip = (bytes: Uint8Array) => {
  const entries = unzipSync(bytes);
  const name = entries["main.py"] ? "main.py" : Object.keys(entries).find((n) => n.endsWith(".py"));

  return name ? strFromU8(entries[name]) : "";
};

const PythonEditor = () => {
  const [code, setCode] = useState(STARTER);
  const [generation, setGeneration] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [pending, setPending] = useState<Pending>();
  const [readOnly, setReadOnly] = useState(false);
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState("");

  const codeRef = useRef(code);
  const lastChangedAt = useRef(0);
  const stopRef = useRef(false);
  const turtleRef = useRef<HTMLDivElement>(null);
  const consoleRef = useRef<HTMLDivElement>(null);

  codeRef.current = code;

  const append = useCallback(
    (line: Line) =>
      setLines((current) =>
        current.length < CONSOLE_CAP
          ? [...current, line]
          : [TRIMMED, ...current.slice(current.length - CONSOLE_CAP + 2), line],
      ),
    [],
  );

  const onChange = useCallback((text: string) => {
    setCode(text);

    const now = Date.now();
    if (now - lastChangedAt.current < CHANGED_THROTTLE_MS) return;

    lastChangedAt.current = now;
    postToPage({ type: "changed" });
  }, []);

  useEffect(() => {
    postToPage({ type: "ready" });

    return listenToPage(async (message) => {
      switch (message.type) {
        case "load":
          try {
            const blob = message.file ?? (message.url ? await (await fetch(message.url)).blob() : undefined);
            let text = STARTER;

            if (blob) {
              const bytes = new Uint8Array(await blob.arrayBuffer());
              // A zip starts with "PK".
              text = bytes[0] === 0x50 && bytes[1] === 0x4b ? codeFromZip(bytes) : strFromU8(bytes);
            }

            setCode(text);
            setGeneration((i) => i + 1);
            setLines([]);
            if (message.readOnly !== undefined) setReadOnly(message.readOnly);
            postToPage({ type: "loaded" });
          } catch (error) {
            postToPage({ message: String(error), type: "loadFailed" });
          }
          break;
        case "save": {
          const file = new Blob([codeRef.current], { type: "text/x-python" });

          if (file.size > SIZE_LIMIT) {
            postToPage({ message: "The program is over 20 MB.", requestId: message.requestId, type: "saveFailed" });
            break;
          }

          postToPage({ file, requestId: message.requestId, type: "saved" });
          break;
        }
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

    const error: RunError | undefined = await runPython(
      codeRef.current,
      {
        input: (prompt) => new Promise((resolve) => setPending({ prompt, resolve })),
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
    else append({ kind: "error", text: error.line ? `Line ${error.line}: ${error.message}` : error.message });
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

  return (
    <div className="layout">
      <main className="code">
        <div className="bar">
          <span className="filename">main.py</span>
          <span className="spacer" />
          {running ? (
            <button className="stop" onClick={stop} type="button">■ Stop</button>
          ) : (
            <button className="run" onClick={() => void run()} type="button">▶ Run</button>
          )}
        </div>
        <CodeEditor key={generation} name="main.py" onChange={onChange} readOnly={readOnly} value={code} />
      </main>

      <section className="output">
        <div className="turtle" id={TURTLE_TARGET} ref={turtleRef} />
        <div className="console" ref={consoleRef}>
          {lines.map((line, i) => (
            <span className={line.kind} key={i}>{line.text}</span>
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
