import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

// A kid's Python project: main.py, any modules it imports, and the data
// files it reads. Text only; a starter zip's other files are kept as bytes
// so they come back out unchanged.
export type PythonFile = { bytes?: Uint8Array; text?: string };
export type PythonFiles = Record<string, PythonFile>;

export const MAIN = "main.py";

const TEXT_EXTENSIONS = [".csv", ".json", ".md", ".py", ".txt"];

export const isText = (name: string) =>
  TEXT_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension));

export const STARTER = `# Write your Python here, then press Run.
name = input("What is your name? ")
print("Hello, " + name + "!")
`;

export const starterFiles = (): PythonFiles => ({ [MAIN]: { text: STARTER } });

// A zip starts with "PK".
export const isZip = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b;

// A .py starter is main.py; a zip is the whole project, its top folder
// dropped when one wraps everything.
export const fromBytes = (bytes: Uint8Array): PythonFiles => {
  if (!isZip(bytes)) return { [MAIN]: { text: strFromU8(bytes) } };

  const files: PythonFiles = {};

  for (const [path, data] of Object.entries(unzipSync(bytes))) {
    if (path.endsWith("/") || path.startsWith("__MACOSX/") || path.includes("__pycache__")) continue;

    const name = path.replace(/^[^/]+\/(?=[^/]+$)/, "");

    files[name] = isText(name) ? { text: strFromU8(data) } : { bytes: data };
  }

  if (!files[MAIN]) {
    // A zip without main.py: the first .py file stands in.
    const first = Object.keys(files).find((name) => name.endsWith(".py"));

    if (first) {
      files[MAIN] = files[first];
      delete files[first];
    } else {
      files[MAIN] = { text: STARTER };
    }
  }

  return files;
};

// One file saves as itself, so the project also opens in IDLE; more become
// a zip, named so the page keeps the extension.
export const toBlob = (files: PythonFiles) => {
  const names = Object.keys(files);

  if (names.length === 1 && names[0] === MAIN) {
    return new File([files[MAIN].text ?? ""], MAIN, { type: "text/x-python" });
  }

  const entries: Record<string, Uint8Array> = {};

  for (const [name, file] of Object.entries(files)) {
    entries[name] = file.bytes ?? strToU8(file.text ?? "");
  }

  return new File([zipSync(entries, { level: 6 })], "project.zip", { type: "application/zip" });
};

export const bytesOf = (files: PythonFiles) =>
  Object.values(files).reduce((total, file) => total + (file.bytes?.byteLength ?? file.text?.length ?? 0), 0);
