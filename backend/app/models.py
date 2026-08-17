from pydantic import BaseModel, Field


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=6, max_length=128)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    username: str


class ChatMessage(BaseModel):
    message: str = Field(min_length=1)


class UpdateMessageRequest(BaseModel):
    message: str = Field(min_length=1)


class TypingEvent(BaseModel):
    type: str = "typing"
