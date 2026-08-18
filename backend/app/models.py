from pydantic import BaseModel, Field

MESSAGE_MAX_LENGTH = 4000
USERNAME_PATTERN = r"^[A-Za-z0-9_]{3,32}$"


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=USERNAME_PATTERN)
    password: str = Field(min_length=6, max_length=128)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    username: str
    is_admin: bool = False


class ChatMessage(BaseModel):
    message: str = Field(min_length=1, max_length=MESSAGE_MAX_LENGTH)


class UpdateMessageRequest(BaseModel):
    message: str = Field(min_length=1, max_length=MESSAGE_MAX_LENGTH)


class AdminRoleRequest(BaseModel):
    is_admin: bool


class UsernameCheckResponse(BaseModel):
    username: str
    available: bool


class CreateGroupRequest(BaseModel):
    name: str = Field(min_length=2, max_length=40)


class DirectChatRequest(BaseModel):
    username: str = Field(min_length=1, max_length=32)
