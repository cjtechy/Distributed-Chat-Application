import asyncio
import json
import os
import secrets
import time
from collections import OrderedDict
from datetime import datetime, timezone
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
REDIS_PRESENCE_KEY = os.getenv("REDIS_PRESENCE_KEY", "chat:presence")
REDIS_LAST_SEEN_KEY = os.getenv("REDIS_LAST_SEEN_KEY", "chat:last_seen")
REDIS_APP_ONLINE_KEY = os.getenv("REDIS_APP_ONLINE_KEY", "chat:app_online")
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


def call_ring_key(username: str) -> str:
    return f"chat:call:ring:{username}"


async def set_call_ring(username: str, event: dict, ttl: int = 40) -> None:
    await redis_client.setex(call_ring_key(username), ttl, json.dumps(event))


async def get_call_ring(username: str) -> dict | None:
    raw = await redis_client.get(call_ring_key(username))
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


async def clear_call_ring(username: str) -> None:
    await redis_client.delete(call_ring_key(username))


def call_busy_key(username: str) -> str:
    return f"chat:call:busy:{username}"


async def set_call_busy(username: str, call_id: str, ttl: int = 50) -> None:
    await redis_client.setex(call_busy_key(username), ttl, call_id)


async def get_call_busy(username: str) -> str | None:
    return await redis_client.get(call_busy_key(username))


async def clear_call_busy(username: str) -> None:
    await redis_client.delete(call_busy_key(username))


async def user_is_busy(username: str, except_call_id: str | None = None) -> bool:
    busy = await get_call_busy(username)
    if busy and busy != except_call_id:
        return True
    ring = await get_call_ring(username)
    ring_id = ring.get("call_id") if ring else None
    if ring_id and ring_id != except_call_id:
        return True
    return False


async def clear_call_busy_if(username: str, call_id: str) -> None:
    current = await get_call_busy(username)
    if current == call_id:
        await clear_call_busy(username)


def group_live_call_key(group_id: int) -> str:
    return f"chat:call:live:{int(group_id)}"


async def set_group_live_call(group_id: int, event: dict, ttl: int = 180) -> None:
    payload = {
        "type": "call_invite",
        "call_id": str(event.get("call_id") or ""),
        "from": str(event.get("from") or "")[:32],
        "group_id": int(group_id),
        "media": event.get("media") if event.get("media") in {"audio", "video"} else "video",
    }
    if not payload["call_id"] or not payload["from"]:
        return
    await redis_client.setex(group_live_call_key(group_id), ttl, json.dumps(payload))


async def get_group_live_call(group_id: int) -> dict | None:
    raw = await redis_client.get(group_live_call_key(group_id))
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


async def clear_group_live_call(group_id: int, call_id: str | None = None) -> None:
    if call_id:
        current = await get_group_live_call(group_id)
        if not current or current.get("call_id") != call_id:
            return
    await redis_client.delete(group_live_call_key(group_id))


async def group_member_names(group_id: int) -> set[str]:
    try:
        members = await redis_client.smembers(group_members_key(group_id))
    except Exception:
        return set()
    return {name for name in members if name}


APP_ONLINE_TTL_S = 40


async def heartbeat_app(username: str) -> bool:
    """Record that this user is in the app. Returns True on offline -> online."""
    now = int(time.time())
    try:
        prev = await redis_client.hget(REDIS_APP_ONLINE_KEY, username)
        await redis_client.hset(REDIS_APP_ONLINE_KEY, username, now)
    except Exception:
        return False
    was_online = False
    if prev:
        try:
            was_online = (now - int(prev)) < APP_ONLINE_TTL_S
        except (TypeError, ValueError):
            was_online = False
    return not was_online


async def mark_app_offline(username: str) -> None:
    try:
        await redis_client.hdel(REDIS_APP_ONLINE_KEY, username)
    except Exception:
        pass
    await touch_last_seen(username)
    try:
        await publish_message({
            "type": "presence",
            "username": username,
            "online": False,
            "last_seen": int(time.time()),
        })
    except Exception:
        return


async def touch_last_seen(username: str) -> None:
    try:
        await redis_client.hset(REDIS_LAST_SEEN_KEY, username, int(time.time()))
    except Exception:
        return


async def presence_for(usernames: list[str]) -> dict[str, dict]:
    names = [name for name in usernames if name]
    if not names:
        return {}
    try:
        pipe = redis_client.pipeline()
        pipe.hmget(REDIS_PRESENCE_KEY, *names)
        pipe.hmget(REDIS_APP_ONLINE_KEY, *names)
        pipe.hmget(REDIS_LAST_SEEN_KEY, *names)
        counts, beats, seen = await pipe.execute()
    except Exception:
        return {name: {"online": False, "last_seen": None} for name in names}

    now = int(time.time())
    out: dict[str, dict] = {}
    for i, name in enumerate(names):
        raw_count = counts[i] if counts else None
        try:
            ws_online = int(raw_count) > 0
        except (TypeError, ValueError):
            ws_online = False
        raw_beat = beats[i] if beats else None
        app_online = False
        beat_ts = None
        if raw_beat:
            try:
                beat_ts = int(raw_beat)
                app_online = (now - beat_ts) < APP_ONLINE_TTL_S
            except (TypeError, ValueError):
                app_online = False
        online = ws_online or app_online
        last_seen = None
        raw_seen = seen[i] if seen else None
        if not online and beat_ts and not app_online:
            last_seen = datetime.fromtimestamp(beat_ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        elif raw_seen:
            try:
                last_seen = datetime.fromtimestamp(int(raw_seen), tz=timezone.utc).isoformat().replace("+00:00", "Z")
            except (TypeError, ValueError, OSError):
                last_seen = None
        out[name] = {"online": online, "last_seen": last_seen}
    return out


async def apply_presence(items: list[dict], key: str = "username") -> list[dict]:
    names = [item.get(key) for item in items]
    lookup = await presence_for(names)
    for item in items:
        extra = lookup.get(item.get(key) or "", {})
        item["online"] = bool(extra.get("online"))
        item["last_seen"] = extra.get("last_seen")
    return items


async def apply_peer_presence(group: dict | None) -> dict | None:
    if not group:
        return group
    peer = group.get("peer")
    if group.get("is_direct") and peer:
        extra = (await presence_for([peer])).get(peer, {})
        group["online"] = bool(extra.get("online"))
        group["last_seen"] = extra.get("last_seen")
    return group


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
