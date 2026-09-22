import threading
from typing import Dict, Optional, Set

from aiohttp import web
from server import PromptServer
from comfy.model_management import InterruptProcessingException, throw_exception_if_processing_interrupted


class Cancelled(Exception):
    pass


class _Waiter:
    def __init__(self) -> None:
        self.event = threading.Event()
        self.message: Optional[str] = None

    def set(self, message: str) -> None:
        self.message = message
        self.event.set()

    def wait(self, timeout: float) -> bool:
        return self.event.wait(timeout)


class MessageBroker:
    """Thread-safe broker used by the chooser nodes to coordinate messages."""

    _lock = threading.Lock()
    _waiters: Dict[str, _Waiter] = {}
    _messages: Dict[str, str] = {}
    _stash: Dict[str, Dict[str, object]] = {}
    _last_selection: Dict[str, object] = {}
    _id_map: Dict[str, str] = {}
    _cancelled = False
    _active_ids: Set[str] = set()
    # Choosers currently waiting on user input, so a client that missed the
    # original websocket notification (disconnected/backgrounded) can recover.
    _pending: Dict[str, Dict[str, object]] = {}

    @classmethod
    def _normalise_id(cls, value: object) -> str:
        key = str(value)
        with cls._lock:
            mapped = cls._id_map.get(key, key)
        return mapped

    @classmethod
    def reset_for_run(cls) -> None:
        with cls._lock:
            cls._messages.clear()
            cls._waiters.clear()
            cls._id_map.clear()
            cls._active_ids.clear()
            cls._cancelled = False
            cls._stash.clear()
            cls._pending.clear()

    @classmethod
    def set_pending(cls, unique_id: object, event: str, context: Dict[str, object]) -> None:
        key = str(unique_id)
        with cls._lock:
            cls._pending[key] = {"event": event, "context": context}

    @classmethod
    def clear_pending(cls, unique_id: object) -> None:
        key = str(unique_id)
        with cls._lock:
            cls._pending.pop(key, None)

    @classmethod
    def get_pending(cls) -> list:
        with cls._lock:
            return list(cls._pending.values())

    @classmethod
    def add_message(cls, id_value, message: str) -> None:
        key = str(id_value)
        if message == "__start__":
            cls.reset_for_run()
            return

        with cls._lock:
            if message == "__cancel__":
                cls._cancelled = True
                for waiter in cls._waiters.values():
                    waiter.set(message)
                return

            mapped = cls._id_map.get(key, key)
            cls._messages[mapped] = message
            cls._pending.pop(mapped, None)
            waiter = cls._waiters.get(mapped)
            if waiter:
                waiter.set(message)

    @classmethod
    def bind_display_id(cls, display_id: object, unique_id: object) -> None:
        display = str(display_id)
        unique = str(unique_id)
        segments = [unique]
        if ":" in unique:
            segments.extend(seg for seg in unique.split(":") if seg)
        segments.append(display)
        with cls._lock:
            for token in segments:
                cls._id_map[token] = unique
                if token in cls._messages and unique not in cls._messages:
                    cls._messages[unique] = cls._messages.pop(token)

    @classmethod
    def wait_for_message(cls, unique_id: object, *, as_list: bool = False, timeout: float = 0.1):
        key = cls._normalise_id(unique_id)

        while True:
            throw_exception_if_processing_interrupted()
            with cls._lock:
                if cls._cancelled:
                    cls._cancelled = False
                    raise Cancelled()

                if key in cls._messages:
                    message = cls._messages.pop(key)
                    break

                waiter = cls._waiters.get(key)
                if waiter is None:
                    waiter = _Waiter()
                    cls._waiters[key] = waiter

            if waiter.wait(timeout):
                message = waiter.message
                if message is None:
                    continue
                if message == "__cancel__":
                    raise Cancelled()
                break

        if as_list:
            try:
                return [int(item.strip()) for item in message.split(",") if item.strip() != ""]
            except ValueError:
                print(f"[image_chooser] failed to parse selection '{message}'")
                return []
        return message

    @classmethod
    def stash_for(cls, unique_id: object) -> Dict[str, object]:
        key = str(unique_id)
        with cls._lock:
            return cls._stash.setdefault(key, {})

    @classmethod
    def clear_stash(cls, unique_id: object) -> None:
        key = str(unique_id)
        with cls._lock:
            cls._stash.pop(key, None)

    @classmethod
    def set_last_selection(cls, unique_id: object, payload: object) -> None:
        key = str(unique_id)
        with cls._lock:
            cls._last_selection[key] = payload

    @classmethod
    def get_last_selection(cls, unique_id: object) -> Optional[object]:
        key = str(unique_id)
        with cls._lock:
            return cls._last_selection.get(key)

    @classmethod
    def clear_last_selection(cls, unique_id: object) -> None:
        key = str(unique_id)
        with cls._lock:
            cls._last_selection.pop(key, None)


routes = PromptServer.instance.routes


@routes.post("/image_chooser_classic_message")
async def receive_message(request):
    post = await request.post()
    MessageBroker.add_message(post.get("id"), post.get("message", ""))
    return web.json_response({})


@routes.get("/image_chooser_classic_pending")
async def get_pending(request):
    return web.json_response({"pending": MessageBroker.get_pending()})
