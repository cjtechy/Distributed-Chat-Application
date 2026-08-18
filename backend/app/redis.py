import asyncio
import json
import os
from pathlib import Path
from typing import Awaitable, Callable

import redis.asyncio as redis
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)

REDIS_HOST = os.getenv("REDIS_HOST", "127.0.0.1")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
REDIS_PASSWORD = os.getenv("REDIS_PASSWORD", "")
REDIS_DB = int(os.getenv("REDIS_DB", "0"))
REDIS_CHAT_CHANNEL = os.getenv("REDIS_CHAT_CHANNEL", "chat:messages")
REDIS_INBOUND_CHANNEL = os.getenv("REDIS_INBOUND_CHANNEL", "chat:inbound")
REDIS_ONLINE_KEY = os.getenv("REDIS_ONLINE_KEY", "chat:online_users")
REDIS_URL = (
    f"redis://:{REDIS_PASSWORD}@{REDIS_HOST}:{REDIS_PORT}/{REDIS_DB}"
    if REDIS_PASSWORD
    else f"redis://{REDIS_HOST}:{REDIS_PORT}/{REDIS_DB}"
)

redis_client = redis.from_url(REDIS_URL, decode_responses=True)


async def publish_message(message: dict):
    await redis_client.publish(REDIS_CHAT_CHANNEL, json.dumps(message))


async def get_online_users() -> list[str]:
    return sorted(await redis_client.hkeys(REDIS_ONLINE_KEY))


async def mark_user_online(username: str) -> tuple[list[str], bool]:
    count = await redis_client.hincrby(REDIS_ONLINE_KEY, username, 1)
    return await get_online_users(), count == 1


async def mark_user_offline(username: str) -> bool:
    count = await redis_client.hincrby(REDIS_ONLINE_KEY, username, -1)
    if count <= 0:
        await redis_client.hdel(REDIS_ONLINE_KEY, username)
        return True
    return False


async def start_inbound_subscriber(on_message: Callable[[dict], Awaitable[None]]):
    """Accept chat text from the Erlang messaging node and persist it."""
    await _run_subscriber(REDIS_INBOUND_CHANNEL, on_message)


async def start_subscriber(on_message: Callable[[dict], Awaitable[None]]):
    """Listen on Redis and deliver messages to local WebSocket clients."""
    await _run_subscriber(REDIS_CHAT_CHANNEL, on_message)


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

            data = json.loads(incoming["data"])
            await on_message(data)
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
