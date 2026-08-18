import os
from pathlib import Path

from dotenv import load_dotenv
from psycopg_pool import AsyncConnectionPool

load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)

POSTGRES_HOST = os.getenv("POSTGRES_HOST", "127.0.0.1")
POSTGRES_PORT = int(os.getenv("POSTGRES_PORT", "5432"))
POSTGRES_USER = os.getenv("POSTGRES_USER", "postgres")
POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "")
POSTGRES_DB = os.getenv("POSTGRES_DB", "chat")
POSTGRES_POOL_MIN = int(os.getenv("POSTGRES_POOL_MIN", "2"))
POSTGRES_POOL_MAX = int(os.getenv("POSTGRES_POOL_MAX", "20"))

POSTGRES_CONNINFO = (
    f"host={POSTGRES_HOST} port={POSTGRES_PORT} "
    f"user={POSTGRES_USER} password={POSTGRES_PASSWORD} "
    f"dbname={POSTGRES_DB} connect_timeout=3"
)

pool: AsyncConnectionPool | None = None


async def open_pool() -> None:
    global pool
    pool = AsyncConnectionPool(
        conninfo=POSTGRES_CONNINFO,
        min_size=POSTGRES_POOL_MIN,
        max_size=POSTGRES_POOL_MAX,
        open=False,
    )
    await pool.open()
    await init_db()


async def close_pool() -> None:
    global pool
    if pool is not None:
        await pool.close()
        pool = None


async def init_db() -> None:
    assert pool is not None
    async with pool.connection() as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                username TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        await conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_messages_id_desc
            ON messages (id DESC)
            """
        )
        await conn.commit()


def _row_to_message(row: tuple) -> dict:
    return {
        "id": row[0],
        "username": row[1],
        "message": row[2],
        "created_at": row[3].isoformat(),
    }


async def create_user(username: str, password_hash: str) -> dict:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            """
            INSERT INTO users (username, password_hash)
            VALUES (%s, %s)
            RETURNING id, username, created_at
            """,
            (username, password_hash),
        )
        row = await result.fetchone()
        await conn.commit()

    return {
        "id": row[0],
        "username": row[1],
        "created_at": row[2].isoformat(),
    }


async def get_user_by_username(username: str) -> dict | None:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            """
            SELECT id, username, password_hash, created_at
            FROM users
            WHERE username = %s
            """,
            (username,),
        )
        row = await result.fetchone()

    if row is None:
        return None

    return {
        "id": row[0],
        "username": row[1],
        "password_hash": row[2],
        "created_at": row[3].isoformat(),
    }


async def save_message(username: str, message: str) -> dict:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            """
            INSERT INTO messages (username, message)
            VALUES (%s, %s)
            RETURNING id, username, message, created_at
            """,
            (username, message),
        )
        row = await result.fetchone()
        await conn.commit()

    return _row_to_message(row)


async def save_messages_batch(items: list[tuple[str, str]]) -> list[dict]:
    """Insert many messages in one round-trip to reduce Postgres overhead."""
    assert pool is not None
    if not items:
        return []

    placeholders = ", ".join(["(%s, %s)"] * len(items))
    params: list[str] = []
    for username, message in items:
        params.extend([username, message])

    async with pool.connection() as conn:
        result = await conn.execute(
            f"""
            INSERT INTO messages (username, message)
            VALUES {placeholders}
            RETURNING id, username, message, created_at
            """,
            params,
        )
        rows = await result.fetchall()
        await conn.commit()

    return [_row_to_message(row) for row in rows]


async def get_message_by_id(message_id: int) -> dict | None:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            """
            SELECT id, username, message, created_at
            FROM messages
            WHERE id = %s
            """,
            (message_id,),
        )
        row = await result.fetchone()

    if row is None:
        return None

    return _row_to_message(row)


async def update_message(message_id: int, username: str, message: str) -> dict | None:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            """
            UPDATE messages
            SET message = %s
            WHERE id = %s AND username = %s
            RETURNING id, username, message, created_at
            """,
            (message, message_id, username),
        )
        row = await result.fetchone()
        await conn.commit()

    if row is None:
        return None

    return _row_to_message(row)


async def delete_message(message_id: int, username: str) -> bool:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            """
            DELETE FROM messages
            WHERE id = %s AND username = %s
            RETURNING id
            """,
            (message_id, username),
        )
        row = await result.fetchone()
        await conn.commit()

    return row is not None


async def get_recent_messages(limit: int = 50) -> list[dict]:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            """
            SELECT id, username, message, created_at
            FROM messages
            ORDER BY id DESC
            LIMIT %s
            """,
            (limit,),
        )
        rows = await result.fetchall()

    messages = [_row_to_message(row) for row in rows]
    messages.reverse()
    return messages


async def postgres_status() -> dict:
    try:
        assert pool is not None
        async with pool.connection() as conn:
            await conn.execute("SELECT 1")
        stats = pool.get_stats()
        return {
            "connected": True,
            "user": POSTGRES_USER,
            "database": POSTGRES_DB,
            "pool_size": stats.get("pool_size"),
            "pool_available": stats.get("pool_available"),
            "pool_max": POSTGRES_POOL_MAX,
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
