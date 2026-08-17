import asyncio
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import ValidationError

from app.auth import (
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)
from app.database import (
    close_pool,
    create_user,
    delete_message,
    get_message_by_id,
    get_recent_messages,
    get_user_by_username,
    open_pool,
    postgres_status,
    save_message,
    update_message,
)
from app.models import AuthResponse, ChatMessage, LoginRequest, RegisterRequest, UpdateMessageRequest
from app.redis import (
    get_online_users,
    mark_user_offline,
    mark_user_online,
    publish_message,
    redis_status,
    start_subscriber,
)

load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"
LANDING_PAGE = FRONTEND_DIR / "index.html"
CHAT_PAGE = FRONTEND_DIR / "chat.html"


def _cors_origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "*").strip()
    if not raw or raw == "*":
        return ["*"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


class ConnectionManager:
    """Tracks every WebSocket connected to this server process."""

    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def deliver(self, data: dict):
        for connection in list(self.active_connections):
            try:
                await connection.send_json(data)
            except Exception:
                self.disconnect(connection)


manager = ConnectionManager()
subscriber_task: asyncio.Task | None = None


def get_current_user(authorization: str = Header(...)) -> str:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")

    username = decode_access_token(authorization.removeprefix("Bearer ").strip())
    if not username:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    return username


@asynccontextmanager
async def lifespan(app: FastAPI):
    global subscriber_task

    await open_pool()
    subscriber_task = asyncio.create_task(
        start_subscriber(manager.deliver),
        name="redis-chat-subscriber",
    )
    yield
    if subscriber_task:
        subscriber_task.cancel()
        try:
            await subscriber_task
        except asyncio.CancelledError:
            pass
    await close_pool()


app = FastAPI(title="Distributed Chat Application", lifespan=lifespan)

_cors = _cors_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors,
    allow_credentials=_cors != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

api_v1 = APIRouter(prefix="/v1")


@app.get("/")
async def landing():
    if LANDING_PAGE.exists():
        return FileResponse(LANDING_PAGE)
    return {"message": "api server running"}


@app.get("/index.html")
async def landing_html():
    return await landing()


@app.get("/chat")
async def chat_app():
    if CHAT_PAGE.exists():
        return FileResponse(CHAT_PAGE)
    raise HTTPException(status_code=404, detail="Chat page not found")


@app.get("/chat.html")
async def chat_app_html():
    return await chat_app()


@app.get("/config.js")
async def frontend_config():
    config_file = FRONTEND_DIR / "config.js"
    if config_file.exists():
        return FileResponse(config_file, media_type="application/javascript")
    raise HTTPException(status_code=404, detail="config.js not found")


@api_v1.post("/register", response_model=AuthResponse)
async def register(payload: RegisterRequest):
    existing = await get_user_by_username(payload.username)
    if existing:
        raise HTTPException(status_code=400, detail="Username already taken")

    await create_user(payload.username, hash_password(payload.password))
    token = create_access_token(payload.username)
    return AuthResponse(access_token=token, username=payload.username)


@api_v1.post("/login", response_model=AuthResponse)
async def login(payload: LoginRequest):
    user = await get_user_by_username(payload.username)
    if not user or not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    token = create_access_token(user["username"])
    return AuthResponse(access_token=token, username=user["username"])


@api_v1.get("/me")
def me(username: str = Depends(get_current_user)):
    return {"username": username}


@api_v1.get("/messages")
async def messages(username: str = Depends(get_current_user)):
    return await get_recent_messages()


@api_v1.get("/messages/{message_id}")
async def get_message(message_id: int, username: str = Depends(get_current_user)):
    message = await get_message_by_id(message_id)
    if not message:
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

    await publish_message({"type": "delete", "id": message_id})
    return {"id": message_id}


@api_v1.get("/online")
async def online():
    return {"users": await get_online_users()}


@api_v1.get("/status")
async def status():
    return {
        "message": "api server running",
        "postgres": await postgres_status(),
        "redis": await redis_status(),
        "websocket_clients": len(manager.active_connections),
    }


@api_v1.websocket("/ws")
async def websocket_chat(websocket: WebSocket, token: str = Query(...)):
    username = decode_access_token(token)
    if not username:
        await websocket.close(code=1008, reason="Invalid or expired token")
        return

    await manager.connect(websocket)
    try:
        online_users, is_newly_online = await mark_user_online(username)
        await websocket.send_json({"type": "online_list", "users": online_users})
        if is_newly_online:
            await publish_message({"type": "online", "username": username})

        while True:
            payload = await websocket.receive_json()

            if payload.get("type") == "typing":
                await publish_message({"type": "typing", "username": username})
                continue

            try:
                chat_message = ChatMessage.model_validate(payload)
            except ValidationError:
                await websocket.send_json(
                    {
                        "error": 'Send JSON like {"message": "Hello everyone"} '
                        'or {"type": "typing"}'
                    }
                )
                continue

            saved = await save_message(username, chat_message.message)
            await publish_message(saved)
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket)
        went_offline = await mark_user_offline(username)
        if went_offline:
            await publish_message({"type": "offline", "username": username})


app.include_router(api_v1)
