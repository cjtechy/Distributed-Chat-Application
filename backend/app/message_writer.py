import asyncio
import os
from dataclasses import dataclass

from app.database import save_message, save_messages_batch

_SENTINEL = object()


@dataclass
class _Pending:
    username: str
    message: str
    group_id: int
    future: asyncio.Future


class MessageWriter:
    """Buffers chat inserts and flushes them in batches to reduce Postgres load."""

    def __init__(self, batch_size: int, flush_interval: float):
        self.batch_size = max(1, batch_size)
        self.flush_interval = max(0.0, flush_interval)
        self._queue: asyncio.Queue = asyncio.Queue()
        self._task: asyncio.Task | None = None

    @property
    def queue_depth(self) -> int:
        return self._queue.qsize()

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="message-writer")

    async def stop(self) -> None:
        await self._queue.put(_SENTINEL)
        if self._task is not None:
            await self._task
            self._task = None

    async def save(self, username: str, message: str, group_id: int = 1) -> dict:
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        await self._queue.put(_Pending(username, message, group_id, future))
        return await future

    async def _run(self) -> None:
        pending: list[_Pending] = []

        while True:
            try:
                timeout = self.flush_interval if pending and self.flush_interval > 0 else None
                item = await asyncio.wait_for(self._queue.get(), timeout=timeout)
            except asyncio.TimeoutError:
                await self._flush(pending)
                pending = []
                continue

            if item is _SENTINEL:
                await self._flush(pending)
                break

            pending.append(item)
            if len(pending) >= self.batch_size:
                await self._flush(pending)
                pending = []

    async def _flush(self, pending: list[_Pending]) -> None:
        if not pending:
            return

        items = [(p.username, p.message, p.group_id) for p in pending]

        try:
            if len(items) == 1:
                saved = await save_message(items[0][0], items[0][1], items[0][2])
                results = [saved]
            else:
                results = await save_messages_batch(items)
        except Exception as exc:
            for p in pending:
                if not p.future.done():
                    p.future.set_exception(exc)
            pending.clear()
            return

        for p, saved in zip(pending, results):
            if not p.future.done():
                p.future.set_result(saved)
        pending.clear()


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name, str(default)).strip()
    try:
        return float(raw)
    except ValueError:
        return default


message_writer = MessageWriter(
    batch_size=_env_int("MESSAGE_BATCH_SIZE", 25),
    flush_interval=_env_float("MESSAGE_FLUSH_MS", 50) / 1000.0,
)
