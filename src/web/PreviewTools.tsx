import { useEffect, useRef, useState } from "react";

import { PreviewTools, Storage } from "./files";

// The sizes a site is tried at, as DevTools' device toolbar has them.
export const DEVICES = {
  desktop: { height: 0, label: "Desktop", width: 0 },
  phone: { height: 667, label: "Phone (iPhone SE, 375 × 667)", width: 375 },
  tablet: { height: 1024, label: "Tablet (iPad Mini, 768 × 1024)", width: 768 },
} as const;

export type Device = keyof typeof DEVICES;

// How much a phone or tablet frame is shrunk to fit the preview: never
// grown, so 375 pixels of the site are 375 on screen when there is room.
export const useFit = (device: Device) => {
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const { height, width } = DEVICES[device];

  useEffect(() => {
    const stage = stageRef.current;

    if (!stage || width === 0) {
      setScale(1);
      return;
    }

    const fit = () => {
      const room = stage.getBoundingClientRect();
      // Room for the frame's border and a little air.
      const next = Math.min(1, (room.width - 24) / width, (room.height - 24) / height);

      setScale(Math.max(0.2, next));
    };
    const observer = new ResizeObserver(fit);

    observer.observe(stage);
    fit();

    return () => observer.disconnect();
  }, [height, width]);

  return { scale, stageRef };
};

type ToolbarProps = {
  device: Device;
  onDevice: (device: Device) => void;
  onFullScreen: () => void;
  onTools: (tools: PreviewTools) => void;
  tools: PreviewTools;
};

// What DevTools would do to the page, for a kid whose DevTools look at
// CodeyKids instead: its size, its network, reduced motion, full screen.
export const PreviewToolbar = ({ device, onDevice, onFullScreen, onTools, tools }: ToolbarProps) => (
  <div className="preview-tools">
    <label title="See your site at a phone's or tablet's size">
      <span className="tool-label">Size</span>
      <select onChange={(e) => onDevice(e.target.value as Device)} value={device}>
        {(Object.keys(DEVICES) as Device[]).map((key) => (
          <option key={key} value={key}>
            {DEVICES[key].label}
          </option>
        ))}
      </select>
    </label>
    <label title="Try your site with a slow connection or none: fetch() and XMLHttpRequest wait or fail">
      <span className="tool-label">Network</span>
      <select
        className={tools.network === "online" ? undefined : "tool-on"}
        onChange={(e) => onTools({ ...tools, network: e.target.value as PreviewTools["network"] })}
        value={tools.network}
      >
        <option value="online">Online</option>
        <option value="slow">Slow (2 s wait)</option>
        <option value="offline">Offline</option>
      </select>
    </label>
    <label title="Your site sees prefers-reduced-motion: reduce, as for someone who turned animations off">
      <input
        checked={tools.reducedMotion}
        onChange={(e) => onTools({ ...tools, reducedMotion: e.target.checked })}
        type="checkbox"
      />
      Reduced motion
    </label>
    <button onClick={onFullScreen} title="Show your site on the whole screen (Esc to come back)" type="button">
      ⛶ Full screen
    </button>
  </div>
);

type SavedDataProps = {
  data: Storage;
  onChange: (next: Storage) => void;
  readOnly: boolean;
};

// DevTools > Application > Local storage, for the site: each key and its
// value, to change or delete. What changes here is kept with the project and
// the page starts again with it.
export const SavedData = ({ data, onChange, readOnly }: SavedDataProps) => {
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const keys = Object.keys(data).sort();

  const add = () => {
    const key = newKey.trim();

    if (!key) return;
    onChange({ ...data, [key]: newValue });
    setNewKey("");
    setNewValue("");
  };

  return (
    <div className="saved-data">
      {keys.length === 0 ? (
        <p className="console-hint">Nothing saved yet. What your site keeps with localStorage.setItem shows here.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Value</th>
              <th aria-label="Delete" />
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key}>
                <td className="saved-key">{key}</td>
                <td>
                  {/* Kept as typed until the kid leaves the box, so the page
                      doesn't start again on every keystroke. */}
                  <SavedValue
                    onCommit={(value) => onChange({ ...data, [key]: value })}
                    readOnly={readOnly}
                    value={data[key]}
                  />
                </td>
                <td>
                  {!readOnly && (
                    <button
                      onClick={() => {
                        const next = { ...data };

                        delete next[key];
                        onChange(next);
                      }}
                      title={`Delete ${key}`}
                      type="button"
                    >
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!readOnly && (
        <form
          className="saved-add"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input aria-label="New key" onChange={(e) => setNewKey(e.target.value)} placeholder="key" value={newKey} />
          <input aria-label="New value" onChange={(e) => setNewValue(e.target.value)} placeholder="value" value={newValue} />
          <button disabled={!newKey.trim()} type="submit">
            Add
          </button>
          {keys.length > 0 && (
            <button
              onClick={() => {
                if (window.confirm("Delete everything this site saved?")) onChange({});
              }}
              type="button"
            >
              Delete all
            </button>
          )}
        </form>
      )}
    </div>
  );
};

const SavedValue = ({ onCommit, readOnly, value }: { onCommit: (value: string) => void; readOnly: boolean; value: string }) => {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);

  // The page saved something new: show it, unless the kid is typing.
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  return (
    <textarea
      aria-label="Value"
      onBlur={() => {
        editing.current = false;
        if (draft !== value) onCommit(draft);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => {
        editing.current = true;
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      readOnly={readOnly}
      rows={Math.min(4, value.split("\n").length)}
      spellCheck={false}
      value={draft}
    />
  );
};
