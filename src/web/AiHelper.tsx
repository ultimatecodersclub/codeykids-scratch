import { useEffect, useRef, useState } from "react";

import { AiAccess, AiMessage, askAi } from "./ai";

// The coding AI the worksheets reached in a terminal (ollama run
// qwen2.5-coder), here as a tab beside the console. The kid asks, reads the
// answer and copies what they want into their files themselves: nothing goes
// into a file on its own, and nothing is suggested while they type.
const SYSTEM = [
  "You help a student write a website in CodeyKids, a code editor for kids with HTML, CSS and JavaScript files and a live preview.",
  "Explain simply, then give complete, working code in fenced code blocks, saying which file each block belongs in.",
  "Use plain HTML, CSS and JavaScript with no build tools; libraries only from a CDN with a <script> tag.",
  "The student copies your code into their files themselves.",
].join(" ");

// The open file goes with a question when the kid ticks the box, cut to this.
const FILE_CHARS = 6000;

type Turn = { content: string; role: "assistant" | "user" } | { error: string; role: "error" };

type Props = {
  ai: AiAccess | undefined;
  file: { name: string; text: string } | undefined;
};

// A reply split into its words and its code blocks, each block with a Copy
// button.
const Reply = ({ content }: { content: string }) => {
  const parts = content.split(/```[\w-]*\n?([\s\S]*?)```/g);

  return (
    <div className="ai-reply">
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <CodeBlock code={part.replace(/\n$/, "")} key={index} />
        ) : (
          part.trim() && (
            <p className="ai-text" key={index}>
              {part.trim()}
            </p>
          )
        ),
      )}
    </div>
  );
};

const CodeBlock = ({ code }: { code: string }) => {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The browser said no: the kid can still select the code by hand.
      window.alert("Copying isn't allowed here. Select the code and press Ctrl+C instead.");
    }
  };

  return (
    <div className="ai-code">
      <button onClick={() => void copy()} type="button">
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>{code}</pre>
    </div>
  );
};

export const AiHelper = ({ ai, file }: Props) => {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [withFile, setWithFile] = useState(false);
  const [asking, setAsking] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns, asking]);

  const ask = async () => {
    const text = question.trim();

    if (!text || asking) return;

    // The open file, when asked for, goes with this question only.
    const shown = withFile && file ? `${text}\n\nMy file ${file.name}:\n\`\`\`\n${file.text.slice(0, FILE_CHARS)}\n\`\`\`` : text;
    const history: AiMessage[] = turns.flatMap((turn) =>
      turn.role === "error" ? [] : [{ content: turn.content, role: turn.role }],
    );

    setTurns((current) => [...current, { content: text, role: "user" }]);
    setQuestion("");
    setAsking(true);
    try {
      const reply = await askAi(ai, {
        messages: [{ content: SYSTEM, role: "system" }, ...history.slice(-8), { content: shown, role: "user" }],
      });

      setTurns((current) => [...current, { content: reply.content, role: "assistant" }]);
    } catch (error) {
      setTurns((current) => [...current, { error: (error as Error).message, role: "error" }]);
    } finally {
      setAsking(false);
    }
  };

  if (!ai) {
    return (
      <div className="ai-helper">
        <p className="console-hint">The coding AI works when this lesson is opened in CodeyKids.</p>
      </div>
    );
  }

  return (
    <div className="ai-helper">
      <div className="ai-turns" ref={listRef}>
        {turns.length === 0 && (
          <p className="console-hint">
            Ask the coding AI to write or explain some code, for example "Write a button that changes the page's colour".
            It can make mistakes: try what it gives you, and ask again if it doesn't work.
          </p>
        )}
        {turns.map((turn, index) =>
          turn.role === "user" ? (
            <p className="ai-question" key={index}>
              {turn.content}
            </p>
          ) : turn.role === "error" ? (
            <p className="ai-error" key={index}>
              {turn.error}
            </p>
          ) : (
            <Reply content={turn.content} key={index} />
          ),
        )}
        {asking && <p className="console-hint">Thinking…</p>}
      </div>
      <form
        className="ai-ask"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <textarea
          aria-label="Your question for the coding AI"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask();
            }
          }}
          placeholder="Ask the coding AI (Enter to send, Shift+Enter for a new line)"
          rows={2}
          value={question}
        />
        <div className="ai-ask-row">
          {file && (
            <label title="Send the file that's open in the editor with this question">
              <input checked={withFile} onChange={(e) => setWithFile(e.target.checked)} type="checkbox" />
              Include {file.name}
            </label>
          )}
          {turns.length > 0 && (
            <button onClick={() => setTurns([])} type="button">
              Start over
            </button>
          )}
          <button disabled={asking || !question.trim()} type="submit">
            Ask
          </button>
        </div>
      </form>
    </div>
  );
};
