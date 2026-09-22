/// <reference types="vite/client" />

// scratch-l10n ships no types. Its default export is the language list the
// Scratch language menu shows: code to name, written in that language.
declare module "scratch-l10n" {
  const locales: Record<string, { name: string }>;
  export default locales;
}
