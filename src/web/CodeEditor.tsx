import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";

import { extensionOf } from "./files";
import { canFormat, formatCode, formatProblem } from "./format";

const NOTICE_MS = 5000;

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
  // Every file the project has now: the saved state of one that is gone
  // (deleted or renamed) goes with it, so a new file of that name starts
  // with no history.
  files?: string[];
  name: string;
  onChange: (text: string) => void;
  readOnly: boolean;
  value: string;
};

// One CodeMirror view showing one file at a time. Each file keeps its own
// state, so undo only ever steps back through that file's own edits (an undo
// right after a switch must not bring the other file's text in), and coming
// back to a file brings its undo history back with it.
export const CodeEditor = ({ files, name, onChange, readOnly, value }: Props) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
  const onChangeRef = useRef(onChange);
  const readOnlyRef = useRef(readOnly);
  const readOnlyCompartment = useRef(new Compartment());
  const shownRef = useRef(name);
  const statesRef = useRef(new Map<string, EditorState>());
  // A short line by the Format button when formatting changed nothing or failed.
  const [notice, setNotice] = useState("");

  onChangeRef.current = onChange;
  readOnlyRef.current = readOnly;

  // Format Document, as Shift+Alt+F does in VS Code. Prettier loads the first
  // time, so the kid may type on (or open another file) meanwhile: then the
  // formatted text is of a document that is gone and is dropped. The result is
  // one step of its own in the undo history.
  const format = async () => {
    const view = viewRef.current;
    const fileName = shownRef.current;

    if (!view || view.state.readOnly || !canFormat(fileName)) return;

    const { doc, selection } = view.state;
    const text = doc.toString();

    try {
      const { cursorOffset, formatted } = await formatCode(text, fileName, selection.main.head);

      if (viewRef.current !== view || view.state.doc !== doc || view.state.readOnly) return;
      if (formatted === text) {
        setNotice("Already formatted.");
        return;
      }

      setNotice("");
      view.dispatch({
        annotations: [isolateHistory.of("full"), Transaction.userEvent.of("input.format")],
        changes: { from: 0, insert: formatted, to: doc.length },
        scrollIntoView: true,
        selection: { anchor: Math.min(Math.max(cursorOffset, 0), formatted.length) },
      });
    } catch (error) {
      if (viewRef.current === view) setNotice(formatProblem(error));
    }
  };

  const stateFor = (doc: string, fileName: string) =>
    EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        history(),
        // Colours for the code, matching brackets lit up, and a closing
        // bracket or quote typed for the kid (typing it anyway steps over
        // it). No completion pop-ups: the curriculum has kids type every
        // word themselves.
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        // Find and replace in this file (Ctrl+F / Cmd+F), at the top like
        // VS Code's.
        search({ top: true }),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        // Shift+Alt+F, found by the key's place: on a Mac, Option turns the F
        // into another letter, which a keymap would not match.
        canFormat(fileName)
          ? EditorView.domEventHandlers({
              keydown: (event) => {
                if (event.code !== "KeyF" || !event.shiftKey || !event.altKey || event.ctrlKey || event.metaKey) {
                  return false;
                }

                event.preventDefault();
                void format();
                return true;
              },
            })
          : [],
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

    return () => {
      viewRef.current = undefined;
      view.destroy();
    };
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
    setNotice("");
    view.setState(state);
    view.dispatch({ effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnlyRef.current)) });
    // Only a file switch shows another document; edits flow the other way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  useEffect(() => {
    if (!files) return;

    const present = new Set(files);

    for (const saved of [...statesRef.current.keys()]) {
      if (!present.has(saved)) statesRef.current.delete(saved);
    }
  }, [files]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    if (!notice) return;

    const timer = window.setTimeout(() => setNotice(""), NOTICE_MS);

    return () => window.clearTimeout(timer);
  }, [notice]);

  return (
    <div className="editor">
      <div className="editor-host" ref={hostRef} />
      {canFormat(name) && !readOnly && (
        <div className="editor-tools">
          {/* Keeps the editor's focus, so the kid types on where they were. */}
          <button
            onClick={() => void format()}
            onMouseDown={(e) => e.preventDefault()}
            title="Tidy the spacing and indents (Shift+Alt+F)"
            type="button"
          >
            Format
          </button>
          {notice && (
            <span className="editor-notice" role="status">
              {notice}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
