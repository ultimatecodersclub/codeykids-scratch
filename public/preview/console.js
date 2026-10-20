// The console a browser's DevTools would give a kid's page, shown in the
// editor's console pane instead: every console method, values the kid can
// open up (objects, arrays, Maps, page elements), tables, timers, groups, and
// errors with the file and line they came from. Used by the preview host's
// prelude and by the built page the editor falls back to, so both behave the
// same. Sets window.__CODEYKIDS_CONSOLE__, which the prelude calls and
// removes:
//   install({ post, place, page })
// post(message) sends a message to the editor; place(url, line, fromStack)
// names the kid's file and line for a script address and line (null when
// unknown); fromStack is true for a line read from a stack trace, which in a
// script inlined into a page counts from the script's start, not the page's;
// page is the page's own name, for errors with no file.
window.__CODEYKIDS_CONSOLE__ = ({ post, place, page }) => {
  const DEPTH = 4;
  const ENTRIES = 100;
  const BUDGET = 2000;
  const PREVIEW = 100;

  const native = {};

  for (const name of Object.keys(console)) {
    if (typeof console[name] === "function") native[name] = console[name].bind(console);
  }

  const kindOf = (value) => Object.prototype.toString.call(value).slice(8, -1);
  const isElement = (value) => typeof Node !== "undefined" && value instanceof Node;
  const quoted = (text) => JSON.stringify(text);
  const functionLabel = (fn) => {
    const source = Function.prototype.toString.call(fn);

    if (source.startsWith("class")) return `class ${fn.name || ""}`.trim();

    return `ƒ ${fn.name || ""}()`;
  };
  const tagOf = (element) => {
    if (element.nodeType === 3) return quoted(element.textContent);
    if (element.nodeType === 9) return "#document";
    if (element.nodeType !== 1) return element.nodeName;

    const attributes = Array.from(element.attributes)
      .map((a) => (a.value === "" ? ` ${a.name}` : ` ${a.name}="${a.value}"`))
      .join("");

    return `<${element.localName}${attributes}>`;
  };

  // A short one-line look at a value, as DevTools shows it closed.
  const preview = (value, depth) => {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "string") return depth === 0 ? value : quoted(value);
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "symbol" || typeof value !== "object" && typeof value !== "function") return String(value);
    if (typeof value === "function") return functionLabel(value);
    if (isElement(value)) return tagOf(value);
    if (value instanceof Error) return `${value.name}: ${value.message}`;

    const kind = kindOf(value);

    if (kind === "Date") return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toString();
    if (kind === "RegExp") return String(value);
    if (kind === "Promise") return "Promise";
    if (depth > 1) return Array.isArray(value) ? `Array(${value.length})` : kind === "Object" ? "{…}" : kind;

    const parts = [];
    let text = "";
    const add = (part) => {
      parts.push(part);
      text = parts.join(", ");
    };

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length && text.length < PREVIEW; i += 1) add(preview(value[i], depth + 1));

      return `${value.length > 1 || depth > 0 ? `(${value.length}) ` : ""}[${text}${parts.length < value.length ? ", …" : ""}]`;
    }
    if (value instanceof Map) {
      for (const [k, v] of value) {
        if (text.length >= PREVIEW) break;
        add(`${preview(k, depth + 1)} => ${preview(v, depth + 1)}`);
      }

      return `Map(${value.size}) {${text}${parts.length < value.size ? ", …" : ""}}`;
    }
    if (value instanceof Set) {
      for (const v of value) {
        if (text.length >= PREVIEW) break;
        add(preview(v, depth + 1));
      }

      return `Set(${value.size}) {${text}${parts.length < value.size ? ", …" : ""}}`;
    }

    let keys = [];

    try {
      keys = Object.keys(value);
    } catch (error) {
      keys = [];
    }
    for (const key of keys) {
      if (text.length >= PREVIEW) break;
      try {
        add(`${key}: ${preview(value[key], depth + 1)}`);
      } catch (error) {
        add(`${key}: (can't read)`);
      }
    }

    const name = kind === "Object" ? "" : `${kind} `;

    return `${name}{${text}${parts.length < keys.length ? ", …" : ""}}`;
  };

  // A value the editor can show and open up, copied now: a later change to
  // the object doesn't change what was logged. Open-able levels go DEPTH
  // deep, ENTRIES per level, BUDGET in all, so a huge object stays quick.
  const describe = (value, depth, budget, seen) => {
    const shown = preview(value, 0);

    if (value === null || typeof value !== "object" && typeof value !== "function") {
      return { kind: typeof value === "string" ? "string" : "plain", text: shown };
    }
    if (typeof value === "function") return { kind: "function", text: shown };
    if (value instanceof Error) {
      return { kind: "error", stack: typeof value.stack === "string" ? value.stack : undefined, text: shown };
    }

    const node = { kind: isElement(value) ? "element" : "object", text: shown };

    if (depth >= DEPTH || seen.has(value)) return node;

    const entries = [];
    const push = (key, item) => {
      if (budget.left <= 0) return false;
      budget.left -= 1;
      entries.push([key, describe(item, depth + 1, budget, seen)]);
      return entries.length < ENTRIES;
    };

    seen.add(value);
    try {
      if (isElement(value)) {
        for (const child of value.childNodes) {
          if (child.nodeType === 3 && child.textContent.trim() === "") continue;
          if (child.nodeType === 8) continue;
          if (!push("", child)) break;
        }
        node.size = value.childNodes.length;
      } else if (value instanceof Map) {
        let i = 0;

        for (const [k, v] of value) {
          if (!push(`${preview(k, 1)} =>`, v)) break;
          i += 1;
        }
        node.size = value.size;
      } else if (value instanceof Set) {
        let i = 0;

        for (const v of value) {
          if (!push(String(i), v)) break;
          i += 1;
        }
        node.size = value.size;
      } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
          if (!push(String(i), value[i])) break;
        }
        node.size = value.length;
      } else {
        const keys = Object.keys(value);

        for (const key of keys) {
          let item;

          try {
            item = value[key];
          } catch (error) {
            item = "(can't read)";
          }
          if (!push(key, item)) break;
        }
        node.size = keys.length;
      }
    } catch (error) {
      // An object that refuses to be read stays closed.
    }
    seen.delete(value);
    node.entries = entries;

    return node;
  };

  const values = (args) => {
    const budget = { left: BUDGET };

    return args.map((arg) => describe(arg, 0, budget, new Set()));
  };

  // "%s", "%d", "%o" and the like in a first string are filled from the
  // values after it; "%c" styles are dropped (the pane has its own colours).
  const formatted = (args) => {
    if (typeof args[0] !== "string" || !args[0].includes("%")) return args;

    const rest = args.slice(1);
    const text = args[0].replace(/%([sdifoOc%])/g, (match, letter) => {
      if (letter === "%") return "%";
      if (rest.length === 0) return match;

      const value = rest.shift();

      if (letter === "c") return "";
      if (letter === "d" || letter === "i") return String(parseInt(value, 10));
      if (letter === "f") return String(parseFloat(value));
      if (letter === "s") return typeof value === "string" ? value : preview(value, 1);

      return preview(value, 1);
    });

    return [text, ...rest];
  };

  // Where a console call was made: the first frame of the stack that is the
  // kid's, not the console's own.
  const caller = () => {
    const stack = new Error().stack || "";

    for (const line of stack.split("\n").slice(1)) {
      if (line.includes("__codeykids__")) continue;

      // "at f (https://…/app.js:3:5)" in Chrome, "f@https://…/app.js:3:5"
      // in Firefox and Safari.
      const match = /([^\s()@]+):(\d+):(\d+)\)?\s*$/.exec(line);

      if (match) return place(match[1], Number(match[2]), true);
    }

    return null;
  };

  const send = (level, args, extra) => {
    const where = extra && "where" in extra ? extra.where : caller();
    const message = Object.assign({ level, type: "preview:console", values: values(formatted(args)) }, extra || {});

    delete message.where;
    if (where) Object.assign(message, where);
    post(message);
  };

  const wrap = (name, run) => {
    console[name] = (...args) => {
      if (native[name]) native[name](...args);
      run(...args);
    };
  };

  for (const level of ["log", "info", "warn", "error", "debug"]) wrap(level, (...args) => send(level, args));
  wrap("dir", (value) => send("log", [value]));
  wrap("dirxml", (...args) => send("log", args));
  wrap("trace", (...args) => {
    const stack = (new Error().stack || "").split("\n").slice(2).join("\n");

    send("log", [args.length ? formatted(args).map((arg) => preview(arg, 0)).join(" ") : "console.trace()", stack]);
  });
  wrap("assert", (condition, ...args) => {
    if (!condition) send("error", ["Assertion failed:", ...(args.length ? args : ["console.assert"])]);
  });

  const counts = new Map();

  wrap("count", (label = "default") => {
    const count = (counts.get(String(label)) || 0) + 1;

    counts.set(String(label), count);
    send("log", [`${label}: ${count}`]);
  });
  wrap("countReset", (label = "default") => counts.delete(String(label)));

  const timers = new Map();
  const elapsed = (label) => `${label}: ${(performance.now() - timers.get(label)).toFixed(3)} ms`;

  wrap("time", (label = "default") => {
    const name = String(label);

    if (timers.has(name)) send("warn", [`Timer "${name}" already exists`]);
    else timers.set(name, performance.now());
  });
  wrap("timeLog", (label = "default", ...args) => {
    const name = String(label);

    if (!timers.has(name)) send("warn", [`Timer "${name}" does not exist`]);
    else send("log", [elapsed(name), ...args]);
  });
  wrap("timeEnd", (label = "default") => {
    const name = String(label);

    if (!timers.has(name)) {
      send("warn", [`Timer "${name}" does not exist`]);
      return;
    }
    send("log", [elapsed(name)]);
    timers.delete(name);
  });

  wrap("group", (...args) => send("log", args.length ? args : ["console.group"], { group: "open" }));
  wrap("groupCollapsed", (...args) => send("log", args.length ? args : ["console.group"], { group: "closed" }));
  wrap("groupEnd", () => post({ group: "end", type: "preview:console" }));
  wrap("clear", () => post({ clear: true, type: "preview:console" }));

  // A table of an array or object: a row for each item, a column for each
  // key the items have (or the columns asked for), "Value" for plain items.
  wrap("table", (data, columns) => {
    if (data === null || typeof data !== "object") {
      send("log", [data]);
      return;
    }

    const rows = [];
    const keys = [];
    let plain = false;
    const entries = data instanceof Map ? Array.from(data.entries()) : Object.entries(data);

    for (const [index, item] of entries.slice(0, ENTRIES)) {
      const cells = {};

      if (item !== null && typeof item === "object") {
        for (const key of Object.keys(item)) {
          if (!keys.includes(key)) keys.push(key);
          cells[key] = preview(item[key], 1);
        }
      } else {
        plain = true;
        cells[""] = preview(item, 1);
      }
      rows.push({ cells, index: String(index) });
    }

    const wanted = Array.isArray(columns) ? columns.map(String) : keys;

    send("log", [data], { table: { columns: plain ? [...wanted, ""] : wanted, rows } });
  });

  // An error the page didn't catch, named by the kid's file and line.
  window.addEventListener(
    "error",
    (event) => {
      const target = event.target;

      // A failed image, script or stylesheet: say which file is missing.
      if (target && target !== window && (target.src || target.href)) {
        const address = target.src || target.href;
        const named = place(address, 0);

        send("error", [`Couldn't load ${named ? named.file : address} (on ${page})`], { where: null });
        return;
      }

      // The browser hides an error from another website's script unless that
      // website allows it.
      if (event.message === "Script error." && !event.filename) {
        send("error", ["An error in a script from another website. The browser hides its message: that website doesn't share it."], { where: null });
        return;
      }

      const where = event.filename ? place(event.filename, event.lineno) : null;
      const error = event.error;
      const shown = error instanceof Error ? `Uncaught ${error.name}: ${error.message}` : `${event.message}`;

      send("error", [shown], { where: where || (event.lineno ? { file: page, line: event.lineno } : null) });
    },
    true,
  );
  window.addEventListener("unhandledrejection", (event) =>
    send("error", ["Uncaught (in promise)", event.reason], { where: null }),
  );

  // A line typed into the editor's console runs here, as in DevTools.
  return {
    evaluate: (code) => {
      try {
        const result = (0, eval)(code);

        post({ level: "result", type: "preview:console", values: values([result]) });
      } catch (error) {
        // As DevTools says it; the stack would only show the console's own
        // workings.
        const text = error instanceof Error ? `Uncaught ${error.name}: ${error.message}` : `Uncaught ${preview(error, 1)}`;

        post({ level: "error", type: "preview:console", values: [{ kind: "string", text }] });
      }
    },
  };
};
