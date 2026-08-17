import os
from pathlib import Path

import psycopg
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)

POSTGRES_HOST = os.getenv("POSTGRES_HOST", "127.0.0.1")
POSTGRES_PORT = int(os.getenv("POSTGRES_PORT", "5432"))
POSTGRES_USER = os.getenv("POSTGRES_USER", "postgres")
POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "")
POSTGRES_DB = os.getenv("POSTGRES_DB", "chat")


def postgres_status():
    """Ping PostgreSQL. Messages are not stored yet."""
    try:
        with psycopg.connect(
            host=POSTGRES_HOST,
            port=POSTGRES_PORT,
            user=POSTGRES_USER,
            password=POSTGRES_PASSWORD,
            dbname=POSTGRES_DB,
            connect_timeout=3,
        ) as conn:
            conn.execute("SELECT 1")
        return {
            "connected": True,
            "user": POSTGRES_USER,
            "database": POSTGRES_DB,
        }
    except Exception as exc:
        message = str(exc)
        if POSTGRES_PASSWORD:
            message = message.replace(POSTGRES_PASSWORD, "****")
        return {
            "connected": False,
            "user": POSTGRES_USER,
            "database": POSTGRES_DB,
            "error": message,
        }
