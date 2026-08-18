import os


CALL_SIGNAL_TYPES = {
    "call_invite",
    "call_accept",
    "call_reject",
    "call_hangup",
    "call_offer",
    "call_answer",
    "call_ice",
    "call_sfu_answer",
}


def ice_servers() -> list[dict]:
    servers: list[dict] = [{"urls": ["stun:stun.l.google.com:19302"]}]
    extra = os.getenv("STUN_URLS", "").strip()
    if extra:
        servers = [{"urls": [item.strip() for item in extra.split(",") if item.strip()]}] + servers
    turn_url = os.getenv("TURN_URL", "").strip()
    if turn_url:
        entry: dict = {"urls": [turn_url]}
        username = os.getenv("TURN_USERNAME", "").strip()
        credential = os.getenv("TURN_PASSWORD", "").strip()
        if username:
            entry["username"] = username
        if credential:
            entry["credential"] = credential
        servers.append(entry)
    return servers


def webrtc_mode() -> str:
    mode = os.getenv("WEBRTC_MODE", "p2p").strip().lower()
    return "sfu" if mode == "sfu" else "p2p"
