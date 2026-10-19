/// <reference types="vite/client" />

// scratch-l10n ships no types. Its default export is the language list the
// Scratch language menu shows: code to name, written in that language.
declare module "scratch-l10n" {
  const locales: Record<string, { name: string }>;
  export default locales;
}

interface ImportMetaEnv {
  // Where the web editor's preview host serves kids' sites (public/preview),
  // on an origin of its own. Unset: the site is shown as one built page.
  readonly VITE_PREVIEW_URL?: string;
}
