import os
from pathlib import Path

import redis.asyncio as redis
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)

REDIS_HOST = os.getenv("REDIS_HOST", "127.0.0.1")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
REDIS_PASSWORD = os.getenv("REDIS_PASSWORD", "")
REDIS_DB = int(os.getenv("REDIS_DB", "0"))
REDIS_URL = (
    f"redis://:{REDIS_PASSWORD}@{REDIS_HOST}:{REDIS_PORT}/{REDIS_DB}"
    if REDIS_PASSWORD
    else f"redis://{REDIS_HOST}:{REDIS_PORT}/{REDIS_DB}"
)

redis_client = redis.from_url(REDIS_URL, decode_responses=True)


async def redis_status():
    """Ping Redis. Pub/Sub is not used yet."""
    try:
        await redis_client.ping()
        return {
            "connected": True,
            "host": REDIS_HOST,
            "port": REDIS_PORT,
            "db": REDIS_DB,
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
            "error": message,
        }
