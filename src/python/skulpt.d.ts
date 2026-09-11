// The parts of Skulpt's global this editor touches.
declare const Sk: {
  TurtleGraphics?: { height: number; target: string; width: number };
  builtin: {
    IOError: new (message: string) => unknown;
    open: (filename: { v: string }, mode?: { v: string }, bufsize?: unknown) => unknown;
  };
  builtinFiles?: { files: Record<string, string> };
  builtins: Record<string, unknown>;
  configure: (options: Record<string, unknown>) => void;
  importMainWithBody: (name: string, dumpJS: boolean, body: string, canSuspend: boolean) => unknown;
  inBrowser?: boolean;
  misceval: {
    asyncToPromise: (fn: () => unknown, handlers?: Record<string, () => void>) => Promise<unknown>;
  };
  python3: unknown;
};
