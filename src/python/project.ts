import { strFromU8 } from "fflate";

import { packZip, ProjectFile, ProjectFiles, textMatcher, unpackZip } from "../zip";

// A kid's Python project: main.py, any modules it imports, and the data
// files it reads or writes. Text only; a starter zip's other files are kept
// as bytes so they come back out unchanged.
export type PythonFile = ProjectFile;
export type PythonFiles = ProjectFiles;

export const MAIN = "main.py";

export const isText = textMatcher([".csv", ".json", ".md", ".py", ".txt"]);

const STARTER = `# Write your Python here, then press Run.
name = input("What is your name? ")
print("Hello, " + name + "!")
`;

export const starterFiles = (): PythonFiles => ({ [MAIN]: { text: STARTER } });

// A zip starts with "PK".
const isZip = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b;

// A .py starter is main.py; a zip is the whole project.
export const fromBytes = (bytes: Uint8Array): PythonFiles => {
  if (!isZip(bytes)) return { [MAIN]: { text: strFromU8(bytes) } };

  const files = unpackZip(bytes, { isText });

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

  return new File([packZip(files) as BlobPart], "project.zip", { type: "application/zip" });
};

export { bytesOf } from "../zip";
