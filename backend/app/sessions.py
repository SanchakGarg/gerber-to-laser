"""In-memory store of parsed boards with TTL expiry and an LRU cap."""
import threading
import time
from collections import OrderedDict

from .config import settings


class SessionStore:
    def __init__(self, ttl_seconds=None, max_items=None):
        self.ttl = ttl_seconds if ttl_seconds is not None else settings.session_ttl_minutes * 60
        self.max_items = max_items if max_items is not None else settings.max_sessions
        self._items = OrderedDict()
        self._lock = threading.Lock()

    def put(self, board):
        with self._lock:
            self._items[board.id] = board
            self._items.move_to_end(board.id)
            self._evict_locked()

    def get(self, board_id):
        with self._lock:
            self._evict_locked()
            board = self._items.get(board_id)
            if board is not None:
                board.touched = time.time()
                self._items.move_to_end(board_id)
            return board

    def sweep(self):
        with self._lock:
            self._evict_locked()

    def _evict_locked(self):
        now = time.time()
        for bid in [k for k, b in self._items.items() if now - b.touched > self.ttl]:
            self._items.pop(bid).cleanup()
        while len(self._items) > self.max_items:
            _, b = self._items.popitem(last=False)
            b.cleanup()

    def __len__(self):
        return len(self._items)


store = SessionStore()
