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

// One CodeMirror view showing one file at a time. Each file keeps its own
// state, so undo only ever steps back through that file's own edits (an undo
// right after a switch must not bring the other file's text in), and coming
// back to a file brings its undo history back with it.
export const CodeEditor = ({ name, onChange, readOnly, value }: Props) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
  const onChangeRef = useRef(onChange);
  const readOnlyRef = useRef(readOnly);
  const readOnlyCompartment = useRef(new Compartment());
  const shownRef = useRef(name);
  const statesRef = useRef(new Map<string, EditorState>());

  onChangeRef.current = onChange;
  readOnlyRef.current = readOnly;

  const stateFor = (doc: string, fileName: string) =>
    EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        languageFor(fileName),
        readOnlyCompartment.current.of(EditorState.readOnly.of(readOnlyRef.current)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
        EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { fontFamily: "ui-monospace, Menlo, monospace", fontSize: "14px" } }),
      ],
    });

  useEffect(() => {
    if (!hostRef.current) return;

    const view = new EditorView({ parent: hostRef.current, state: stateFor(value, name) });

    viewRef.current = view;

    return () => view.destroy();
    // The view is made once and shows each file's own state below, which
    // keeps focus across switches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    // The first file came with the view.
    if (!view || shownRef.current === name) return;

    statesRef.current.set(shownRef.current, view.state);

    // A file's own state again, unless its text changed meanwhile (a rename
    // or a file that was replaced): then a fresh one. Setting a state is no
    // edit, so nothing is reported.
    const saved = statesRef.current.get(name);
    const state = saved && saved.doc.toString() === value ? saved : stateFor(value, name);

    shownRef.current = name;
    view.setState(state);
    view.dispatch({ effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnlyRef.current)) });
    // Only a file switch shows another document; edits flow the other way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  return <div className="editor" ref={hostRef} />;
};
