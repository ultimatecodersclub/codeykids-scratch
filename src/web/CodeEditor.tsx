import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";

import { extensionOf } from "./files";

const languageFor = (name: string) => {
  switch (extensionOf(name)) {
    case "css":
      return css();
    case "htm":
    case "html":
      return html();
    case "js":
      return javascript();
    case "py":
      return python();
    default:
      return [];
  }
};

type Props = {
  name: string;
  onChange: (text: string) => void;
  readOnly: boolean;
  value: string;
};

// One CodeMirror instance that swaps its document when the file changes.
export const CodeEditor = ({ name, onChange, readOnly, value }: Props) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
  const onChangeRef = useRef(onChange);
  const languageRef = useRef(new Compartment());
  const readOnlyRef = useRef(new Compartment());
  const shownRef = useRef(name);
  // True while this component replaces the document itself.
  const swappingRef = useRef(false);

  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          languageRef.current.of(languageFor(name)),
          readOnlyRef.current.of(EditorState.readOnly.of(readOnly)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !swappingRef.current) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
          EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { fontFamily: "ui-monospace, Menlo, monospace", fontSize: "14px" } }),
        ],
      }),
    });

    viewRef.current = view;

    return () => view.destroy();
    // The document is replaced below when the file changes; creating the view
    // once keeps undo history and focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    // The first document came with the view; replacing it again would report
    // an edit the kid never made.
    if (!view || shownRef.current === name) return;

    shownRef.current = name;
    swappingRef.current = true;
    view.dispatch({
      changes: { from: 0, insert: value, to: view.state.doc.length },
      effects: languageRef.current.reconfigure(languageFor(name)),
    });
    swappingRef.current = false;
    // Only a file switch replaces the document; edits flow the other way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyRef.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  return <div className="editor" ref={hostRef} />;
};
