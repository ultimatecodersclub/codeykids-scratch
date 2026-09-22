import { openDebugModal, openTipsLibrary, requestNewProject, selectLocale } from "@scratch/scratch-gui";
import { useEffect } from "react";
import { useStore } from "react-redux";
import locales from "scratch-l10n";

import { listenToPage, MenuAction, MenuState, postToPage } from "./bridge";
import type { ScratchVM } from "./main";

// The slice of the GUI's store this reads. The GUI publishes its action
// creators but not its state shape, so these paths are pinned here in one
// place; `settings` has no published actions at all, so its two are spelled
// out below.
type GuiState = {
  locales: { locale: string };
  scratchGui: {
    restoreDeletion: { deletedItem: string; restoreFun: (() => void) | null };
    settings: { colorMode: string; theme: string };
    vm: ScratchVM & { setTurboMode: (on: boolean) => void };
    vmStatus: { turbo: boolean };
  };
};

// The GUI's own choices, as its settings menu lists them. Dark mode is not
// enabled in the GUI yet, so it is not offered.
const COLOR_MODES = [
  { label: "Default", value: "default" },
  { label: "High contrast", value: "high-contrast" },
];
const THEMES = [
  { label: "Default", value: "default" },
  { label: "Cat blocks", value: "cat-blocks" },
];
const LANGUAGES = Object.entries(locales as Record<string, { name: string }>).map(([code, { name }]) => ({
  code,
  name,
}));

// A year, the way the GUI's own menu remembers these on this origin.
const remember = (key: string, value: string) => {
  const expires = new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toUTCString();

  document.cookie = `${key}=${value};expires=${expires};path=/`;
};

const menuStateOf = (state: GuiState): MenuState => ({
  colorMode: state.scratchGui.settings.colorMode,
  colorModes: COLOR_MODES,
  languages: LANGUAGES,
  locale: state.locales.locale,
  restorable: state.scratchGui.restoreDeletion.restoreFun ? state.scratchGui.restoreDeletion.deletedItem : "",
  theme: state.scratchGui.settings.theme,
  themes: THEMES,
  turbo: state.scratchGui.vmStatus.turbo,
});

const sameMenuState = (a: MenuState, b: MenuState) =>
  a.colorMode === b.colorMode &&
  a.locale === b.locale &&
  a.restorable === b.restorable &&
  a.theme === b.theme &&
  a.turbo === b.turbo;

// Sits inside the GUI's store: tells the page what the menubar would have
// shown, and carries out what the page picked from its own menu.
export const MenuBridge = () => {
  const store = useStore<GuiState>();

  useEffect(() => {
    let last: MenuState | undefined;
    const publish = () => {
      const next = menuStateOf(store.getState());

      if (last && sameMenuState(last, next)) return;

      last = next;
      postToPage({ state: next, type: "menuState" });
    };

    publish();

    return store.subscribe(publish);
  }, [store]);

  useEffect(() => {
    const act = (message: MenuAction) => {
      const state = store.getState();

      switch (message.action) {
        case "new":
          // The GUI's own New: its default project comes in through the
          // loading state, which fires PROJECT_CHANGED, so the page hears
          // `changed` and saves the fresh start.
          store.dispatch(requestNewProject(false));
          break;
        case "tutorials":
          store.dispatch(openTipsLibrary());
          break;
        case "debug":
          store.dispatch(openDebugModal());
          break;
        case "restore":
          state.scratchGui.restoreDeletion.restoreFun?.();
          break;
        case "turbo":
          state.scratchGui.vm.setTurboMode(message.value);
          break;
        case "language":
          if (!(message.value in locales)) return;
          store.dispatch(selectLocale(message.value));
          document.documentElement.lang = message.value;
          break;
        case "colorMode":
          if (!COLOR_MODES.some((m) => m.value === message.value)) return;
          store.dispatch({ colorMode: message.value, type: "scratch-gui/settings/SET_COLOR_MODE" });
          remember("scratchtheme", message.value);
          break;
        case "theme":
          if (!THEMES.some((t) => t.value === message.value)) return;
          store.dispatch({ theme: message.value, type: "scratch-gui/settings/SET_THEME" });
          remember("scratchblockstheme", message.value);
          break;
      }
    };

    return listenToPage((message) => {
      if (message.type === "menu") act(message);
    });
  }, [store]);

  return null;
};
