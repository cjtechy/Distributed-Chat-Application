import asyncio
import os
import secrets
import time
from collections import OrderedDict
from pathlib import Path
from typing import Awaitable, Callable

import redis.asyncio as redis
from dotenv import load_dotenv

from app.security import sign_bus_payload, verify_bus_payload

load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)

REDIS_HOST = os.getenv("REDIS_HOST", "127.0.0.1")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
REDIS_PASSWORD = os.getenv("REDIS_PASSWORD", "")
REDIS_DB = int(os.getenv("REDIS_DB", "0"))
REDIS_CHAT_CHANNEL = os.getenv("REDIS_CHAT_CHANNEL", "chat:messages")
REDIS_INBOUND_CHANNEL = os.getenv("REDIS_INBOUND_CHANNEL", "chat:inbound")
REDIS_ONLINE_KEY = os.getenv("REDIS_ONLINE_KEY", "chat:online_users")
REDIS_USERNAME_KEY = os.getenv("REDIS_USERNAME_KEY", "chat:usernames")
REDIS_URL = (
    f"redis://:{REDIS_PASSWORD}@{REDIS_HOST}:{REDIS_PORT}/{REDIS_DB}"
    if REDIS_PASSWORD
    else f"redis://{REDIS_HOST}:{REDIS_PORT}/{REDIS_DB}"
)

redis_client = redis.from_url(REDIS_URL, decode_responses=True)

# L1: process-local hashmap. L2: Redis hash `chat:usernames`.
_USERNAME_CACHE_MAX = 8000
_TTL_TAKEN = 600.0
_TTL_FREE = 30.0
_username_map: OrderedDict[str, tuple[bool, float]] = OrderedDict()


def _memory_get(name: str) -> bool | None:
    item = _username_map.get(name)
    if item is None:
        return None
    taken, expires_at = item
    if time.monotonic() >= expires_at:
        _username_map.pop(name, None)
        return None
    _username_map.move_to_end(name)
    return taken


def _memory_set(name: str, taken: bool) -> None:
    ttl = _TTL_TAKEN if taken else _TTL_FREE
    _username_map[name] = (taken, time.monotonic() + ttl)
    _username_map.move_to_end(name)
    while len(_username_map) > _USERNAME_CACHE_MAX:
        _username_map.popitem(last=False)


async def get_cached_username_taken(name: str) -> bool | None:
    cached = _memory_get(name)
    if cached is not None:
        return cached
    try:
        raw = await redis_client.hget(REDIS_USERNAME_KEY, name)
    except Exception:
        return None
    if raw is None:
        return None
    taken = False
    try:
        flag, exp = raw.split(":", 1)
        if time.time() >= float(exp):
            await redis_client.hdel(REDIS_USERNAME_KEY, name)
            return None
        taken = flag == "1"
    except ValueError:
        taken = raw in {"1", "true", "taken"}
    _memory_set(name, taken)
    return taken


async def cache_username_taken(name: str, taken: bool) -> None:
    _memory_set(name, taken)
    ttl = _TTL_TAKEN if taken else _TTL_FREE
    payload = f"{1 if taken else 0}:{time.time() + ttl}"
    try:
        await redis_client.hset(REDIS_USERNAME_KEY, name, payload)
    except Exception:
        return


async def invalidate_username_cache(name: str) -> None:
    _username_map.pop(name, None)
    try:
        await redis_client.hdel(REDIS_USERNAME_KEY, name)
    except Exception:
        return


async def publish_message(message: dict):
    await redis_client.publish(REDIS_CHAT_CHANNEL, sign_bus_payload(message))


WS_TICKET_PREFIX = "chat:ws_ticket:"
WS_TICKET_TTL_S = 30


async def issue_ws_ticket(username: str) -> str:
    ticket = secrets.token_urlsafe(32)
    await redis_client.setex(f"{WS_TICKET_PREFIX}{ticket}", WS_TICKET_TTL_S, username)
    return ticket


def group_members_key(group_id: int) -> str:
    return f"chat:group:{group_id}:members"


def group_online_key(group_id: int) -> str:
    return f"{REDIS_ONLINE_KEY}:{group_id}"


async def add_group_member_cache(group_id: int, username: str) -> None:
    try:
        await redis_client.sadd(group_members_key(group_id), username)
    except Exception:
        return


async def sync_group_membership(pairs: list[tuple[int, str]]) -> None:
    if not pairs:
        return
    try:
        pipe = redis_client.pipeline()
        for group_id, username in pairs:
            pipe.sadd(group_members_key(group_id), username)
        await pipe.execute()
    except Exception:
        return


async def get_online_users(group_id: int = 1) -> list[str]:
    return sorted(await redis_client.hkeys(group_online_key(group_id)))


async def mark_user_online(username: str, group_id: int = 1) -> tuple[list[str], bool]:
    count = await redis_client.hincrby(group_online_key(group_id), username, 1)
    return await get_online_users(group_id), count == 1


async def mark_user_offline(username: str, group_id: int = 1) -> bool:
    count = await redis_client.hincrby(group_online_key(group_id), username, -1)
    if count <= 0:
        await redis_client.hdel(group_online_key(group_id), username)
        return True
    return False


async def start_inbound_subscriber(on_message: Callable[[dict], Awaitable[None]]):
    """Accept chat text from the Erlang messaging node and persist it."""
    await _run_subscriber(REDIS_INBOUND_CHANNEL, on_message)


async def _run_subscriber(channel: str, on_message: Callable[[dict], Awaitable[None]]):
    pubsub = redis_client.pubsub()
    await pubsub.subscribe(channel)

    try:
        while True:
            incoming = await pubsub.get_message(
                ignore_subscribe_messages=True,
                timeout=1.0,
            )
            if incoming is None:
                await asyncio.sleep(0.01)
                continue
            if incoming.get("type") != "message":
                continue

            payload = verify_bus_payload(incoming["data"])
            if payload is None:
                continue
            await on_message(payload)
    finally:
        await pubsub.unsubscribe(channel)
        await pubsub.aclose()


async def redis_status():
    try:
        await redis_client.ping()
        return {
            "connected": True,
            "host": REDIS_HOST,
            "port": REDIS_PORT,
            "db": REDIS_DB,
            "channel": REDIS_CHAT_CHANNEL,
            "inbound_channel": REDIS_INBOUND_CHANNEL,
        }
    except Exception as exc:
        message = str(exc)
        if REDIS_PASSWORD:
            message = message.replace(REDIS_PASSWORD, "****")
        return {
            "connected": False,
            "host": REDIS_HOST,
            "port": REDIS_PORT,
            "db": REDIS_DB,
            "channel": REDIS_CHAT_CHANNEL,
            "inbound_channel": REDIS_INBOUND_CHANNEL,
            "error": message,
        }
