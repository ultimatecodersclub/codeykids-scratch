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

// mediapipe: the hand tracking the legacy solutions API offered
// (mp.solutions.hands), answered by Google's hand tracker for the browser
// on the picture the program passes to process().
const MEDIAPIPE_INIT = `
"""Stand-in for mediapipe's hand tracking, for CodeyKids' Python editor."""

from mediapipe import solutions

__version__ = "0.10.21"
`;

const MEDIAPIPE_SOLUTIONS = `
from mediapipe.solutions import drawing_styles, drawing_utils, hands
`;

const MEDIAPIPE_HANDS = `
import enum
import json

import js
from pyodide.ffi import to_js


class HandLandmark(enum.IntEnum):
    WRIST = 0
    THUMB_CMC = 1
    THUMB_MCP = 2
    THUMB_IP = 3
    THUMB_TIP = 4
    INDEX_FINGER_MCP = 5
    INDEX_FINGER_PIP = 6
    INDEX_FINGER_DIP = 7
    INDEX_FINGER_TIP = 8
    MIDDLE_FINGER_MCP = 9
    MIDDLE_FINGER_PIP = 10
    MIDDLE_FINGER_DIP = 11
    MIDDLE_FINGER_TIP = 12
    RING_FINGER_MCP = 13
    RING_FINGER_PIP = 14
    RING_FINGER_DIP = 15
    RING_FINGER_TIP = 16
    PINKY_MCP = 17
    PINKY_PIP = 18
    PINKY_DIP = 19
    PINKY_TIP = 20


HAND_CONNECTIONS = frozenset([
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (5, 9), (9, 10), (10, 11), (11, 12),
    (9, 13), (13, 14), (14, 15), (15, 16),
    (13, 17), (0, 17), (17, 18), (18, 19), (19, 20),
])


class NormalizedLandmark:
    def __init__(self, x, y, z):
        self.x = x
        self.y = y
        self.z = z

    def __repr__(self):
        return "x: %s y: %s z: %s" % (self.x, self.y, self.z)


class NormalizedLandmarkList:
    def __init__(self, landmark):
        self.landmark = landmark


class Classification:
    def __init__(self, index, score, label):
        self.index = index
        self.score = score
        self.label = label


class ClassificationList:
    def __init__(self, classification):
        self.classification = classification


class _Results:
    def __init__(self, multi_hand_landmarks, multi_handedness):
        self.multi_hand_landmarks = multi_hand_landmarks
        self.multi_handedness = multi_handedness
        self.multi_hand_world_landmarks = None


class Hands:
    def __init__(self, static_image_mode=False, max_num_hands=2, model_complexity=1,
                 min_detection_confidence=0.5, min_tracking_confidence=0.5):
        self.max_num_hands = max_num_hands

    def process(self, image):
        import numpy as np

        image = np.ascontiguousarray(image)
        height, width = image.shape[:2]
        request = json.dumps({"height": height, "maxHands": self.max_num_hands, "width": width})
        found = json.loads(str(js.codeykidsCamera("detect", request, to_js(image.tobytes()))))
        if isinstance(found, dict):
            raise RuntimeError(found.get("error", "The hand tracker did not answer."))
        if not found:
            return _Results(None, None)
        landmarks = [NormalizedLandmarkList([NormalizedLandmark(*point) for point in hand["landmarks"]]) for hand in found]
        handedness = [
            ClassificationList([Classification(index, hand["score"], hand["handedness"])])
            for index, hand in enumerate(found)
        ]
        return _Results(landmarks, handedness)

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
`;

const MEDIAPIPE_DRAWING_UTILS = `
import cv2


class DrawingSpec:
    def __init__(self, color=(224, 224, 224), thickness=2, circle_radius=2):
        self.color = color
        self.thickness = thickness
        self.circle_radius = circle_radius


_LANDMARKS = DrawingSpec(color=(0, 0, 255))
_CONNECTIONS = DrawingSpec()


def _spec(spec, index, default):
    if isinstance(spec, dict):
        return spec.get(index, default)
    return spec or default


def draw_landmarks(image, landmark_list, connections=None, landmark_drawing_spec=_LANDMARKS,
                   connection_drawing_spec=_CONNECTIONS, is_drawing_landmarks=True):
    if landmark_list is None:
        return
    height, width = image.shape[:2]
    points = {
        index: (int(point.x * width), int(point.y * height))
        for index, point in enumerate(landmark_list.landmark)
    }
    for start, end in connections or []:
        if start in points and end in points:
            spec = _spec(connection_drawing_spec, (start, end), _CONNECTIONS)
            cv2.line(image, points[start], points[end], spec.color, spec.thickness)
    if is_drawing_landmarks and landmark_drawing_spec is not None:
        for index, point in points.items():
            spec = _spec(landmark_drawing_spec, index, _LANDMARKS)
            cv2.circle(image, point, spec.circle_radius, spec.color, spec.thickness)
`;

const MEDIAPIPE_DRAWING_STYLES = `
from mediapipe.solutions.drawing_utils import DrawingSpec


def get_default_hand_landmarks_style():
    return DrawingSpec(color=(0, 0, 255))


def get_default_hand_connections_style():
    return DrawingSpec()
`;

export const MODULES: Record<string, string> = {
  "mediapipe/__init__.py": MEDIAPIPE_INIT,
  "mediapipe/solutions/__init__.py": MEDIAPIPE_SOLUTIONS,
  "mediapipe/solutions/drawing_styles.py": MEDIAPIPE_DRAWING_STYLES,
  "mediapipe/solutions/drawing_utils.py": MEDIAPIPE_DRAWING_UTILS,
  "mediapipe/solutions/hands.py": MEDIAPIPE_HANDS,
  "ollama.py": OLLAMA,
};
