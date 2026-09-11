// The parts of Skulpt's global this editor touches.
declare const Sk: {
  TurtleGraphics?: { height: number; target: string; width: number };
  builtinFiles?: { files: Record<string, string> };
  inBrowser?: boolean;
  configure: (options: Record<string, unknown>) => void;
  importMainWithBody: (name: string, dumpJS: boolean, body: string, canSuspend: boolean) => unknown;
  misceval: {
    asyncToPromise: (fn: () => unknown, handlers?: Record<string, () => void>) => Promise<unknown>;
  };
  python3: unknown;
};
