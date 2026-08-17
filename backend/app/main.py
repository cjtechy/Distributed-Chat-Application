from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import ValidationError

from app.database import postgres_status
from app.models import ChatMessage
from app.redis import redis_status

FRONTEND_INDEX = Path(__file__).resolve().parents[2] / "frontend" / "index.html"

app = FastAPI(title="Distributed Chat Application")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ConnectionManager:
    """Keeps track of every open WebSocket on this single server."""

    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, data: dict):
        for connection in list(self.active_connections):
            try:
                await connection.send_json(data)
            except Exception:
                self.disconnect(connection)


manager = ConnectionManager()


@app.get("/")
async def index():
    if FRONTEND_INDEX.exists():
        return FileResponse(FRONTEND_INDEX)
    return {"message": "api server running"}


@app.get("/status")
async def status():
    return {
        "message": "api server running",
        "postgres": postgres_status(),
        "redis": await redis_status(),
        "websocket_clients": len(manager.active_connections),
    }


@app.websocket("/ws")
async def websocket_chat(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            payload = await websocket.receive_json()
            try:
                chat_message = ChatMessage.model_validate(payload)
            except ValidationError:
                await websocket.send_json(
                    {
                        "error": "Send JSON like "
                        '{"username": "Alice", "message": "Hello everyone"}'
                    }
                )
                continue

            await manager.broadcast(chat_message.model_dump())
    except WebSocketDisconnect:
        manager.disconnect(websocket)
