import GUI, { AppStateHOC, setAppElement } from "@scratch/scratch-gui";
import { ComponentProps, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { postToPage } from "./bridge";
import { MenuBridge } from "./menuBridge";
import { useEditorBridge } from "./useEditorBridge";

// Minimal shape of the parts of scratch-vm this wrapper touches.
export type ScratchVM = {
  loadProject: (input: ArrayBuffer | string | object) => Promise<void>;
  saveProjectSb3: () => Promise<Blob>;
  // scratch-render: the callback gets the stage as a data URL at its next
  // draw.
  renderer?: {
    draw: () => void;
    requestSnapshot: (callback: (dataURL: string) => void) => void;
  };
  runtime: {
    on: (event: string, listener: () => void) => void;
    off: (event: string, listener: () => void) => void;
  };
  stopAll: () => void;
};

// The GUI and, beside it inside the same store, the bridge that stands in
// for its menubar. AppStateHOC wraps this whole component in the provider.
const GuiWithMenu = (props: ComponentProps<typeof GUI>) => (
  <>
    <GUI {...props} />
    <MenuBridge />
  </>
);

const WrappedGui = AppStateHOC(GuiWithMenu);

const App = () => {
  const [isPlayerOnly, setIsPlayerOnly] = useState(false);
  const hasBooted = useRef(false);

  const { onVmInit } = useEditorBridge({ setIsPlayerOnly });

  // The GUI reports every project it brings in through its own loading
  // state: the default one at boot, and a fresh one after New. Only the
  // first is the editor being ready; announcing the second would have the
  // page load the saved project straight back over the new one.
  const onProjectLoaded = () => {
    if (hasBooted.current) return;

    hasBooted.current = true;
    postToPage({ type: "ready" });
  };

  return (
    <WrappedGui
      canEditTitle={false}
      canManageFiles
      isPlayerOnly={isPlayerOnly}
      // The menubar is the page's: its File, Edit, Settings, Tutorials and
      // Debug live in the CodeyKids bar above this frame, which also keeps
      // Scratch's logo out of a product that is only based on Scratch.
      menuBarHidden
      onProjectLoaded={onProjectLoaded}
      onVmInit={onVmInit}
      // "0" is the GUI's bundled default project (the cat). Without a project
      // id nothing loads and onProjectLoaded never fires.
      projectId="0"
    />
  );
};

const target = document.getElementById("app")!;

setAppElement(target);
createRoot(target).render(<App />);
