import os
from pathlib import Path

from dotenv import load_dotenv
from psycopg.errors import UniqueViolation
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
        await conn.execute(
            """
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE
            """
        )
        await conn.execute(
            """
            ALTER TABLE messages
            ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ
            """
        )
        await conn.execute(
            """
            ALTER TABLE messages
            ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS groups (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                created_by TEXT NOT NULL,
                is_default BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        await conn.execute(
            """
            ALTER TABLE groups
            ADD COLUMN IF NOT EXISTS is_direct BOOLEAN NOT NULL DEFAULT FALSE
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS group_members (
                group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                username TEXT NOT NULL,
                joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (group_id, username)
            )
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS direct_chats (
                user_low TEXT NOT NULL,
                user_high TEXT NOT NULL,
                group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                PRIMARY KEY (user_low, user_high)
            )
            """
        )
        await conn.execute(
            """
            ALTER TABLE group_members
            ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            """
        )
        await conn.execute(
            """
            ALTER TABLE messages
            ADD COLUMN IF NOT EXISTS group_id INTEGER
            """
        )
        await conn.commit()
    await ensure_default_group()
    await _bootstrap_admin()


def _row_to_message(row: tuple) -> dict:
    viewed_at = row[4] if len(row) > 4 else None
    delivered_at = row[5] if len(row) > 5 else None
    group_id = row[6] if len(row) > 6 else 1
    created_at = row[3]
    return {
        "id": row[0],
        "username": row[1],
        "message": row[2],
        "created_at": created_at.isoformat() if hasattr(created_at, "isoformat") else created_at,
        "viewed": viewed_at is not None,
        "delivered": delivered_at is not None or viewed_at is not None,
        "group_id": int(group_id) if group_id is not None else 1,
    }


async def create_user(username: str, password_hash: str, is_admin: bool = False) -> dict:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            """
            INSERT INTO users (username, password_hash, is_admin)
            VALUES (%s, %s, %s)
            RETURNING id, username, created_at, is_admin
            """,
            (username, password_hash, is_admin),
        )
        row = await result.fetchone()
        await conn.commit()

    await add_user_to_default_group(username)

    return {
        "id": row[0],
        "username": row[1],
        "created_at": row[2].isoformat(),
        "is_admin": row[3],
    }


async def get_user_by_username(username: str) -> dict | None:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            """
            SELECT id, username, password_hash, created_at, is_admin
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
        "is_admin": bool(row[4]),
    }


def _public_user(row: tuple) -> dict:
    return {
        "id": row[0],
        "username": row[1],
        "created_at": row[2].isoformat(),
        "is_admin": bool(row[3]),
    }


async def count_admins() -> int:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute("SELECT COUNT(*) FROM users WHERE is_admin = TRUE")
        row = await result.fetchone()
    return int(row[0]) if row else 0


async def community_stats() -> dict:
    assert pool is not None
    async with pool.connection() as conn:
        members = await conn.execute("SELECT COUNT(*) FROM users")
        admins = await conn.execute("SELECT COUNT(*) FROM users WHERE is_admin = TRUE")
        messages = await conn.execute("SELECT COUNT(*) FROM messages")
        member_count = (await members.fetchone())[0]
        admin_count = (await admins.fetchone())[0]
        message_count = (await messages.fetchone())[0]
    return {
        "members": int(member_count),
        "admins": int(admin_count),
        "messages": int(message_count),
    }


async def list_members(limit: int = 200) -> list[dict]:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            """
            SELECT id, username, created_at, is_admin
            FROM users
            ORDER BY is_admin DESC, created_at ASC
            LIMIT %s
            """,
            (limit,),
        )
        rows = await result.fetchall()
    return [_public_user(row) for row in rows]


async def set_member_admin(username: str, is_admin: bool) -> dict | None:
    assert pool is not None
    if not is_admin:
        remaining = await count_admins()
        user = await get_user_by_username(username)
        if user and user["is_admin"] and remaining <= 1:
            raise ValueError("Cannot remove the last admin")

    async with pool.connection() as conn:
        result = await conn.execute(
            """
            UPDATE users
            SET is_admin = %s
            WHERE username = %s
            RETURNING id, username, created_at, is_admin
            """,
            (is_admin, username),
        )
        row = await result.fetchone()
        await conn.commit()
    if row is None:
        return None
    return _public_user(row)


async def delete_member(username: str) -> bool:
    assert pool is not None
    user = await get_user_by_username(username)
    if not user:
        return False
    if user["is_admin"] and await count_admins() <= 1:
        raise ValueError("Cannot remove the last admin")

    async with pool.connection() as conn:
        await conn.execute("DELETE FROM group_members WHERE username = %s", (username,))
        await conn.execute(
            "DELETE FROM direct_chats WHERE user_low = %s OR user_high = %s",
            (username, username),
        )
        await conn.execute("DELETE FROM users WHERE username = %s", (username,))
        await conn.commit()
    return True


async def delete_message_by_id(message_id: int) -> dict | None:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            "DELETE FROM messages WHERE id = %s RETURNING id, group_id",
            (message_id,),
        )
        row = await result.fetchone()
        await conn.commit()
    if row is None:
        return None
    return {"id": row[0], "group_id": row[1] or 1}


async def _bootstrap_admin() -> None:
    admin_username = os.getenv("ADMIN_USERNAME", "").strip()
    admin_password = os.getenv("ADMIN_PASSWORD", "").strip()
    if not admin_username:
        return

    existing = await get_user_by_username(admin_username)
    if existing:
        if not existing["is_admin"]:
            await set_member_admin(admin_username, True)
        return

    if not admin_password:
        return

    from app.auth import hash_password

    await create_user(admin_username, hash_password(admin_password), is_admin=True)


async def save_message(username: str, message: str, group_id: int = 1) -> dict:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            """
            INSERT INTO messages (username, message, group_id)
            VALUES (%s, %s, %s)
            RETURNING id, username, message, created_at, viewed_at, delivered_at, group_id
            """,
            (username, message, group_id),
        )
        row = await result.fetchone()
        await conn.commit()

    return _row_to_message(row)


async def save_messages_batch(items: list[tuple[str, str, int]]) -> list[dict]:
    """Insert many messages in one round-trip to reduce Postgres overhead."""
    assert pool is not None
    if not items:
        return []

    placeholders = ", ".join(["(%s, %s, %s)"] * len(items))
    params: list = []
    for username, message, group_id in items:
        params.extend([username, message, group_id])

    async with pool.connection() as conn:
        result = await conn.execute(
            f"""
            INSERT INTO messages (username, message, group_id)
            VALUES {placeholders}
            RETURNING id, username, message, created_at, viewed_at, delivered_at, group_id
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
            SELECT id, username, message, created_at, viewed_at, delivered_at, group_id
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
            RETURNING id, username, message, created_at, viewed_at, delivered_at, group_id
            """,
            (message, message_id, username),
        )
        row = await result.fetchone()
        await conn.commit()

    if row is None:
        return None

    return _row_to_message(row)


async def delete_message(message_id: int, username: str) -> dict | None:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            """
            DELETE FROM messages
            WHERE id = %s AND username = %s
            RETURNING id, group_id
            """,
            (message_id, username),
        )
        row = await result.fetchone()
        await conn.commit()

    if row is None:
        return None
    return {"id": row[0], "group_id": row[1] or 1}


async def get_recent_messages(limit: int = 50, group_id: int | None = None) -> list[dict]:
    assert pool is not None
    async with pool.connection() as conn:
        if group_id is None:
            result = await conn.execute(
                """
                SELECT id, username, message, created_at, viewed_at, delivered_at, group_id
                FROM messages
                ORDER BY id DESC
                LIMIT %s
                """,
                (limit,),
            )
        else:
            result = await conn.execute(
                """
                SELECT id, username, message, created_at, viewed_at, delivered_at, group_id
                FROM messages
                WHERE group_id = %s
                ORDER BY id DESC
                LIMIT %s
                """,
                (group_id, limit),
            )
        rows = await result.fetchall()

    messages = [_row_to_message(row) for row in rows]
    messages.reverse()
    return messages


def _clean_message_ids(ids: list) -> list[int]:
    clean: list[int] = []
    for item in ids[:50]:
        try:
            message_id = int(item)
        except (TypeError, ValueError):
            continue
        if message_id > 0:
            clean.append(message_id)
    return clean


async def mark_messages_viewed(viewer: str, ids: list) -> list[int]:
    """Mark messages as viewed by someone other than the author. Returns newly viewed ids."""
    clean = _clean_message_ids(ids)
    if not clean:
        return []

    placeholders = ", ".join(["%s"] * len(clean))
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            f"""
            UPDATE messages
            SET viewed_at = NOW(),
                delivered_at = COALESCE(delivered_at, NOW())
            WHERE id IN ({placeholders})
              AND username <> %s
              AND viewed_at IS NULL
            RETURNING id
            """,
            [*clean, viewer],
        )
        rows = await result.fetchall()
        await conn.commit()

    return [row[0] for row in rows]


async def mark_messages_delivered(recipient: str, ids: list) -> list[int]:
    """Mark messages delivered to another member's device. Returns newly delivered ids."""
    clean = _clean_message_ids(ids)
    if not clean:
        return []

    placeholders = ", ".join(["%s"] * len(clean))
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            f"""
            UPDATE messages
            SET delivered_at = NOW()
            WHERE id IN ({placeholders})
              AND username <> %s
              AND delivered_at IS NULL
            RETURNING id
            """,
            [*clean, recipient],
        )
        rows = await result.fetchall()
        await conn.commit()

    return [row[0] for row in rows]


def _row_to_group(row: tuple) -> dict:
    is_direct = bool(row[7]) if len(row) > 7 else False
    peer = row[8] if len(row) > 8 else None
    unread = int(row[9]) if len(row) > 9 and row[9] is not None else 0
    return {
        "id": row[0],
        "name": peer if is_direct and peer else row[1],
        "created_by": row[2],
        "is_default": bool(row[3]),
        "created_at": row[4].isoformat() if hasattr(row[4], "isoformat") else row[4],
        "is_member": bool(row[5]) if len(row) > 5 else False,
        "member_count": int(row[6]) if len(row) > 6 else 0,
        "is_direct": is_direct,
        "peer": peer,
        "unread_count": unread,
    }


_GROUP_SELECT = """
            SELECT g.id, g.name, g.created_by, g.is_default, g.created_at,
                   EXISTS(
                       SELECT 1 FROM group_members m
                       WHERE m.group_id = g.id AND m.username = %s
                   ) AS is_member,
                   (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count,
                   COALESCE(g.is_direct, FALSE) AS is_direct,
                   (SELECT m.username FROM group_members m
                    WHERE m.group_id = g.id AND m.username <> %s
                    LIMIT 1) AS peer,
                   COALESCE((
                       SELECT COUNT(*)::int FROM messages msg
                       WHERE COALESCE(msg.group_id, 1) = g.id
                         AND msg.username <> %s
                         AND msg.created_at > COALESCE(
                             (SELECT m.last_read_at FROM group_members m
                              WHERE m.group_id = g.id AND m.username = %s),
                             '-infinity'::timestamptz
                         )
                   ), 0) AS unread_count
            FROM groups g
            """


async def ensure_default_group() -> int:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            "SELECT id FROM groups WHERE is_default = TRUE ORDER BY id ASC LIMIT 1"
        )
        row = await result.fetchone()
        if row is None:
            result = await conn.execute(
                """
                INSERT INTO groups (name, created_by, is_default)
                VALUES ('Community', 'system', TRUE)
                RETURNING id
                """
            )
            row = await result.fetchone()
        group_id = int(row[0])
        await conn.execute(
            """
            INSERT INTO group_members (group_id, username)
            SELECT %s, username FROM users
            ON CONFLICT DO NOTHING
            """,
            (group_id,),
        )
        await conn.execute(
            "UPDATE messages SET group_id = %s WHERE group_id IS NULL",
            (group_id,),
        )
        await conn.commit()
    return group_id


async def add_user_to_default_group(username: str) -> None:
    group_id = await ensure_default_group()
    await add_group_member(group_id, username)


async def add_group_member(group_id: int, username: str) -> bool:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            """
            INSERT INTO group_members (group_id, username)
            VALUES (%s, %s)
            ON CONFLICT DO NOTHING
            RETURNING username
            """,
            (group_id, username),
        )
        row = await result.fetchone()
        await conn.commit()
    return row is not None


async def is_group_member(group_id: int, username: str) -> bool:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            """
            SELECT 1 FROM group_members
            WHERE group_id = %s AND username = %s
            """,
            (group_id, username),
        )
        row = await result.fetchone()
    return row is not None


async def get_group(group_id: int, username: str | None = None) -> dict | None:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            _GROUP_SELECT + " WHERE g.id = %s",
            (username or "", username or "", username or "", username or "", group_id),
        )
        row = await result.fetchone()
    if row is None:
        return None
    return _row_to_group(row)


async def list_groups(username: str) -> list[dict]:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            _GROUP_SELECT
            + """
            WHERE COALESCE(g.is_direct, FALSE) = FALSE
            ORDER BY g.is_default DESC, g.created_at DESC
            """,
            (username, username, username, username),
        )
        rows = await result.fetchall()
    return [_row_to_group(row) for row in rows]


async def list_group_memberships() -> list[tuple[int, str]]:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute("SELECT group_id, username FROM group_members")
        rows = await result.fetchall()
    return [(int(row[0]), row[1]) for row in rows]


async def create_group(name: str, created_by: str) -> dict:
    assert pool is not None
    trimmed = name.strip()
    async with pool.connection() as conn:
        result = await conn.execute(
            """
            INSERT INTO groups (name, created_by, is_default)
            VALUES (%s, %s, FALSE)
            RETURNING id, name, created_by, is_default, created_at
            """,
            (trimmed, created_by),
        )
        row = await result.fetchone()
        group_id = int(row[0])
        await conn.execute(
            """
            INSERT INTO group_members (group_id, username)
            VALUES (%s, %s)
            ON CONFLICT DO NOTHING
            """,
            (group_id, created_by),
        )
        await conn.commit()
    group = await get_group(group_id, created_by)
    assert group is not None
    return group


async def list_people(username: str, limit: int = 200) -> list[dict]:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            """
            SELECT username
            FROM users
            WHERE username <> %s
            ORDER BY username ASC
            LIMIT %s
            """,
            (username, limit),
        )
        rows = await result.fetchall()
    return [{"username": row[0]} for row in rows]


async def list_direct_chats(username: str) -> list[dict]:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            _GROUP_SELECT
            + """
            JOIN group_members mine
              ON mine.group_id = g.id AND mine.username = %s
            WHERE COALESCE(g.is_direct, FALSE) = TRUE
            ORDER BY g.created_at DESC
            """,
            (username, username, username, username, username),
        )
        rows = await result.fetchall()
    return [_row_to_group(row) for row in rows]


async def get_or_create_direct_chat(me: str, other: str) -> dict:
    other_name = other.strip()
    if not other_name or other_name == me:
        raise ValueError("Choose another member to message")

    user = await get_user_by_username(other_name)
    if not user:
        raise ValueError("User not found")
    other_name = user["username"]
    if other_name == me:
        raise ValueError("You cannot message yourself")

    low, high = sorted([me, other_name])
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            """
            SELECT group_id FROM direct_chats
            WHERE user_low = %s AND user_high = %s
            """,
            (low, high),
        )
        row = await result.fetchone()
        if row:
            group_id = int(row[0])
        else:
            try:
                created = await conn.execute(
                    """
                    INSERT INTO groups (name, created_by, is_default, is_direct)
                    VALUES ('Direct', %s, FALSE, TRUE)
                    RETURNING id
                    """,
                    (me,),
                )
                created_row = await created.fetchone()
                group_id = int(created_row[0])
                await conn.execute(
                    """
                    INSERT INTO group_members (group_id, username)
                    VALUES (%s, %s), (%s, %s)
                    ON CONFLICT DO NOTHING
                    """,
                    (group_id, me, group_id, other_name),
                )
                await conn.execute(
                    """
                    INSERT INTO direct_chats (user_low, user_high, group_id)
                    VALUES (%s, %s, %s)
                    """,
                    (low, high, group_id),
                )
                await conn.commit()
            except UniqueViolation:
                await conn.rollback()
                result = await conn.execute(
                    """
                    SELECT group_id FROM direct_chats
                    WHERE user_low = %s AND user_high = %s
                    """,
                    (low, high),
                )
                row = await result.fetchone()
                if not row:
                    raise
                group_id = int(row[0])

    group = await get_group(group_id, me)
    assert group is not None
    return group


async def mark_group_read(group_id: int, username: str) -> None:
    assert pool is not None
    async with pool.connection() as conn:
        await conn.execute(
            """
            UPDATE group_members
            SET last_read_at = NOW()
            WHERE group_id = %s AND username = %s
            """,
            (group_id, username),
        )
        await conn.commit()


async def unread_inbox(username: str) -> dict:
    assert pool is not None
    async with pool.connection() as conn:
        result = await conn.execute(
            """
            SELECT
              COALESCE(SUM(CASE WHEN NOT counts.is_direct THEN counts.unread ELSE 0 END), 0)::int,
              COALESCE(SUM(CASE WHEN counts.is_direct THEN counts.unread ELSE 0 END), 0)::int
            FROM (
              SELECT COALESCE(g.is_direct, FALSE) AS is_direct,
                     (
                       SELECT COUNT(*)::int FROM messages msg
                       WHERE COALESCE(msg.group_id, 1) = g.id
                         AND msg.username <> %s
                         AND msg.created_at > COALESCE(mine.last_read_at, '-infinity'::timestamptz)
                     ) AS unread
              FROM group_members mine
              JOIN groups g ON g.id = mine.group_id
              WHERE mine.username = %s
            ) counts
            """,
            (username, username),
        )
        row = await result.fetchone()
    return {
        "groups": int(row[0] or 0) if row else 0,
        "directs": int(row[1] or 0) if row else 0,
    }


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
