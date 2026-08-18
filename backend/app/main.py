import asyncio
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from dotenv import load_dotenv
from fastapi import APIRouter, Cookie, Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from app.auth import (
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)
from app.database import (
    close_pool,
    community_stats,
    count_admins,
    create_group,
    create_user,
    delete_member,
    delete_message,
    delete_message_by_id,
    ensure_default_group,
    get_group,
    get_message_by_id,
    get_or_create_direct_chat,
    get_recent_messages,
    get_user_by_username,
    is_group_member,
    list_direct_chats,
    list_groups,
    list_group_memberships,
    list_people,
    add_group_member,
    mark_group_read,
    mark_messages_delivered,
    mark_messages_viewed,
    list_members,
    open_pool,
    postgres_status,
    set_member_admin,
    unread_inbox,
    update_message,
)
from app.message_writer import message_writer
from app.models import (
    AdminRoleRequest,
    AuthResponse,
    ChatMessage,
    CreateGroupRequest,
    DirectChatRequest,
    LoginRequest,
    RegisterRequest,
    UpdateMessageRequest,
    UsernameCheckResponse,
)
from app.redis import (
    add_group_member_cache,
    cache_username_taken,
    get_cached_username_taken,
    get_online_users,
    invalidate_username_cache,
    issue_ws_ticket,
    publish_message,
    redis_status,
    start_inbound_subscriber,
    sync_group_membership,
)
from app.security import (
    SESSION_COOKIE,
    clear_session_cookie,
    rate_limiter,
    set_session_cookie,
    validate_secret_key,
)

load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"
LANDING_PAGE = FRONTEND_DIR / "index.html"
CONSOLE_DIR = FRONTEND_DIR / "console"
CONSOLE_DASHBOARD = CONSOLE_DIR / "index.html"
CONSOLE_CHAT = CONSOLE_DIR / "chat.html"
CONSOLE_GROUP = CONSOLE_DIR / "group.html"
CONSOLE_DIRECT = CONSOLE_DIR / "direct.html"
CONSOLE_SETTINGS = CONSOLE_DIR / "settings.html"
ADMIN_PAGE = FRONTEND_DIR / "admin.html"
AUTH_LOGIN_PAGE = FRONTEND_DIR / "auth" / "login.html"
AUTH_REGISTER_PAGE = FRONTEND_DIR / "auth" / "register.html"

inbound_task: asyncio.Task | None = None


def _cors_origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "*").strip()
    if not raw or raw == "*":
        return ["*"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


def get_current_user(
    authorization: str | None = Header(default=None),
    dc_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> str:
    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
    elif dc_session:
        token = dc_session
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    username = decode_access_token(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return username


async def get_current_admin(username: str = Depends(get_current_user)) -> dict:
    user = await get_user_by_username(username)
    if not user or not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


@asynccontextmanager
async def lifespan(app: FastAPI):
    global inbound_task

    validate_secret_key()
    await open_pool()
    await sync_group_membership(await list_group_memberships())
    await message_writer.start()
    inbound_task = asyncio.create_task(
        start_inbound_subscriber(handle_erlang_inbound),
        name="redis-inbound-subscriber",
    )
    yield
    if inbound_task:
        inbound_task.cancel()
        try:
            await inbound_task
        except asyncio.CancelledError:
            pass
    await message_writer.stop()
    await close_pool()


def parse_group_id(raw) -> int:
    try:
        group_id = int(raw)
    except (TypeError, ValueError):
        return 1
    return group_id if group_id > 0 else 1


async def require_group_member(username: str, group_id: int) -> None:
    if not await is_group_member(group_id, username):
        raise HTTPException(status_code=403, detail="You are not a member of this group")


async def handle_erlang_inbound(data: dict) -> None:
    """Persist chat text published by the Erlang messaging node."""
    username = data.get("username")
    if not isinstance(username, str) or not username:
        return
    group_id = parse_group_id(data.get("group_id"))
    if data.get("type") == "typing":
        await publish_message({"type": "typing", "username": username, "group_id": group_id})
        return
    if data.get("type") in {"viewed", "delivered"}:
        raw_ids = data.get("ids")
        if not isinstance(raw_ids, list):
            raw_ids = [data.get("id")] if data.get("id") is not None else []
        if data.get("type") == "viewed":
            changed = await mark_messages_viewed(username, raw_ids)
        else:
            changed = await mark_messages_delivered(username, raw_ids)
        if changed:
            await publish_message({"type": data["type"], "ids": changed, "group_id": group_id})
        return
    try:
        chat_message = ChatMessage.model_validate({"message": data.get("message")})
    except ValidationError:
        return
    saved = await message_writer.save(username, chat_message.message, group_id)
    await publish_message(saved)


app = FastAPI(title="Distributed Chat Application", lifespan=lifespan)

_cors = _cors_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors,
    allow_credentials=_cors != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if request.url.path.startswith("/v1"):
        response.headers["Cache-Control"] = "no-store"
    return response

api_v1 = APIRouter(prefix="/v1")


@app.get("/")
async def landing():
    if LANDING_PAGE.exists():
        return FileResponse(LANDING_PAGE)
    return {"message": "api server running"}


@app.get("/index.html")
async def landing_html():
    return await landing()


@app.get("/console")
@app.get("/console/")
@app.get("/console/index.html")
async def console_dashboard():
    if CONSOLE_DASHBOARD.exists():
        return FileResponse(CONSOLE_DASHBOARD)
    raise HTTPException(status_code=404, detail="Console page not found")


@app.get("/console/chat")
@app.get("/console/chat.html")
async def console_chat():
    if CONSOLE_CHAT.exists():
        return FileResponse(CONSOLE_CHAT)
    raise HTTPException(status_code=404, detail="Chat page not found")


@app.get("/console/group")
@app.get("/console/group.html")
async def console_group():
    if CONSOLE_GROUP.exists():
        return FileResponse(CONSOLE_GROUP)
    raise HTTPException(status_code=404, detail="Groups page not found")


@app.get("/console/direct")
@app.get("/console/direct.html")
async def console_direct():
    if CONSOLE_DIRECT.exists():
        return FileResponse(CONSOLE_DIRECT)
    raise HTTPException(status_code=404, detail="Direct messages page not found")


@app.get("/console/settings")
@app.get("/console/settings.html")
async def console_settings():
    if CONSOLE_SETTINGS.exists():
        return FileResponse(CONSOLE_SETTINGS)
    raise HTTPException(status_code=404, detail="Settings page not found")


@app.get("/chat")
@app.get("/chat.html")
async def chat_app():
    return RedirectResponse("/console/chat", status_code=307)


@app.get("/admin")
async def admin_app():
    if ADMIN_PAGE.exists():
        return FileResponse(ADMIN_PAGE)
    raise HTTPException(status_code=404, detail="Admin page not found")


@app.get("/admin.html")
async def admin_app_html():
    return await admin_app()


@app.get("/auth/login")
async def auth_login():
    if AUTH_LOGIN_PAGE.exists():
        return FileResponse(AUTH_LOGIN_PAGE)
    raise HTTPException(status_code=404, detail="Login page not found")


@app.get("/auth/login.html")
async def auth_login_html():
    return await auth_login()


@app.get("/auth/register")
async def auth_register():
    if AUTH_REGISTER_PAGE.exists():
        return FileResponse(AUTH_REGISTER_PAGE)
    raise HTTPException(status_code=404, detail="Register page not found")


@app.get("/auth/register.html")
async def auth_register_html():
    return await auth_register()


@app.get("/config.js")
async def frontend_config():
    config_file = FRONTEND_DIR / "config.js"
    if config_file.exists():
        return FileResponse(config_file, media_type="application/javascript")
    raise HTTPException(status_code=404, detail="config.js not found")


@api_v1.get("/username-available", response_model=UsernameCheckResponse)
async def username_available(
    request: Request,
    username: str = Query(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_]{3,32}$"),
):
    rate_limiter.check(request, "username-available", 60, 60)
    name = username.strip()
    if len(name) < 3:
        raise HTTPException(status_code=422, detail="Username must be 3 to 32 characters")

    taken = await get_cached_username_taken(name)
    if taken is None:
        taken = await get_user_by_username(name) is not None
        await cache_username_taken(name, taken)

    return UsernameCheckResponse(username=name, available=not taken)


@api_v1.post("/register", response_model=AuthResponse)
async def register(payload: RegisterRequest, request: Request, response: Response):
    rate_limiter.check(request, "register", 5, 60)
    cached_taken = await get_cached_username_taken(payload.username)
    if cached_taken:
        raise HTTPException(status_code=400, detail="Username already taken")

    existing = await get_user_by_username(payload.username)
    if existing:
        await cache_username_taken(payload.username, True)
        raise HTTPException(status_code=400, detail="Username already taken")

    is_admin = await count_admins() == 0
    await create_user(payload.username, hash_password(payload.password), is_admin=is_admin)
    await cache_username_taken(payload.username, True)
    await add_group_member_cache(await ensure_default_group(), payload.username)
    token = create_access_token(payload.username)
    set_session_cookie(response, token)
    return AuthResponse(access_token=token, username=payload.username, is_admin=is_admin)


@api_v1.post("/login", response_model=AuthResponse)
async def login(payload: LoginRequest, request: Request, response: Response):
    rate_limiter.check(request, "login", 10, 60)
    user = await get_user_by_username(payload.username)
    if not user or not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    token = create_access_token(user["username"])
    set_session_cookie(response, token)
    return AuthResponse(
        access_token=token,
        username=user["username"],
        is_admin=bool(user.get("is_admin")),
    )


@api_v1.post("/logout")
async def logout(response: Response):
    clear_session_cookie(response)
    return {"ok": True}


@api_v1.get("/ws-ticket")
async def ws_ticket(username: str = Depends(get_current_user)):
    ticket = await issue_ws_ticket(username)
    return {"ticket": ticket, "expires_in": 30}


@api_v1.get("/me")
async def me(username: str = Depends(get_current_user)):
    user = await get_user_by_username(username)
    return {
        "username": username,
        "is_admin": bool(user and user.get("is_admin")),
    }


@api_v1.get("/groups")
async def groups(username: str = Depends(get_current_user)):
    return await list_groups(username)


@api_v1.post("/groups")
async def groups_create(payload: CreateGroupRequest, username: str = Depends(get_current_user)):
    name = payload.name.strip()
    if len(name) < 2:
        raise HTTPException(status_code=422, detail="Group name must be at least 2 characters")
    group = await create_group(name, username)
    await add_group_member_cache(group["id"], username)
    return group


@api_v1.get("/groups/{group_id}")
async def groups_get(group_id: int, username: str = Depends(get_current_user)):
    group = await get_group(group_id, username)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    if not group["is_member"]:
        raise HTTPException(status_code=403, detail="You are not a member of this group")
    await add_group_member_cache(group_id, username)
    return group


@api_v1.post("/groups/{group_id}/join")
async def groups_join(group_id: int, username: str = Depends(get_current_user)):
    group = await get_group(group_id, username)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    if group.get("is_direct"):
        raise HTTPException(status_code=400, detail="This is a private conversation")
    added = await add_group_member(group_id, username)
    await add_group_member_cache(group_id, username)
    group = await get_group(group_id, username)
    return {"joined": added or True, **group}


@api_v1.get("/people")
async def people(username: str = Depends(get_current_user)):
    return await list_people(username)


@api_v1.get("/direct")
async def direct_chats(username: str = Depends(get_current_user)):
    return await list_direct_chats(username)


@api_v1.get("/inbox")
async def inbox(username: str = Depends(get_current_user)):
    return await unread_inbox(username)


@api_v1.post("/groups/{group_id}/read")
async def groups_read(group_id: int, username: str = Depends(get_current_user)):
    await require_group_member(username, group_id)
    await mark_group_read(group_id, username)
    return await unread_inbox(username)


@api_v1.post("/direct")
async def direct_open(payload: DirectChatRequest, username: str = Depends(get_current_user)):
    try:
        group = await get_or_create_direct_chat(username, payload.username)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await add_group_member_cache(group["id"], username)
    peer = group.get("peer") or payload.username.strip()
    await add_group_member_cache(group["id"], peer)
    return group


@api_v1.get("/messages")
async def messages(
    username: str = Depends(get_current_user),
    group_id: int = Query(default=1, ge=1),
):
    await require_group_member(username, group_id)
    return await get_recent_messages(group_id=group_id)


@api_v1.get("/messages/{message_id}")
async def get_message(message_id: int, username: str = Depends(get_current_user)):
    message = await get_message_by_id(message_id)
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    if not await is_group_member(message["group_id"], username):
        raise HTTPException(status_code=404, detail="Message not found")
    return message


@api_v1.patch("/messages/{message_id}")
async def edit_message(
    message_id: int,
    payload: UpdateMessageRequest,
    username: str = Depends(get_current_user),
):
    updated = await update_message(
        message_id,
        username,
        payload.message,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Message not found or not yours")

    event = {"type": "update", **updated}
    await publish_message(event)
    return updated


@api_v1.delete("/messages/{message_id}")
async def remove_message(message_id: int, username: str = Depends(get_current_user)):
    deleted = await delete_message(message_id, username)
    if not deleted:
        raise HTTPException(status_code=404, detail="Message not found or not yours")

    await publish_message({"type": "delete", "id": deleted["id"], "group_id": deleted["group_id"]})
    return {"id": deleted["id"]}


@api_v1.get("/online")
async def online(
    group_id: int = Query(default=1, ge=1),
    username: str = Depends(get_current_user),
):
    await require_group_member(username, group_id)
    max_users = int(os.getenv("MAX_GROUP_USERS", "1000"))
    users = await get_online_users(group_id)
    return {"users": users, "count": len(users), "max_users": max_users}


@api_v1.get("/health")
async def health():
    return {"ok": True}


@api_v1.get("/status")
async def status(_username: str = Depends(get_current_user)):
    return {
        "message": "api server running",
        "postgres": await postgres_status(),
        "redis": await redis_status(),
        "message_writer_queue": message_writer.queue_depth,
        "messaging": "erlang/otp (WebSockets are not served by FastAPI)",
    }


@api_v1.get("/admin/overview")
async def admin_overview(_admin: dict = Depends(get_current_admin)):
    stats = await community_stats()
    online = await get_online_users()
    max_users = int(os.getenv("MAX_GROUP_USERS", "1000"))
    return {
        **stats,
        "online": {"users": online, "count": len(online), "max_users": max_users},
        "postgres": await postgres_status(),
        "redis": await redis_status(),
        "message_writer_queue": message_writer.queue_depth,
    }


@api_v1.get("/admin/members")
async def admin_members(_admin: dict = Depends(get_current_admin)):
    return await list_members()


@api_v1.patch("/admin/members/{username}")
async def admin_set_role(
    username: str,
    payload: AdminRoleRequest,
    admin: dict = Depends(get_current_admin),
):
    try:
        updated = await set_member_admin(username, payload.is_admin)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not updated:
        raise HTTPException(status_code=404, detail="Member not found")
    return updated


@api_v1.delete("/admin/members/{username}")
async def admin_remove_member(username: str, admin: dict = Depends(get_current_admin)):
    if username == admin["username"]:
        raise HTTPException(status_code=400, detail="You cannot remove your own account")
    try:
        deleted = await delete_member(username)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="Member not found")
    await invalidate_username_cache(username)
    return {"username": username}


@api_v1.get("/admin/messages")
async def admin_messages(_admin: dict = Depends(get_current_admin)):
    return await get_recent_messages(limit=100)


@api_v1.delete("/admin/messages/{message_id}")
async def admin_remove_message(message_id: int, _admin: dict = Depends(get_current_admin)):
    deleted = await delete_message_by_id(message_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Message not found")
    await publish_message({"type": "delete", "id": deleted["id"], "group_id": deleted["group_id"]})
    return {"id": deleted["id"]}


app.include_router(api_v1)

app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets")
app.mount("/scripts", StaticFiles(directory=FRONTEND_DIR / "scripts"), name="scripts")
