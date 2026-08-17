from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    """Shape of every chat message sent over the WebSocket."""

    username: str = Field(min_length=1)
    message: str = Field(min_length=1)
