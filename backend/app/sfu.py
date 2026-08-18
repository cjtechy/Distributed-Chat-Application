from __future__ import annotations

import asyncio
from typing import Any

from pydantic import BaseModel, Field

from app.redis import publish_message

try:
    from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
    from aiortc.contrib.media import MediaRelay

    AIORTC_AVAILABLE = True
except ImportError:
    AIORTC_AVAILABLE = False
    RTCConfiguration = Any
    RTCIceServer = Any
    RTCPeerConnection = Any
    RTCSessionDescription = Any
    MediaRelay = Any

from app.webrtc import ice_servers


class SfuOfferRequest(BaseModel):
    sdp: str = Field(min_length=10, max_length=200_000)
    group_id: int = Field(gt=0)
    media: str = Field(default="video", pattern="^(audio|video)$")


class SfuAnswerRequest(BaseModel):
    sdp: str = Field(min_length=10, max_length=200_000)


_relay = None
_rooms: dict[str, dict[str, Any]] = {}
_lock = asyncio.Lock()


def _get_relay():
    global _relay
    if not AIORTC_AVAILABLE:
        raise RuntimeError("aiortc is not installed")
    if _relay is None:
        _relay = MediaRelay()
    return _relay


def _pc_config() -> RTCConfiguration:
    servers = []
    for item in ice_servers():
        urls = item.get("urls") or []
        servers.append(
            RTCIceServer(
                urls=urls,
                username=item.get("username"),
                credential=item.get("credential"),
            )
        )
    return RTCConfiguration(iceServers=servers)


def _require_aiortc() -> None:
    if not AIORTC_AVAILABLE:
        raise RuntimeError("SFU is unavailable. Install aiortc or use WEBRTC_MODE=p2p.")


async def join_offer(call_id: str, username: str, group_id: int, offer_sdp: str) -> str:
    _require_aiortc()
    async with _lock:
        room = _rooms.setdefault(call_id, {"group_id": group_id, "peers": {}})
        peers: dict[str, dict[str, Any]] = room["peers"]
        old = peers.pop(username, None)
        if old and old.get("pc"):
            await old["pc"].close()

        pc = RTCPeerConnection(_pc_config())
        peers[username] = {"pc": pc, "audio": None, "video": None}

        for other, state in peers.items():
            if other == username:
                continue
            for kind in ("audio", "video"):
                track = state.get(kind)
                if track is not None:
                    pc.addTrack(track)

        @pc.on("track")
        def on_track(track):
            subscribed = _get_relay().subscribe(track)
            peers[username][track.kind] = subscribed
            asyncio.create_task(_fanout_track(call_id, username, subscribed))

        await pc.setRemoteDescription(RTCSessionDescription(sdp=offer_sdp, type="offer"))
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        return pc.localDescription.sdp


async def apply_answer(call_id: str, username: str, answer_sdp: str) -> None:
    _require_aiortc()
    async with _lock:
        room = _rooms.get(call_id) or {}
        state = (room.get("peers") or {}).get(username)
        if not state:
            raise KeyError(username)
        pc = state["pc"]
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer_sdp, type="answer"))


async def leave(call_id: str, username: str) -> None:
    if not AIORTC_AVAILABLE:
        return
    async with _lock:
        room = _rooms.get(call_id)
        if not room:
            return
        state = room["peers"].pop(username, None)
        if state and state.get("pc"):
            await state["pc"].close()
        if not room["peers"]:
            _rooms.pop(call_id, None)


async def close_all() -> None:
    if not AIORTC_AVAILABLE:
        return
    async with _lock:
        for room in list(_rooms.values()):
            for state in room.get("peers", {}).values():
                pc = state.get("pc")
                if pc:
                    await pc.close()
        _rooms.clear()


async def _fanout_track(call_id: str, sender: str, track) -> None:
    async with _lock:
        room = _rooms.get(call_id)
        if not room:
            return
        group_id = room["group_id"]
        tasks = []
        for other, state in room["peers"].items():
            if other == sender:
                continue
            pc = state["pc"]
            pc.addTrack(track)
            tasks.append(_renegotiate(call_id, group_id, other, pc))
    for task in tasks:
        try:
            await task
        except Exception:
            continue


async def _renegotiate(call_id: str, group_id: int, username: str, pc) -> None:
    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await publish_message(
        {
            "type": "call_sfu_offer",
            "call_id": call_id,
            "from": "sfu",
            "to": username,
            "sdp": pc.localDescription.sdp,
            "group_id": group_id,
        }
    )
