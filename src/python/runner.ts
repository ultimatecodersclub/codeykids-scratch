// Runs a kid's program in Skulpt: prints go to `output`, input() asks the page
// for a line, turtle draws into the element named `turtleTarget`, and Stop
// cancels at the next loop iteration or turtle move.

export type RunHandlers = {
  input: (prompt: string) => Promise<string>;
  output: (text: string) => void;
  turtleTarget: string;
  turtleSize: { height: number; width: number };
};

export type RunError = { line?: number; message: string };

const builtinRead = (name: string) => {
  const files = Sk.builtinFiles?.files;

  if (!files || files[name] === undefined) throw new Error(`File not found: '${name}'`);

  return files[name];
};

const describe = (error: unknown): RunError => {
  const e = error as { args?: { v?: { v?: string }[] }; traceback?: { lineno?: number }[]; tp$name?: string };
  const message = e.tp$name && e.args?.v?.[0]?.v !== undefined ? `${e.tp$name}: ${e.args.v[0].v}` : String(error);

  return { line: e.traceback?.[0]?.lineno, message };
};

export const runPython = (code: string, handlers: RunHandlers, stopped: () => boolean) => {
  Sk.configure({
    __future__: Sk.python3,
    inputfun: handlers.input,
    inputfunTakesPrompt: true,
    killableFor: true,
    killableWhile: true,
    output: handlers.output,
    read: builtinRead,
    yieldLimit: 100,
  });
  Sk.TurtleGraphics = { target: handlers.turtleTarget, ...handlers.turtleSize };

  return Sk.misceval
    .asyncToPromise(() => Sk.importMainWithBody("<stdin>", false, code, true), {
      // Every suspension passes here: loops, sleeps, turtle moves, input.
      "*": () => {
        if (stopped()) throw new Error("Stopped");
      },
    })
    .then(
      () => undefined,
      (error: unknown) => (error instanceof Error && error.message === "Stopped" ? { message: "Stopped" } : describe(error)),
    );
};
