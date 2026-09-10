import GUI, { AppStateHOC, setAppElement } from "@scratch/scratch-gui";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { postToPage } from "./bridge";
import { useEditorBridge } from "./useEditorBridge";

// Minimal shape of the parts of scratch-vm this wrapper touches.
export type ScratchVM = {
  loadProject: (input: ArrayBuffer | string | object) => Promise<void>;
  saveProjectSb3: () => Promise<Blob>;
  runtime: {
    on: (event: string, listener: () => void) => void;
    off: (event: string, listener: () => void) => void;
  };
  stopAll: () => void;
};

const WrappedGui = AppStateHOC(GUI);

const App = () => {
  const [isPlayerOnly, setIsPlayerOnly] = useState(false);

  const { onVmInit } = useEditorBridge({ setIsPlayerOnly });

  return (
    <WrappedGui
      canEditTitle={false}
      canManageFiles
      isPlayerOnly={isPlayerOnly}
      // Scratch's trademark guidance: say "based on Scratch", never use its logo.
      logo="/codeykids-logo.png"
      onProjectLoaded={() => postToPage({ type: "ready" })}
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
