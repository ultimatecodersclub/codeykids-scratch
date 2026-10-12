// Skulpt words some errors differently from Python 3.14, which the worksheets
// quote and which the same program prints once it runs on real Python. For a
// missing colon, a missing indent or an unclosed bracket Skulpt only says
// "invalid syntax", so those are worked out from the source around the line
// it points at, the way Python's tokenizer and parser report them; the rest
// are reworded.

export type Wording = { line?: number; message: string };

const REWORDINGS: [RegExp, string][] = [
  [/^SyntaxError: bad input/, "SyntaxError: invalid syntax"],
  [/^TypeError: cannot concatenate 'str' and '(\w+)' objects/, 'TypeError: can only concatenate str (not "$1") to str'],
  [/^ZeroDivisionError: integer division or modulo by zero/, "ZeroDivisionError: division by zero"],
  [/^IOError: \[Errno 2\]/, "FileNotFoundError: [Errno 2]"],
  [
    /^UnboundLocalError: local variable '(\w+)' referenced before assignment/,
    "UnboundLocalError: cannot access local variable '$1' where it is not associated with a value",
  ],
  [/ (was|were) {2,}given/, " $1 given"],
  [/^TypeError: '(\w+)' does not support item assignment/, "TypeError: '$1' object does not support item assignment"],
  [/^TypeError: '(\w+)' does not support indexing/, "TypeError: '$1' object is not subscriptable"],
  [/^ValueError: not enough values to unpack \(expected at least (\d+), got (\d+)\)/, "ValueError: not enough values to unpack (expected $1, got $2)"],
  [/^RecursionError: Maximum call stack size exceeded/, "RecursionError: maximum recursion depth exceeded"],
  [/^SyntaxError: unindent does not match/, "IndentationError: unindent does not match"],
];

const reword = (message: string) =>
  REWORDINGS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), message);

// f() missing 2 required arguments: a, b → … positional arguments: 'a' and 'b'
const explainMissing = (message: string) => {
  const match = message.match(/^TypeError: (\S+\(\)) missing (\d+) required (?:positional )?arguments?: (.+)$/);

  if (!match) return undefined;

  const [, name, count, names] = match;
  const quoted = names.split(", ").map((each) => `'${each}'`);
  const list = quoted.length < 3 ? quoted.join(" and ") : `${quoted.slice(0, -1).join(", ")}, and ${quoted[quoted.length - 1]}`;

  return `TypeError: ${name} missing ${count} required positional argument${count === "1" ? "" : "s"}: ${list}`;
};

const OPENING: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSING: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

type Bracket = { char: string; line: number };

type Scan = {
  // Each line's code: comments gone, every string a "" placeholder.
  code: string[];
  // How many brackets are open where each line starts.
  depth: number[];
  // The first mistake Python's tokenizer stops at, and the line it is
  // noticed on, which for an unterminated triple quote is the last line.
  found?: { at: number; wording: Wording };
  // The number of the file's last line.
  last: number;
  unclosed: Bracket[];
};

const scan = (source: string): Scan => {
  const lines = source.split("\n");
  const last = lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
  const code: string[] = [];
  const depth: number[] = [];
  const stack: Bracket[] = [];
  let found: Scan["found"];
  let triple: { line: number; quote: string } | undefined;

  const note = (at: number, wording: Wording) => {
    found ??= { at, wording };
  };

  lines.forEach((text, index) => {
    const line = index + 1;
    let out = "";
    let i = 0;

    depth.push(stack.length);

    if (triple) {
      const end = text.indexOf(triple.quote);

      if (end < 0) {
        code.push("");
        return;
      }
      i = end + 3;
      out = '""';
      triple = undefined;
    }

    while (i < text.length) {
      const char = text[i];

      if (char === "#") break;

      if (char === '"' || char === "'") {
        const quote = text.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
        let j = i + quote.length;
        let closed = false;

        while (j < text.length) {
          if (text[j] === "\\") {
            j += 2;
          } else if (text.startsWith(quote, j)) {
            closed = true;
            j += quote.length;
            break;
          } else {
            j += 1;
          }
        }

        if (!closed && quote.length === 3) {
          triple = { line, quote };
        } else if (!closed) {
          note(line, { line, message: `SyntaxError: unterminated string literal (detected at line ${line})` });
        }
        out += '""';
        i = closed ? j : text.length;
        continue;
      }

      if (OPENING[char]) {
        stack.push({ char, line });
      } else if (CLOSING[char]) {
        const open = stack.pop();

        if (!open) {
          note(line, { line, message: `SyntaxError: unmatched '${char}'` });
        } else if (open.char !== CLOSING[char]) {
          const where = open.line === line ? "" : ` on line ${open.line}`;

          note(line, {
            line,
            message: `SyntaxError: closing parenthesis '${char}' does not match opening parenthesis '${open.char}'${where}`,
          });
        }
      }
      out += char;
      i += 1;
    }
    code.push(out);
  });

  if (triple) {
    note(last, {
      line: triple.line,
      message: `SyntaxError: unterminated triple-quoted string literal (detected at line ${last})`,
    });
  }

  return { code, depth, found, last, unclosed: stack };
};

const indentOf = (text: string) => text.length - text.trimStart().length;

// A block's first line, but not `class = 3` (a keyword can't be a name).
const HEADERS = /^(if|elif|while|for|def|class|with|except)\b(?!\s*=[^=])/;
const BARE_HEADERS = /^(else|try|finally)\b(.*)$/;
const BLOCK_KINDS: Record<string, string> = { class: "class definition", def: "function definition" };

// A colon outside brackets, the one that ends `if x > 1:` or starts the body
// of `if x > 1: print(x)`.
const hasTopLevelColon = (code: string) => {
  let depth = 0;

  for (const char of code) {
    if (OPENING[char]) depth += 1;
    else if (CLOSING[char]) depth -= 1;
    else if (char === ":" && depth === 0) return true;
  }

  return false;
};

// `if x = 3:`: a lone = where a comparison belongs.
const LONE_EQUALS = /[^=!<>:+\-*/%&|^]=(?!=)/;

const KEYWORDS = new Set(["and", "else", "for", "if", "in", "is", "lambda", "not", "or"]);
const TOKEN = /[rbfuRBFU]{0,2}""|\d[\w.]*|\w+|\S/g;

const tokensOf = (code: string) => [...code.matchAll(TOKEN)].map(([token]) => token);
const isValue = (token = "") => /^\w|""$/.test(token) && !KEYWORDS.has(token);

// `[1 2]` or `print("Hi" name)`: two values side by side inside brackets,
// but not in a comprehension's `for` or `if`, where Python says only
// "invalid syntax".
const missesComma = (code: string, startDepth: number) => {
  let depth = startDepth;
  let previous: string | undefined;
  let clause = false;

  for (const token of tokensOf(code)) {
    const value = isValue(token);

    if (token === "for" || token === "if") clause = true;
    if (value && previous && depth > 0 && !clause) return true;
    if (OPENING[token]) depth += 1;
    if (CLOSING[token]) depth -= 1;
    previous = value || CLOSING[token] ? token : undefined;
  }

  return false;
};

// The same across lines: one line inside brackets ends with a value and the
// next starts with one.
const missesCommaBetween = (before: string, current: string) => {
  const last = tokensOf(before).pop() ?? "";

  return (isValue(last) || !!CLOSING[last]) && isValue(tokensOf(current)[0]);
};

// `5a`, `2nd`: a number running into letters (but not 1e5, 2j or 0x1f).
const BAD_NUMBER = /(?<![\w.])(\d[\d_]*(?:\.\d*)?)([A-Za-z]\w*)/;
const isBadNumber = (code: string) => {
  const match = code.match(BAD_NUMBER);

  if (!match) return false;

  const [, number, rest] = match;

  return !(/^[eE][+-]?\d/.test(rest) || /^[jJ]$/.test(rest) || (number === "0" && /^[xXbBoO]/.test(rest)));
};

// What Python says about the syntax error Skulpt found on `line`.
const explainSyntax = (source: string, line: number, message: string): Wording | undefined => {
  const { code, depth, found, last, unclosed } = scan(source);
  const atEnd = /EOF in multi-line/.test(message);

  if (found && (found.at <= line || atEnd)) return found.wording;

  const open = [...unclosed].reverse().find((bracket) => atEnd || bracket.line <= line);

  if (open) return { line: open.line, message: `SyntaxError: '${open.char}' was never closed` };

  if (/unindent does not match/.test(message)) return undefined;

  const current = code[line - 1] ?? "";
  const trimmed = current.trim();
  // The line before, skipping blank ones, and where its statement starts
  // when it runs on from earlier lines inside brackets.
  let previous = Math.min(line, code.length + 1) - 2;

  while (previous >= 0 && !code[previous].trim()) previous -= 1;

  const before = previous >= 0 ? code[previous].trimEnd() : "";
  let start = previous;

  while (start > 0 && depth[start] > 0) start -= 1;

  const outside = (depth[line - 1] ?? 0) === 0;
  const baseIndent = start >= 0 ? indentOf(code[start]) : 0;

  if (outside && before.endsWith(":") && indentOf(current) <= baseIndent) {
    const word = code[start].trim().split(/\W/)[0];
    const after = BLOCK_KINDS[word] ?? `'${word}' statement`;

    // A file that ends on the colon is reported on its last line.
    return {
      line: Math.min(line, last),
      message: `IndentationError: expected an indented block after ${after} on line ${start + 1}`,
    };
  }

  if (outside && !before.endsWith(":") && !before.endsWith("\\") && indentOf(current) > baseIndent) {
    return { line, message: "IndentationError: unexpected indent" };
  }

  if (isBadNumber(current)) return { line, message: "SyntaxError: invalid decimal literal" };

  // Statements, so only a line that starts one, not one inside brackets.
  if (outside && /^(if|elif|while)\b/.test(trimmed) && LONE_EQUALS.test(trimmed)) {
    return { line, message: "SyntaxError: invalid syntax. Maybe you meant '==' or ':=' instead of '='?" };
  }

  const bare = trimmed.match(BARE_HEADERS);

  if (outside && ((HEADERS.test(trimmed) && !hasTopLevelColon(trimmed)) || (bare && !bare[2].trim().startsWith(":")))) {
    return { line, message: "SyntaxError: expected ':'" };
  }

  if (outside && /^print\s+[^\s=(.[]/.test(trimmed)) {
    return { line, message: "SyntaxError: Missing parentheses in call to 'print'. Did you mean print(...)?" };
  }

  const comma = "SyntaxError: invalid syntax. Perhaps you forgot a comma?";

  if (missesComma(current, depth[line - 1] ?? 0)) return { line, message: comma };
  if (!outside && previous >= 0 && missesCommaBetween(before, current)) return { line: previous + 1, message: comma };

  return undefined;
};

// random.randint(5, 1) reaches Skulpt as randrange(5, 2).
const explainRange = (sourceLine: string, message: string) => {
  const match = message.match(/^ValueError: empty range for randrange\(\) \((-?\d+), (-?\d+), -?\d+\)/);

  if (!match) return undefined;

  const [, start, stop] = match;

  return sourceLine.includes("randint(")
    ? `ValueError: empty range in randint(${start}, ${Number(stop) - 1})`
    : `ValueError: empty range in randrange(${start}, ${stop})`;
};

// `source` is the file the error is in; without it only the wording changes.
export const pythonWording = ({ line, message }: Wording, source?: string): Wording => {
  if (source !== undefined && line && /^SyntaxError: (bad input|bad token|EOF in multi-line|unindent)/.test(message)) {
    const explained = explainSyntax(source, line, message);

    if (explained) return explained;
  }

  const range = source !== undefined && line ? explainRange(source.split("\n")[line - 1] ?? "", message) : undefined;

  return { line, message: range ?? explainMissing(message) ?? reword(message) };
};
