// Python modules real Python finds after the project's own files: stand-ins
// for libraries that cannot run in a browser, answering the way the real
// ones do so the lessons' code stays as written.
//
// Keep backslashes out of these strings: the template literals would eat them.

// ollama: questions go to the small model CodeyKids hosts (the aiChat
// mutation), whatever model the program names. Answers read both ways the
// real library allows: response["message"]["content"] and
// response.message.content.
const OLLAMA = `
"""Stand-in for the ollama library: CodeyKids answers with a hosted model."""

import builtins
import json as _json
import time as _time

import js


class ResponseError(Exception):
    def __init__(self, error, status_code=-1):
        super().__init__(error)
        self.error = error
        self.status_code = status_code


class _Answer(dict):
    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name) from None


def _wrap(value):
    if isinstance(value, dict):
        return _Answer({key: _wrap(item) for key, item in value.items()})
    if isinstance(value, builtins.list):
        return [_wrap(item) for item in value]
    return value


def _message(item):
    if isinstance(item, dict):
        return {"role": str(item.get("role", "user")), "content": str(item.get("content", ""))}
    return {"role": str(getattr(item, "role", "user")), "content": str(getattr(item, "content", ""))}


def _ask(messages, options=None, format=None):
    options = dict(options or {})
    payload = {
        "messages": [_message(item) for item in messages],
        "json": format == "json" or isinstance(format, dict),
        "maxTokens": options.get("num_predict"),
        "temperature": options.get("temperature"),
    }
    answer = _json.loads(str(js.codeykidsAiChat(_json.dumps(payload))))
    if "error" in answer:
        raise ResponseError(answer["error"])
    return answer["content"]


def _now():
    return _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())


def chat(model="llama3.2", messages=None, stream=False, format=None, options=None, **kwargs):
    content = _ask(messages or [], options, format)
    response = _wrap({
        "model": model,
        "created_at": _now(),
        "message": {"role": "assistant", "content": content},
        "done": True,
        "done_reason": "stop",
    })
    return iter([response]) if stream else response


def generate(model="llama3.2", prompt="", system=None, stream=False, format=None, options=None, **kwargs):
    messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
    content = _ask(messages, options, format)
    response = _wrap({"model": model, "created_at": _now(), "response": content, "done": True, "done_reason": "stop"})
    return iter([response]) if stream else response


def list():
    return _wrap({"models": [{"model": "llama3.2", "name": "llama3.2"}]})


def pull(model="llama3.2", **kwargs):
    return _wrap({"status": "success"})


def show(model="llama3.2", **kwargs):
    return _wrap({"model": model, "details": {"family": "llama", "parameter_size": "3B"}})


class Client:
    def __init__(self, host=None, **kwargs):
        self.host = host

    def chat(self, *args, **kwargs):
        return chat(*args, **kwargs)

    def generate(self, *args, **kwargs):
        return generate(*args, **kwargs)

    def list(self):
        return list()

    def pull(self, *args, **kwargs):
        return pull(*args, **kwargs)

    def show(self, *args, **kwargs):
        return show(*args, **kwargs)
`;

export const MODULES: Record<string, string> = { "ollama.py": OLLAMA };
