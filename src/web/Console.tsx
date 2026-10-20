import { useCallback, useEffect, useRef, useState } from "react";

// What public/preview/console.js sends for each value logged: its one-line
// look, and for objects, arrays, Maps, Sets and page elements what is inside
// (copied when it was logged, a few levels deep).
export type Value = {
  entries?: [string, Value][];
  kind: "element" | "error" | "function" | "object" | "plain" | "string";
  size?: number;
  stack?: string;
  text: string;
};

type Table = { columns: string[]; rows: { cells: Record<string, string>; index: string }[] };

export type ConsoleLine = {
  file?: string;
  // A console.group line: "open" or "closed" to begin with.
  group?: "closed" | "open";
  id: number;
  level: string;
  line?: number;
  // The groups this line is in, outermost first.
  parents: number[];
  table?: Table;
  text?: string;
  values?: Value[];
};

const CAP = 500;

// The console's lines. Output arrives one message per line; lines are batched
// into one render a frame or so.
export const useConsole = () => {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const pending = useRef<ConsoleLine[]>([]);
  const flushTimer = useRef<number>();
  const lastId = useRef(0);
  // The groups open now, outermost first.
  const groups = useRef<number[]>([]);
  // Lines cleared since the last render are not shown when it comes.
  const clearedAt = useRef(0);

  useEffect(() => () => window.clearTimeout(flushTimer.current), []);

  const add = useCallback((line: Omit<ConsoleLine, "id" | "parents">) => {
    const id = (lastId.current += 1);

    pending.current.push({ ...line, id, parents: [...groups.current] });
    if (line.group) groups.current.push(id);
    if (flushTimer.current !== undefined) return;

    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = undefined;

      const batch = pending.current;
      const from = clearedAt.current;

      pending.current = [];
      setLines((current) => [...current, ...batch].filter((l) => l.id > from).slice(-CAP));
    }, 16);
  }, []);

  const clear = useCallback(() => {
    clearedAt.current = lastId.current;
    groups.current = [];
    pending.current = [];
    setLines([]);
  }, []);

  // A line the editor itself says (a notice, what the kid typed).
  const say = useCallback((level: string, text: string) => add({ level, text }), [add]);

  // A message from console.js.
  const receive = useCallback(
    (data: Record<string, unknown>) => {
      if (data.clear) {
        clear();
        add({ level: "hint", text: "Console was cleared" });
        return;
      }
      if (data.group === "end") {
        groups.current.pop();
        return;
      }

      add({
        file: typeof data.file === "string" ? data.file : undefined,
        group: data.group === "open" || data.group === "closed" ? data.group : undefined,
        level: String(data.level),
        line: typeof data.line === "number" && data.line > 0 ? data.line : undefined,
        table: (data.table as Table | undefined) ?? undefined,
        // A page from before this change sends text.
        text: typeof data.text === "string" ? data.text : undefined,
        values: Array.isArray(data.values) ? (data.values as Value[]) : undefined,
      });
    },
    [add, clear],
  );

  return { clear, lines, receive, say };
};

// One value, opened up with a click when there is something inside.
const ValueView = ({ nested, value }: { nested: boolean; value: Value }) => {
  const [open, setOpen] = useState(false);
  const inside = value.entries ?? [];
  const more = (value.size ?? inside.length) - inside.length;
  const canOpen = inside.length > 0 || Boolean(value.stack);
  const shown = value.kind === "string" && nested ? JSON.stringify(value.text) : value.text;

  if (!canOpen) return <span className={`value ${value.kind}`}>{shown}</span>;

  return (
    <span className="value-tree">
      <button aria-expanded={open} className={`value ${value.kind} opener`} onClick={() => setOpen(!open)} type="button">
        <span className="caret">{open ? "▾" : "▸"}</span>
        {shown}
      </button>
      {open && value.stack && <pre className="value-stack">{value.stack}</pre>}
      {open && inside.length > 0 && (
        <span className="value-entries">
          {inside.map(([key, item], index) => (
            <span className="value-entry" key={index}>
              {key !== "" && <span className="value-key">{key}: </span>}
              <ValueView nested value={item} />
            </span>
          ))}
          {more > 0 && <span className="value-more">… {more} more</span>}
        </span>
      )}
    </span>
  );
};

const TableView = ({ table }: { table: Table }) => (
  <div className="console-table">
    <table>
      <thead>
        <tr>
          <th>(index)</th>
          {table.columns.map((column) => (
            <th key={column}>{column === "" ? "Value" : column}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row) => (
          <tr key={row.index}>
            <td>{row.index}</td>
            {table.columns.map((column) => (
              <td key={column}>{row.cells[column] ?? ""}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

type Props = {
  lines: ConsoleLine[];
  // Shows a file of the site at a line, when the file is the kid's.
  onJump: (file: string, line: number) => void;
  hasFile: (file: string) => boolean;
};

export const ConsoleLines = ({ hasFile, lines, onJump }: Props) => {
  // Groups the kid closed (or that began closed) and opened again.
  const [toggled, setToggled] = useState<Set<number>>(new Set());
  const ref = useRef<HTMLDivElement>(null);
  const closed = (line: ConsoleLine) => (line.group === "closed") !== toggled.has(line.id);
  const closedIds = new Set(lines.filter((line) => line.group && closed(line)).map((line) => line.id));

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines]);

  const toggle = (id: number) =>
    setToggled((current) => {
      const next = new Set(current);

      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="console-lines" ref={ref}>
      {lines.length === 0 && <span className="console-hint">console.log and errors from your page show here.</span>}
      {lines.map((line) => {
        if (line.parents.some((id) => closedIds.has(id))) return null;

        const body = line.values ? (
          line.values.map((value, index) => (
            <span key={index}>
              {index > 0 && " "}
              <ValueView nested={false} value={value} />
            </span>
          ))
        ) : (
          line.text
        );

        return (
          <div className={`console-line ${line.level}`} key={line.id} style={{ paddingLeft: line.parents.length * 14 }}>
            <span className="console-body">
              {line.group ? (
                <button aria-expanded={!closed(line)} className="group-opener" onClick={() => toggle(line.id)} type="button">
                  <span className="caret">{closed(line) ? "▸" : "▾"}</span>
                  {line.values?.map((value) => value.text).join(" ") ?? line.text}
                </button>
              ) : (
                body
              )}
              {line.table && <TableView table={line.table} />}
            </span>
            {line.file &&
              (hasFile(line.file) && line.line ? (
                <button className="console-where" onClick={() => onJump(line.file!, line.line!)} title="Show this line" type="button">
                  {line.file}:{line.line}
                </button>
              ) : (
                <span className="console-where" title={line.file}>
                  {line.file}
                  {line.line ? `:${line.line}` : ""}
                </span>
              ))}
          </div>
        );
      })}
    </div>
  );
};
