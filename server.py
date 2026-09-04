from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import random
import re
import string
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import parse_qsl, urlparse
from uuid import UUID, uuid4

import chess
import httpx
import jwt
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.gzip import GZipMiddleware

load_dotenv()
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("zamin-chess")
# Telegram bot token is part of the Bot API URL. Never print httpx request URLs.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


def normalize_supabase_url(raw: str) -> str:
    """Accept a Project URL or derive it from common Supabase Postgres URLs."""
    value = raw.strip().rstrip("/")
    if value.startswith(("https://", "http://")):
        return value
    if value.startswith(("postgres://", "postgresql://")):
        parsed = urlparse(value)
        hostname = (parsed.hostname or "").lower()
        username = parsed.username or ""
        project_ref = ""
        direct = re.fullmatch(r"db\.([a-z0-9-]+)\.supabase\.co", hostname)
        if direct:
            project_ref = direct.group(1)
        elif hostname.endswith(".pooler.supabase.com") and username.startswith("postgres."):
            project_ref = username.split(".", 1)[1]
        if project_ref and re.fullmatch(r"[a-z0-9-]+", project_ref):
            log.warning("SUPABASE_URL contained a database URL; derived the Project URL automatically")
            return f"https://{project_ref}.supabase.co"
    if value:
        log.error("SUPABASE_URL is invalid; expected https://PROJECT_REF.supabase.co")
    return ""

ROOT = Path(__file__).parent
BOT_TOKEN = os.getenv("BOT_TOKEN", "")
BOT_USERNAME = os.getenv("BOT_USERNAME", "")
BOT_APP_SHORT_NAME = os.getenv("BOT_APP_SHORT_NAME", "play")
WEBHOOK_SECRET = os.getenv("TELEGRAM_WEBHOOK_SECRET", "")
RENDER_HOSTNAME = os.getenv("RENDER_EXTERNAL_HOSTNAME", "")
APP_URL = (os.getenv("APP_URL") or (f"https://{RENDER_HOSTNAME}" if RENDER_HOSTNAME else "http://localhost:8000")).rstrip("/")
SUPABASE_URL = normalize_supabase_url(os.getenv("SUPABASE_URL", ""))
SUPABASE_KEY = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
# Manual Render services may not have Blueprint's generated APP_SECRET. The bot
# token is already a high-entropy server-only secret, so derive a separate JWT
# signing key from it instead of making Telegram login fail after deployment.
APP_SECRET = os.getenv("APP_SECRET", "") or (
    hashlib.sha256(f"zamin-session:{BOT_TOKEN}".encode()).hexdigest() if BOT_TOKEN else ""
)
DEV_AUTH = os.getenv("DEV_AUTH", "false").lower() == "true"

app = FastAPI(title="Zamin 3D Chess", version="1.2.0")
app.add_middleware(GZipMiddleware, minimum_size=900, compresslevel=5)
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")

_outbound_client: httpx.AsyncClient | None = None


def outbound_client() -> httpx.AsyncClient:
    """One keep-alive pool for Supabase and Telegram instead of a TLS handshake per call."""
    global _outbound_client
    if _outbound_client is None or _outbound_client.is_closed:
        _outbound_client = httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=6.0),
            limits=httpx.Limits(max_connections=24, max_keepalive_connections=12, keepalive_expiry=30.0),
        )
    return _outbound_client


@app.middleware("http")
async def response_optimizations(request: Request, call_next: Any) -> Response:
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "public, max-age=604800, immutable"
    elif request.url.path == "/":
        response.headers["Cache-Control"] = "no-cache"
    if "X-Content-Type-Options" not in response.headers:
        response.headers["X-Content-Type-Options"] = "nosniff"
    return response


class Store:
    def __init__(self) -> None:
        self.base = f"{SUPABASE_URL}/rest/v1" if SUPABASE_URL else ""

    @property
    def configured(self) -> bool:
        return bool(self.base and SUPABASE_KEY)

    async def call(
        self,
        method: str,
        table: str,
        *,
        params: dict[str, str] | None = None,
        body: Any = None,
        prefer: str = "return=representation",
    ) -> list[dict[str, Any]]:
        if not self.configured:
            raise HTTPException(503, "Supabase sozlanmagan")
        headers = {
            "apikey": SUPABASE_KEY,
            "Content-Type": "application/json",
            "Prefer": prefer,
        }
        # Legacy service_role keys are JWTs; modern sb_secret keys belong only in apikey.
        if SUPABASE_KEY.startswith("eyJ"):
            headers["Authorization"] = f"Bearer {SUPABASE_KEY}"
        request_args: dict[str, Any] = {"params": params, "headers": headers}
        if body is not None:
            request_args["json"] = body
        try:
            response = await outbound_client().request(method, f"{self.base}/{table}", **request_args)
        except httpx.HTTPError as exc:
            log.error("Supabase connection failed: %s", type(exc).__name__)
            raise HTTPException(502, "Supabase bilan ulanishda xato") from exc
        if response.status_code >= 400:
            log.error("Supabase %s %s: %s", method, table, response.text)
            try:
                database_error = response.json()
            except ValueError:
                database_error = {}
            if database_error.get("code") == "PGRST204":
                message = str(database_error.get("message", ""))
                missing = re.search(r"Could not find the '([^']+)' column of '([^']+)'", message)
                detail = f"{missing.group(2)}.{missing.group(1)}" if missing else "yangi ustun"
                raise HTTPException(
                    503,
                    f"Supabase sxemasi eski: {detail} topilmadi. Yangilangan schema.sql faylini SQL Editor'da to'liq Run qiling.",
                )
            if database_error.get("code") == "PGRST205":
                raise HTTPException(
                    503,
                    "Supabase jadvallari hali yaratilmagan. Supabase SQL Editor'da schema.sql faylini ishga tushiring.",
                )
            if response.status_code in (401, 403):
                raise HTTPException(
                    503,
                    "Supabase Secret key noto'g'ri yoki yetarli huquqqa ega emas.",
                )
            raise HTTPException(502, "Ma'lumotlar bazasi xatosi")
        if not response.content:
            return []
        data = response.json()
        return data if isinstance(data, list) else [data]

    async def one(self, table: str, params: dict[str, str]) -> dict[str, Any] | None:
        rows = await self.call("GET", table, params={**params, "limit": "1"})
        return rows[0] if rows else None


store = Store()


class GameSockets:
    def __init__(self) -> None:
        self.rooms: dict[str, dict[WebSocket, str | None]] = {}

    async def connect(self, game_id: str, websocket: WebSocket, user_id: str | None) -> None:
        self.rooms.setdefault(game_id, {})[websocket] = user_id

    async def broadcast_presence(self, game_id: str) -> None:
        room = self.rooms.get(game_id, {})
        payload = {
            "presence": {
                "players": len({user_id for user_id in room.values() if user_id}),
                "spectators": sum(1 for user_id in room.values() if user_id is None),
            }
        }
        for websocket in list(room):
            try:
                await websocket.send_json(payload)
            except Exception:
                self.disconnect(game_id, websocket)

    def disconnect(self, game_id: str, websocket: WebSocket) -> None:
        room = self.rooms.get(game_id)
        if not room:
            return
        room.pop(websocket, None)
        if not room:
            self.rooms.pop(game_id, None)

    def is_player_online(self, game_id: str, user_id: str) -> bool:
        return str(user_id) in {
            str(connected_id) for connected_id in self.rooms.get(str(game_id), {}).values()
            if connected_id is not None
        }

    async def broadcast(self, game: dict[str, Any]) -> None:
        game_id = str(game["id"])
        room = self.rooms.get(game_id, {})
        dead: list[WebSocket] = []
        for websocket, user_id in list(room.items()):
            try:
                await websocket.send_json({"game": public_game(game, user_id) if user_id else spectator_game(game)})
            except Exception:
                dead.append(websocket)
        for websocket in dead:
            self.disconnect(game_id, websocket)

    async def broadcast_event(self, game_id: str, payload: dict[str, Any]) -> None:
        dead: list[WebSocket] = []
        for websocket in list(self.rooms.get(game_id, {})):
            try:
                await websocket.send_json(payload)
            except Exception:
                dead.append(websocket)
        for websocket in dead:
            self.disconnect(game_id, websocket)


game_sockets = GameSockets()
reaction_limits: dict[tuple[str, str], float] = {}
pending_names: dict[str, str] = {}
awaiting_name: set[str] = set()
pending_challenges: dict[str, str] = {}


class SessionRequest(BaseModel):
    init_data: str = ""
    launch_ticket: str = ""


class ProfileRequest(BaseModel):
    full_name: str = Field(min_length=2, max_length=80)
    phone: str = Field(min_length=7, max_length=24)


class GameCreateRequest(BaseModel):
    mode: Literal["friend", "ai"]
    variant: Literal["standard", "kingofthehill", "threecheck"] = "standard"
    time_control: int = Field(default=600, ge=60, le=604800)
    increment: int = Field(default=3, ge=0, le=30)
    ai_level: int = Field(default=2, ge=1, le=4)
    casual: bool = False
    series_best_of: Literal[1, 3, 5] = 3
    opponent_id: str | None = Field(default=None, pattern=r"^\d{1,20}$")


class MoveRequest(BaseModel):
    uci: str = Field(pattern=r"^[a-h][1-8][a-h][1-8][qrbn]?$", min_length=4, max_length=5)
    expected_version: int = Field(ge=0)


class ActionRequest(BaseModel):
    action: Literal[
        "resign", "offer_draw", "accept_draw", "decline_draw", "abort", "claim_timeout",
        "request_takeback", "accept_takeback", "decline_takeback",
    ]


class ReactionRequest(BaseModel):
    emoji: Literal["👏", "⚔️", "😮", "🤝", "🔥", "GG"]


ALLOWED_REACTIONS = {"👏", "⚔️", "😮", "🤝", "🔥", "GG"}


class PreferencesRequest(BaseModel):
    theme: Literal["registan", "cyber", "ice", "volcano"]
    performance_mode: Literal["auto", "quality", "battery"] = "auto"
    board_palette: Literal["pro_green", "walnut", "slate", "contrast"] = "pro_green"
    piece_style: Literal["staunton", "modern", "royal"] = "staunton"
    board_shape: Literal["tournament", "soft", "floating"] = "tournament"


class PuzzleCompleteRequest(BaseModel):
    puzzle_id: str = Field(min_length=2, max_length=40)
    elapsed_ms: int = Field(default=0, ge=0, le=3600000)


class ClanRequest(BaseModel):
    name: str = Field(min_length=3, max_length=32)


class TournamentRequest(BaseModel):
    name: str = Field(min_length=3, max_length=48)
    max_players: int = Field(default=8, ge=4, le=32)
    variant: Literal["standard", "kingofthehill", "threecheck"] = "standard"
    time_control: int = Field(default=180, ge=60, le=1800)
    increment: int = Field(default=0, ge=0, le=30)
    clan_war: bool = False


def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None = None) -> str:
    return (dt or now()).isoformat().replace("+00:00", "Z")


def normalize_phone(value: str) -> str:
    value = re.sub(r"[^\d+]", "", value.strip())
    if value.startswith("00"):
        value = "+" + value[2:]
    if not value.startswith("+"):
        value = "+" + value
    if not re.fullmatch(r"\+[1-9]\d{6,14}", value):
        raise HTTPException(422, "Telefon raqami xalqaro formatda bo'lishi kerak")
    return value


def verify_init_data(raw: str) -> dict[str, Any]:
    if DEV_AUTH and not raw:
        return {"id": 777000, "first_name": "Demo", "last_name": "Player", "username": "demo"}
    if not BOT_TOKEN or not raw:
        raise HTTPException(401, "Telegram orqali kiring")
    values = dict(parse_qsl(raw, keep_blank_values=True))
    received_hash = values.pop("hash", "")
    auth_date = int(values.get("auth_date", "0") or 0)
    if not received_hash or abs(now().timestamp() - auth_date) > 86400:
        raise HTTPException(401, "Telegram sessiyasi eskirgan")
    check_string = "\n".join(f"{key}={values[key]}" for key in sorted(values))
    secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, received_hash):
        raise HTTPException(401, "Telegram imzosi noto'g'ri")
    try:
        return json.loads(values["user"])
    except (KeyError, json.JSONDecodeError) as exc:
        raise HTTPException(401, "Telegram foydalanuvchisi topilmadi") from exc


def make_token(user: dict[str, Any]) -> str:
    if not APP_SECRET:
        raise HTTPException(503, "APP_SECRET sozlanmagan")
    stamp = now()
    payload = {
        "sub": str(user["id"]),
        "telegram_id": str(user["id"]),
        "aud": "zamin-api",
        "iat": int(stamp.timestamp()),
        "exp": int((stamp + timedelta(hours=12)).timestamp()),
    }
    return jwt.encode(payload, APP_SECRET, algorithm="HS256")


def make_launch_ticket(user_id: str) -> str:
    """Short-lived signed ticket that survives Render restarts and multiple workers."""
    if not APP_SECRET:
        raise HTTPException(503, "APP_SECRET sozlanmagan")
    stamp = now()
    return jwt.encode({
        "sub": str(user_id), "telegram_id": str(user_id), "aud": "zamin-launch",
        "iat": int(stamp.timestamp()), "exp": int((stamp + timedelta(minutes=10)).timestamp()),
    }, APP_SECRET, algorithm="HS256")


def launch_url(user_id: str, challenge_code: str = "") -> str:
    query = f"ticket={make_launch_ticket(user_id)}"
    if challenge_code:
        query += f"&startapp=join_{challenge_code}"
    return f"{APP_URL}/?{query}"


def user_from_launch_ticket(ticket: str) -> dict[str, Any]:
    try:
        record = jwt.decode(ticket, APP_SECRET, algorithms=["HS256"], audience="zamin-launch")
        return {"id": int(record["telegram_id"])}
    except Exception as exc:
        raise HTTPException(401, "Web App havolasi eskirgan. Botga /start yuborib yangi tugmani bosing.")
    


def decode_api_token(token: str) -> dict[str, str]:
    try:
        data = jwt.decode(
            token, APP_SECRET, algorithms=["HS256"], audience="zamin-api"
        )
        return {"id": str(data["telegram_id"])}
    except Exception as exc:
        raise HTTPException(401, "Sessiya yaroqsiz") from exc


def current_user(authorization: str = Header(default="")) -> dict[str, str]:
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "Sessiya talab qilinadi")
    return decode_api_token(authorization[7:])


def game_for_player(game: dict[str, Any], user_id: str) -> str:
    if game.get("white_id") == user_id:
        return "white"
    if game.get("black_id") == user_id:
        return "black"
    raise HTTPException(403, "Siz bu o'yin ishtirokchisi emassiz")


def public_game(game: dict[str, Any], user_id: str) -> dict[str, Any]:
    """Participant view: enough to render/play, without Telegram IDs or server flags."""
    my_color = game_for_player(game, user_id)
    allowed = {
        "id", "code", "mode", "variant", "white_name", "black_name", "ai_level",
        "fen", "status", "result_reason", "turn", "time_control", "increment",
        "white_ms", "black_ms", "last_move_at", "version", "white_checks",
        "black_checks", "spectators_allowed", "tournament_id", "created_at", "updated_at",
        "ply_count", "casual", "correspondence", "series_id", "series_best_of", "series_game_no",
    }
    result = {key: value for key, value in game.items() if key in allowed}
    result["move_history"] = [
        {"uci": move.get("uci", ""), "san": move.get("san", "")}
        for move in game.get("move_history", [])
    ]
    offer_by = str(game.get("draw_offer_by") or "")
    result["draw_offer_by"] = (
        "mine" if offer_by == str(user_id) else "opponent" if offer_by else None
    )
    takeback_by = str(game.get("takeback_by") or "")
    result["takeback_by"] = (
        "mine" if takeback_by == str(user_id) else "opponent" if takeback_by else None
    )
    raw_score = game.get("series_score") if isinstance(game.get("series_score"), dict) else {}
    opponent_id = str(game.get("black_id") if my_color == "white" else game.get("white_id") or "")
    result["series_score"] = {
        "mine": int(raw_score.get(str(user_id), 0)),
        "opponent": int(raw_score.get(opponent_id, 0)),
    }
    result["my_color"] = my_color
    return result


def spectator_game(game: dict[str, Any]) -> dict[str, Any]:
    """Public game state without Telegram identifiers or private fields."""
    allowed = {
        "id", "code", "mode", "variant", "white_name", "black_name", "ai_level",
        "fen", "move_history", "status", "result_reason", "turn", "time_control",
        "increment", "white_ms", "black_ms", "last_move_at", "version",
        "white_checks", "black_checks", "created_at", "updated_at", "ply_count",
        "casual", "correspondence", "series_id", "series_best_of", "series_game_no",
    }
    result = {key: value for key, value in game.items() if key in allowed}
    result["move_history"] = [
        {"uci": move.get("uci", ""), "san": move.get("san", "")}
        for move in game.get("move_history", [])
    ]
    raw_score = game.get("series_score") if isinstance(game.get("series_score"), dict) else {}
    result["series_score"] = {
        "white": int(raw_score.get(str(game.get("white_id") or ""), 0)),
        "black": int(raw_score.get(str(game.get("black_id") or ""), 0)),
    }
    result.update(my_color="white", spectator=True)
    return result


def code() -> str:
    alphabet = string.ascii_uppercase.replace("O", "") + string.digits.replace("0", "")
    return "".join(random.SystemRandom().choice(alphabet) for _ in range(7))


async def profile_for(user_id: str) -> dict[str, Any] | None:
    return await store.one("profiles", {"telegram_id": f"eq.{user_id}", "select": "*"})


async def require_profile(user_id: str) -> dict[str, Any]:
    profile = await profile_for(user_id)
    if not profile or not profile.get("phone"):
        raise HTTPException(403, "Avval ism va telefon raqamingizni kiriting")
    return profile


async def bot_state_for(user_id: str) -> dict[str, Any]:
    """Persistent onboarding state; in-memory values remain a deployment-safe fallback."""
    try:
        return await store.one("bot_states", {"telegram_id": f"eq.{user_id}", "select": "*"}) or {}
    except HTTPException:
        return {
            "awaiting_name": str(user_id) in awaiting_name,
            "pending_name": pending_names.get(str(user_id)),
            "pending_challenge": pending_challenges.get(str(user_id)),
        }


async def save_bot_state(user_id: str, **values: Any) -> None:
    key = str(user_id)
    if "awaiting_name" in values:
        awaiting_name.add(key) if values["awaiting_name"] else awaiting_name.discard(key)
    if "pending_name" in values:
        if values["pending_name"]:
            pending_names[key] = str(values["pending_name"])
        else:
            pending_names.pop(key, None)
    if "pending_challenge" in values:
        if values["pending_challenge"]:
            pending_challenges[key] = str(values["pending_challenge"])
        else:
            pending_challenges.pop(key, None)
    try:
        await store.call("POST", "bot_states", body={
            "telegram_id": int(user_id), **values, "updated_at": iso(),
        }, prefer="resolution=merge-duplicates,return=minimal")
    except HTTPException:
        log.warning("Persistent bot state unavailable; using process memory for %s", user_id)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(ROOT / "static" / "index.html")


@app.head("/")
async def index_head() -> Response:
    return Response(status_code=200)


@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> Response:
    return Response(status_code=204)


@app.get("/privacy", response_class=HTMLResponse)
async def privacy() -> str:
    return """<!doctype html><html lang='uz'><meta charset='utf-8'><meta name='viewport' content='width=device-width'>
    <title>ZAMIN Maxfiylik siyosati</title><body style='max-width:760px;margin:60px auto;padding:20px;background:#090b0f;color:#ddd;font:16px/1.7 Arial'>
    <h1>ZAMIN 3D Chess — Maxfiylik siyosati</h1><p>Bot Telegram ID, ko‘rsatilgan ism, username (mavjud bo‘lsa),
    telefon raqami, reyting va o‘yin tarixini akkaunt, fair-play va multiplayer funksiyalari uchun saqlaydi.</p>
    <p>Telefon raqami boshqa o‘yinchilarga ko‘rsatilmaydi. Ma’lumotlar Supabase loyihasida saqlanadi; o‘yin holatini
    tekshirish uchun Render’dagi API qayta ishlaydi. Ma’lumotlar reklama uchun sotilmaydi.</p>
    <p>Akkaunt ma’lumotlarini o‘chirish yoki eksport qilish bo‘yicha bot egasiga Telegram orqali murojaat qiling.</p>
    <p><a style='color:#d6aa61' href='/'>← Arenaga qaytish</a></p></body></html>"""


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "zamin-3d-chess",
        "configuration": {
            "supabase_url": bool(SUPABASE_URL.startswith("https://")),
            "supabase_secret_key": bool(SUPABASE_KEY),
            "telegram_bot_token": bool(BOT_TOKEN),
            "app_url": bool(APP_URL.startswith("https://")),
        },
        "time": iso(),
    }


@app.head("/api/health")
async def health_head() -> Response:
    return Response(status_code=200)


@app.get("/api/config")
async def config() -> dict[str, Any]:
    return {
        "bot_username": BOT_USERNAME,
        "app_short_name": BOT_APP_SHORT_NAME,
        "dev_auth": DEV_AUTH,
        "variants": ["standard", "kingofthehill", "threecheck"],
        "themes": ["registan", "cyber", "ice", "volcano"],
        "direct_app_url": (
            f"https://t.me/{BOT_USERNAME}/{BOT_APP_SHORT_NAME}"
            if BOT_USERNAME and BOT_APP_SHORT_NAME else ""
        ),
    }


@app.post("/api/session")
async def session(body: SessionRequest) -> dict[str, Any]:
    if body.init_data:
        try:
            telegram_user = verify_init_data(body.init_data)
        except HTTPException:
            if not body.launch_ticket:
                raise
            telegram_user = user_from_launch_ticket(body.launch_ticket)
    elif body.launch_ticket:
        telegram_user = user_from_launch_ticket(body.launch_ticket)
    else:
        raise HTTPException(401, "Bot chatiga qayting, /start yuboring va ARENANI OCHISH tugmasini bosing.")
    user_id = str(telegram_user["id"])
    profile = await profile_for(user_id)
    return {
        "token": make_token(telegram_user),
        "user": telegram_user,
        "profile": profile,
        "registered": bool(profile and profile.get("phone")),
    }


@app.get("/api/session/restore")
async def restore_session(user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    profile = await profile_for(user["id"])
    return {
        "user": {"id": user["id"]},
        "profile": profile,
        "registered": bool(profile and profile.get("phone")),
    }


@app.post("/api/profile")
async def save_profile(body: ProfileRequest, user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    phone = normalize_phone(body.phone)
    full_name = body.full_name.strip()
    if len(full_name) < 2:
        raise HTTPException(422, "Ism kamida 2 ta belgidan iborat bo'lishi kerak")
    existing = await profile_for(user["id"])
    payload = {
        "telegram_id": int(user["id"]),
        "full_name": full_name,
        "phone": phone,
        "updated_at": iso(),
    }
    if existing:
        rows = await store.call("PATCH", "profiles", params={"telegram_id": f"eq.{user['id']}"}, body=payload)
    else:
        rows = await store.call("POST", "profiles", body=payload, prefer="resolution=merge-duplicates,return=representation")
    return {"profile": rows[0] if rows else payload}


@app.post("/api/preferences")
async def save_preferences(body: PreferencesRequest, user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    profile = await require_profile(user["id"])
    rows = await store.call(
        "PATCH", "profiles", params={"telegram_id": f"eq.{user['id']}"},
        body={
            "equipped_theme": body.theme,
            "performance_mode": body.performance_mode,
            "board_palette": body.board_palette,
            "piece_style": body.piece_style,
            "board_shape": body.board_shape,
            "updated_at": iso(),
        },
    )
    return {"profile": rows[0] if rows else profile}


DAILY_PUZZLE_IDS = {"silk-mate", "tower-gate", "desert-fork", "ice-backrank", "registan-pin"}


@app.post("/api/puzzles/complete")
async def complete_puzzle(body: PuzzleCompleteRequest, user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    if body.puzzle_id not in DAILY_PUZZLE_IDS:
        raise HTTPException(422, "Puzzle identifikatori noto'g'ri")
    profile = await require_profile(user["id"])
    today = now().date()
    existing = await store.one("puzzle_completions", {
        "user_id": f"eq.{user['id']}", "puzzle_id": f"eq.{body.puzzle_id}",
        "puzzle_date": f"eq.{today.isoformat()}", "select": "*",
    })
    if existing:
        return {"profile": profile, "already_completed": True}
    last_date = profile.get("last_puzzle_date")
    yesterday = today - timedelta(days=1)
    streak = int(profile.get("puzzle_streak") or 0) + 1 if last_date == yesterday.isoformat() else 1
    rating_gain = max(4, 18 - min(12, body.elapsed_ms // 15000))
    inserted = await store.call("POST", "puzzle_completions", body={
        "user_id": user["id"], "puzzle_id": body.puzzle_id,
        "puzzle_date": today.isoformat(), "elapsed_ms": body.elapsed_ms,
    }, prefer="resolution=ignore-duplicates,return=representation")
    if not inserted:
        return {"profile": await require_profile(user["id"]), "already_completed": True}
    rows = await store.call("PATCH", "profiles", params={"telegram_id": f"eq.{user['id']}"}, body={
        "puzzle_rating": int(profile.get("puzzle_rating") or 800) + rating_gain,
        "puzzle_streak": streak, "last_puzzle_date": today.isoformat(),
        "army_xp": int(profile.get("army_xp") or 0) + 12,
        "updated_at": iso(),
    })
    return {"profile": rows[0], "rating_gain": rating_gain, "xp_gain": 12, "already_completed": False}


@app.get("/api/me/games")
async def my_games(user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    uid = user["id"]
    profile = await profile_for(uid)
    rows = await store.call(
        "GET", "games",
        params={
            "or": f"(white_id.eq.{uid},black_id.eq.{uid})",
            "order": "updated_at.desc", "limit": "20",
            "select": "id,code,mode,variant,white_id,white_name,black_id,black_name,ai_level,fen,status,result_reason,turn,time_control,increment,white_ms,black_ms,last_move_at,version,rating_applied,created_at,updated_at,ply_count,casual,correspondence,series_id,series_best_of,series_game_no,series_score,tournament_id",
        },
    )
    settled = [await settle_timeout(row) for row in rows]
    rivals: list[dict[str, str]] = []
    seen: set[str] = set()
    for row in settled:
        if row.get("mode") != "friend" or not row.get("black_id"):
            continue
        opponent_id = str(row["black_id"] if str(row.get("white_id")) == uid else row.get("white_id") or "")
        if not opponent_id or opponent_id in seen:
            continue
        seen.add(opponent_id)
        rivals.append({
            "id": opponent_id,
            "name": str(row.get("black_name") if str(row.get("white_id")) == uid else row.get("white_name") or "Raqib"),
            "last_game_id": str(row["id"]),
        })
        if len(rivals) == 6:
            break
    return {"profile": profile, "games": [public_game(row, uid) for row in settled], "rivals": rivals}


@app.post("/api/games")
async def create_game(body: GameCreateRequest, user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    profile = await require_profile(user["id"])
    invited_profile = None
    if body.opponent_id and body.mode == "friend":
        if body.opponent_id == user["id"]:
            raise HTTPException(422, "O'zingizni challenge qila olmaysiz")
        invited_profile = await profile_for(body.opponent_id)
        if not invited_profile:
            raise HTTPException(404, "Tanlangan raqib topilmadi")
    correspondence = body.time_control >= 86400
    payload = {
        "code": code(), "mode": body.mode, "white_id": user["id"], "white_name": profile["full_name"],
        "variant": body.variant,
        "black_id": f"AI:{body.ai_level}" if body.mode == "ai" else None,
        "black_name": f"Zamin AI · L{body.ai_level}" if body.mode == "ai" else None,
        "ai_level": body.ai_level if body.mode == "ai" else None,
        "status": "active" if body.mode == "ai" else "waiting",
        "time_control": body.time_control, "increment": body.increment,
        "casual": body.casual or correspondence, "correspondence": correspondence,
        "invited_id": str(body.opponent_id) if invited_profile else None,
        "series_id": str(uuid4()), "series_best_of": body.series_best_of,
        "series_game_no": 1, "series_score": {}, "ply_count": 0,
        "white_ms": body.time_control * 1000, "black_ms": body.time_control * 1000,
        "last_move_at": iso() if body.mode == "ai" else None,
    }
    rows = await store.call("POST", "games", body=payload)
    game = rows[0]
    # Send invitations through the bot first. The bot can onboard a new player
    # and issue a personalised launch ticket before opening the Mini App.
    share_url = f"https://t.me/{BOT_USERNAME}?start=join_{game['code']}" if BOT_USERNAME else f"{APP_URL}/?startapp=join_{game['code']}"
    if invited_profile:
        asyncio.create_task(notify_player(
            game, str(body.opponent_id),
            f"⚔️ {profile['full_name']} sizni {body.series_best_of} o'yinlik seriyaga chorladi.",
        ))
    return {"game": public_game(game, user["id"]), "share_url": share_url}


async def claim_challenge(challenge_code: str, user_id: str, full_name: str) -> dict[str, Any]:
    challenge_code = challenge_code.upper().strip()
    if not re.fullmatch(r"[A-Z1-9]{7}", challenge_code):
        raise HTTPException(422, "Challenge kodi 7 belgidan iborat")
    game = await store.one("games", {"code": f"eq.{challenge_code}", "select": "*"})
    if not game:
        raise HTTPException(404, "Challenge topilmadi")
    if game["white_id"] == user_id or game.get("black_id") == user_id:
        return game
    if game.get("invited_id") and str(game["invited_id"]) != str(user_id):
        raise HTTPException(403, "Bu shaxsiy challenge boshqa o'yinchi uchun")
    if game.get("black_id"):
        raise HTTPException(409, "Bu challenge allaqachon qabul qilingan")
    if game.get("status") != "waiting":
        raise HTTPException(409, "Bu challenge endi faol emas")
    rows = await store.call(
        "PATCH", "games",
        params={"id": f"eq.{game['id']}", "black_id": "is.null", "status": "eq.waiting"},
        body={"black_id": user_id, "black_name": full_name, "invited_id": None, "status": "active", "last_move_at": iso(), "updated_at": iso(), "version": game["version"] + 1},
    )
    if not rows:
        raise HTTPException(409, "Challenge'ni boshqa o'yinchi qabul qildi")
    await game_sockets.broadcast(rows[0])
    asyncio.create_task(notify_player(
        rows[0], str(rows[0]["white_id"]),
        f"⚔️ {full_name} challenge'ni qabul qildi. Jang boshlandi!",
    ))
    return rows[0]


@app.post("/api/challenges/{challenge_code}/join")
async def join_game(challenge_code: str, user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    profile = await require_profile(user["id"])
    game = await claim_challenge(challenge_code, user["id"], profile["full_name"])
    return {"game": public_game(game, user["id"])}


@app.get("/api/games/{game_id}")
async def get_game(game_id: UUID, user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    game = await store.one("games", {"id": f"eq.{game_id}", "select": "*"})
    if not game:
        raise HTTPException(404, "O'yin topilmadi")
    game = await settle_timeout(game)
    return {"game": public_game(game, user["id"])}


@app.get("/api/watch/{game_code}")
async def watch_game(game_code: str) -> dict[str, Any]:
    game_code = game_code.upper().strip()
    if not re.fullmatch(r"[A-Z1-9]{7}", game_code):
        raise HTTPException(422, "Tomosha kodi noto'g'ri")
    game = await store.one("games", {"code": f"eq.{game_code}", "spectators_allowed": "eq.true", "select": "*"})
    if not game:
        raise HTTPException(404, "Tomosha uchun o'yin topilmadi")
    game = await settle_timeout(game)
    return {"game": spectator_game(game)}


@app.post("/api/games/{game_id}/rematch")
async def rematch(game_id: UUID, user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    old = await store.one("games", {"id": f"eq.{game_id}", "select": "*"})
    if not old:
        raise HTTPException(404, "O'yin topilmadi")
    game_for_player(old, user["id"])
    if old["status"] in ("waiting", "active"):
        raise HTTPException(409, "Avval joriy o'yinni yakunlang")
    existing = await store.one("games", {"rematch_of": f"eq.{game_id}", "select": "*"})
    if existing:
        game_for_player(existing, user["id"])
        return {"game": public_game(existing, user["id"]), "already_created": True}
    if old["mode"] == "ai":
        profile = await require_profile(user["id"])
        white_id, white_name = user["id"], profile["full_name"]
        black_id, black_name = old.get("black_id"), old.get("black_name")
    else:
        white_id, white_name = old.get("black_id"), old.get("black_name")
        black_id, black_name = old.get("white_id"), old.get("white_name")
    if not white_id or not black_id:
        raise HTTPException(409, "Raqib hali mavjud emas")
    best_of = int(old.get("series_best_of") or 3)
    old_score = dict(old.get("series_score") or {})
    target = best_of // 2 + 1
    series_finished = any(int(value or 0) >= target for value in old_score.values())
    payload = {
        "code": code(), "mode": old["mode"], "variant": old.get("variant", "standard"),
        "white_id": white_id, "white_name": white_name, "black_id": black_id, "black_name": black_name,
        "ai_level": old.get("ai_level"), "status": "active", "time_control": old["time_control"],
        "increment": old["increment"], "casual": old.get("casual", False),
        "correspondence": old.get("correspondence", False),
        "series_id": str(uuid4()) if series_finished else old.get("series_id") or str(uuid4()),
        "series_best_of": best_of, "series_game_no": 1 if series_finished else int(old.get("series_game_no") or 1) + 1,
        "series_score": {} if series_finished else old_score, "ply_count": 0, "rematch_of": str(game_id),
        "white_ms": old["time_control"] * 1000,
        "black_ms": old["time_control"] * 1000, "last_move_at": iso(),
    }
    try:
        rows = await store.call("POST", "games", body=payload)
    except HTTPException:
        existing = await store.one("games", {"rematch_of": f"eq.{game_id}", "select": "*"})
        if not existing:
            raise
        rows = [existing]
    opponent_id = black_id if str(white_id) == str(user["id"]) else white_id
    asyncio.create_task(notify_player(rows[0], str(opponent_id), "↻ Revansh tayyor. Navbatdagi jang boshlandi!"))
    return {"game": public_game(rows[0], user["id"])}


@app.websocket("/ws/games/{game_id}")
async def game_websocket(websocket: WebSocket, game_id: UUID) -> None:
    await websocket.accept()
    try:
        auth_message = await asyncio.wait_for(websocket.receive_json(), timeout=8)
        game = await store.one("games", {"id": f"eq.{game_id}", "select": "*"})
        if not game:
            await websocket.close(code=4404)
            return
        watch_code = str(auth_message.get("watch_code", "")).upper()
        if watch_code:
            if not game.get("spectators_allowed", True) or not hmac.compare_digest(watch_code, str(game["code"])):
                raise HTTPException(403, "Tomosha ruxsati yo'q")
            user_id = None
        else:
            user = decode_api_token(str(auth_message.get("token", "")))
            game_for_player(game, user["id"])
            user_id = user["id"]
    except Exception:
        try:
            await websocket.close(code=4403)
        except Exception:
            pass
        return
    room_id = str(game_id)
    await game_sockets.connect(room_id, websocket, user_id)
    await websocket.send_json({"game": public_game(game, user_id) if user_id else spectator_game(game)})
    await game_sockets.broadcast_presence(room_id)
    last_reaction = 0.0
    try:
        while True:
            message = await websocket.receive_text()
            if message != "ping":
                try:
                    event = json.loads(message)
                    emoji = str(event.get("reaction") or "")
                except (json.JSONDecodeError, AttributeError):
                    emoji = ""
                stamp = now().timestamp()
                if emoji in ALLOWED_REACTIONS and stamp - last_reaction >= 1.2:
                    last_reaction = stamp
                    if user_id is None:
                        reaction_name, reaction_color = "Tomoshabin", "spectator"
                    else:
                        reaction_color = game_for_player(game, user_id)
                        reaction_name = game.get("white_name") if reaction_color == "white" else game.get("black_name")
                    await game_sockets.broadcast_event(room_id, {"reaction": {"emoji": emoji, "name": reaction_name or "O'yinchi", "color": reaction_color}})
    except WebSocketDisconnect:
        game_sockets.disconnect(room_id, websocket)
        await game_sockets.broadcast_presence(room_id)
    except Exception:
        game_sockets.disconnect(room_id, websocket)
        await game_sockets.broadcast_presence(room_id)


def elapsed_ms(game: dict[str, Any]) -> int:
    if not game.get("last_move_at"):
        return 0
    started = datetime.fromisoformat(game["last_move_at"].replace("Z", "+00:00"))
    return max(0, int((now() - started).total_seconds() * 1000))


def board_from_history(game: dict[str, Any]) -> chess.Board:
    board = chess.Board()
    try:
        for recorded in game.get("move_history", []):
            board.push_uci(recorded["uci"])
    except (KeyError, ValueError, chess.IllegalMoveError) as exc:
        log.error("Corrupt move history in game %s", game.get("id"))
        raise HTTPException(409, "O'yin tarixi buzilgan") from exc
    return board


def series_result_payload(game: dict[str, Any], status: str) -> dict[str, int]:
    """Return an updated immutable series score for a newly finished game."""
    score = dict(game.get("series_score") or {})
    winner_id = game.get("white_id") if status == "white_won" else game.get("black_id") if status == "black_won" else None
    if winner_id:
        score[str(winner_id)] = int(score.get(str(winner_id), 0)) + 1
    return score


async def apply_rating(game: dict[str, Any]) -> None:
    if game.get("mode") != "friend" or game.get("rating_applied") or not game.get("black_id"):
        return
    white = await profile_for(game["white_id"])
    black = await profile_for(game["black_id"])
    if not white or not black:
        return
    score_w = 1.0 if game["status"] == "white_won" else 0.0 if game["status"] == "black_won" else 0.5
    expected_w = 1 / (1 + 10 ** ((black["rating"] - white["rating"]) / 400))
    delta = round(24 * (score_w - expected_w))
    for player, change, won in ((white, delta, score_w), (black, -delta, 1 - score_w)):
        xp_gain = 36 if won == 1 else 18 if won == 0.5 else 10
        update = {
            "rating": max(100, player["rating"] + change),
            "games_played": player["games_played"] + 1,
            "wins": player["wins"] + (1 if won == 1 else 0),
            "losses": player["losses"] + (1 if won == 0 else 0),
            "draws": player["draws"] + (1 if won == 0.5 else 0),
            "army_xp": int(player.get("army_xp") or 0) + xp_gain,
            "updated_at": iso(),
        }
        await store.call("PATCH", "profiles", params={"telegram_id": f"eq.{player['telegram_id']}"}, body=update)
    try:
        await settle_competition_progress(game, score_w)
    except Exception:
        # Social progression must never prevent a completed chess result from
        # being persisted and marked as rated.
        log.exception("Competition progression failed for game %s", game.get("id"))
    await store.call("PATCH", "games", params={"id": f"eq.{game['id']}"}, body={"rating_applied": True})


async def settle_timeout(game: dict[str, Any]) -> dict[str, Any]:
    """Persist a clock loss without trusting a browser to report it."""
    if game.get("status") != "active" or not game.get("last_move_at"):
        return game
    timed_out = game["turn"]
    remaining_key = "white_ms" if timed_out == "white" else "black_ms"
    if int(game[remaining_key]) - elapsed_ms(game) > 0:
        return game
    winner = "black" if timed_out == "white" else "white"
    try:
        board = chess.Board(game.get("fen") or chess.STARTING_FEN)
    except ValueError:
        board = board_from_history(game)
    winner_color = chess.WHITE if winner == "white" else chess.BLACK
    if board.has_insufficient_material(winner_color):
        status, reason = "draw", "timeout_insufficient_material"
    else:
        status, reason = f"{winner}_won", "timeout"
    finish_payload: dict[str, Any] = {
        "status": status, "result_reason": reason, "updated_at": iso(), "version": game["version"] + 1,
    }
    if status in ("white_won", "black_won"):
        finish_payload["series_score"] = series_result_payload(game, status)
    rows = await store.call(
        "PATCH", "games",
        params={"id": f"eq.{game['id']}", "version": f"eq.{game['version']}", "status": "eq.active"},
        body=finish_payload,
    )
    if not rows:
        return await store.one("games", {"id": f"eq.{game['id']}", "select": "*"}) or game
    updated = rows[0]
    await apply_rating(updated)
    await game_sockets.broadcast(updated)
    asyncio.create_task(notify_game_event(updated, actor_id=None))
    return updated


async def active_game_clock_worker() -> None:
    """Watch only games with connected players, keeping free-tier load tiny."""
    while True:
        await asyncio.sleep(12)
        for game_id in list(game_sockets.rooms):
            try:
                game = await store.one("games", {"id": f"eq.{game_id}", "select": "*"})
                if game:
                    await settle_timeout(game)
            except Exception:
                log.exception("Clock worker failed for game %s", game_id)


async def record_move_audit(game_id: str, ply: int, actor_id: str, uci: str, san: str, fen: str) -> None:
    """Durable audit trail runs after the authoritative game row is committed."""
    try:
        await store.call("POST", "game_moves", body={
            "game_id": game_id, "ply": ply, "player_id": actor_id,
            "uci": uci, "san": san, "fen_after": fen,
        }, prefer="resolution=ignore-duplicates,return=minimal")
    except HTTPException:
        log.exception("Move audit insert failed for %s", game_id)


@app.on_event("startup")
async def start_game_clock_worker() -> None:
    app.state.game_clock_task = asyncio.create_task(active_game_clock_worker())


@app.on_event("shutdown")
async def stop_game_clock_worker() -> None:
    global _outbound_client
    task = getattr(app.state, "game_clock_task", None)
    if task:
        task.cancel()
    if _outbound_client is not None and not _outbound_client.is_closed:
        await _outbound_client.aclose()
        _outbound_client = None


@app.post("/api/games/{game_id}/move")
async def make_move(game_id: UUID, body: MoveRequest, user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    game = await store.one("games", {"id": f"eq.{game_id}", "select": "*"})
    if not game:
        raise HTTPException(404, "O'yin topilmadi")
    player_color = game_for_player(game, user["id"])
    is_ai_turn = game.get("mode") == "ai" and player_color == "white" and game["turn"] == "black"
    color = "black" if is_ai_turn else player_color
    if game["status"] != "active":
        raise HTTPException(409, "O'yin faol emas")
    if game["turn"] != color:
        raise HTTPException(409, "Hozir sizning navbatingiz emas")
    if body.expected_version != game["version"]:
        raise HTTPException(409, "O'yin holati yangilangan; qayta urinib ko'ring")

    remaining_key = "white_ms" if color == "white" else "black_ms"
    remaining = int(game[remaining_key]) - elapsed_ms(game)
    if remaining <= 0:
        status = "black_won" if color == "white" else "white_won"
        board = board_from_history(game)
        winner_color = chess.BLACK if color == "white" else chess.WHITE
        if board.has_insufficient_material(winner_color):
            status, result_reason = "draw", "timeout_insufficient_material"
        else:
            result_reason = "timeout"
        timeout_payload: dict[str, Any] = {"status": status, "result_reason": result_reason, "updated_at": iso(), "version": game["version"] + 1}
        if status in ("white_won", "black_won"):
            timeout_payload["series_score"] = series_result_payload(game, status)
        rows = await store.call("PATCH", "games", params={"id": f"eq.{game_id}", "version": f"eq.{game['version']}"}, body=timeout_payload)
        if rows:
            await apply_rating(rows[0])
            await game_sockets.broadcast(rows[0])
            asyncio.create_task(notify_game_event(rows[0], actor_id=None))
        raise HTTPException(409, "Vaqt tugadi")

    # Rebuild the complete position so repetition and 50/75-move rules retain history.
    board = board_from_history(game)
    try:
        move = chess.Move.from_uci(body.uci)
    except ValueError as exc:
        raise HTTPException(422, "Yurish formati noto'g'ri") from exc
    if move not in board.legal_moves:
        raise HTTPException(422, "Shaxmat qoidalariga zid yurish")
    san = board.san(move)
    board.push(move)
    actor_id = game["black_id"] if is_ai_turn else user["id"]
    history = [*game.get("move_history", []), {"uci": body.uci, "san": san, "by": actor_id}]
    white_checks = int(game.get("white_checks") or 0)
    black_checks = int(game.get("black_checks") or 0)
    if board.is_check():
        if color == "white":
            white_checks += 1
        else:
            black_checks += 1
    status, reason = "active", None
    if board.is_checkmate():
        status, reason = ("white_won" if color == "white" else "black_won"), "checkmate"
    elif game.get("variant") == "kingofthehill" and board.king(chess.WHITE if color == "white" else chess.BLACK) in (chess.D4, chess.E4, chess.D5, chess.E5):
        status, reason = ("white_won" if color == "white" else "black_won"), "kingofthehill"
    elif game.get("variant") == "threecheck" and (white_checks if color == "white" else black_checks) >= 3:
        status, reason = ("white_won" if color == "white" else "black_won"), "threecheck"
    elif board.is_stalemate():
        status, reason = "draw", "stalemate"
    elif board.is_insufficient_material():
        status, reason = "draw", "insufficient_material"
    elif board.is_seventyfive_moves():
        status, reason = "draw", "seventyfive_moves"
    elif board.is_fivefold_repetition():
        status, reason = "draw", "fivefold_repetition"
    elif board.halfmove_clock >= 100:
        status, reason = "draw", "fifty_moves"
    elif board.is_repetition(3):
        status, reason = "draw", "threefold_repetition"
    payload = {
        "fen": board.fen(), "move_history": history, "status": status, "result_reason": reason,
        "turn": "black" if color == "white" else "white", "draw_offer_by": None, "takeback_by": None,
        "ply_count": len(history),
        remaining_key: remaining + int(game["increment"]) * 1000,
        "white_checks": white_checks, "black_checks": black_checks,
        "last_move_at": iso(), "updated_at": iso(), "version": game["version"] + 1,
    }
    if status in ("white_won", "black_won"):
        payload["series_score"] = series_result_payload(game, status)
    rows = await store.call(
        "PATCH", "games",
        params={"id": f"eq.{game_id}", "version": f"eq.{game['version']}", "status": "eq.active"},
        body=payload,
    )
    if not rows:
        raise HTTPException(409, "Raqib yurib bo'ldi; holat yangilandi")
    updated = rows[0]
    asyncio.create_task(record_move_audit(str(game_id), len(history), str(actor_id), body.uci, san, board.fen()))
    if status != "active":
        await apply_rating(updated)
    await game_sockets.broadcast(updated)
    asyncio.create_task(notify_game_event(updated, actor_id=str(actor_id), san=san))
    return {"game": public_game(updated, user["id"]), "move": {"uci": body.uci, "san": san}}


@app.post("/api/games/{game_id}/action")
async def game_action(game_id: UUID, body: ActionRequest, user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    game = await store.one("games", {"id": f"eq.{game_id}", "select": "*"})
    if not game:
        raise HTTPException(404, "O'yin topilmadi")
    color = game_for_player(game, user["id"])
    if game["status"] not in ("waiting", "active"):
        raise HTTPException(409, "O'yin tugagan")
    payload: dict[str, Any] = {"updated_at": iso(), "version": game["version"] + 1}
    if body.action == "resign":
        payload.update(status="black_won" if color == "white" else "white_won", result_reason="resignation")
    elif body.action == "abort" and game["status"] == "waiting":
        payload.update(status="aborted", result_reason="aborted")
    elif body.action == "offer_draw":
        board = board_from_history(game)
        if board.can_claim_threefold_repetition():
            payload.update(status="draw", result_reason="threefold_repetition", draw_offer_by=None)
        elif board.can_claim_fifty_moves():
            payload.update(status="draw", result_reason="fifty_moves", draw_offer_by=None)
        else:
            payload["draw_offer_by"] = user["id"]
    elif body.action == "decline_draw":
        if game.get("draw_offer_by") == user["id"]:
            raise HTTPException(409, "O'z taklifingizni rad eta olmaysiz")
        payload["draw_offer_by"] = None
    elif body.action == "accept_draw":
        if not game.get("draw_offer_by") or game["draw_offer_by"] == user["id"]:
            raise HTTPException(409, "Raqibdan durang taklifi yo'q")
        payload.update(status="draw", result_reason="agreement", draw_offer_by=None)
    elif body.action == "request_takeback":
        if not game.get("casual") or game.get("mode") != "friend":
            raise HTTPException(409, "Yurishni qaytarish faqat casual do'stlik jangida mavjud")
        if not game.get("move_history"):
            raise HTTPException(409, "Qaytariladigan yurish yo'q")
        if str(game["move_history"][-1].get("by") or "") != str(user["id"]):
            raise HTTPException(409, "Faqat o'zingizning oxirgi yurishingizni qaytara olasiz")
        payload["takeback_by"] = user["id"]
    elif body.action == "decline_takeback":
        if not game.get("takeback_by") or str(game["takeback_by"]) == str(user["id"]):
            raise HTTPException(409, "Raqibdan qaytarish so'rovi yo'q")
        payload["takeback_by"] = None
    elif body.action == "accept_takeback":
        if not game.get("casual") or not game.get("takeback_by") or str(game["takeback_by"]) == str(user["id"]):
            raise HTTPException(409, "Raqibdan qaytarish so'rovi yo'q")
        history = list(game.get("move_history") or [])
        removed = history.pop()
        board = board_from_history({"move_history": history, "id": game.get("id")})
        white_checks, black_checks = int(game.get("white_checks") or 0), int(game.get("black_checks") or 0)
        if "+" in str(removed.get("san") or "") or "#" in str(removed.get("san") or ""):
            if board.turn == chess.WHITE:
                white_checks = max(0, white_checks - 1)
            else:
                black_checks = max(0, black_checks - 1)
        payload.update(
            fen=board.fen(), move_history=history, ply_count=len(history),
            turn="white" if board.turn == chess.WHITE else "black", takeback_by=None,
            draw_offer_by=None, white_checks=white_checks, black_checks=black_checks,
            last_move_at=iso(),
        )
    elif body.action == "claim_timeout":
        if game["status"] != "active" or not game.get("last_move_at"):
            raise HTTPException(409, "Vaqt hisoblanmayapti")
        timed_out = game["turn"]
        remaining_key = "white_ms" if timed_out == "white" else "black_ms"
        if int(game[remaining_key]) - elapsed_ms(game) > 0:
            raise HTTPException(409, "Vaqt hali tugamagan")
        winner = "black" if timed_out == "white" else "white"
        board = board_from_history(game)
        winner_chess_color = chess.WHITE if winner == "white" else chess.BLACK
        if board.has_insufficient_material(winner_chess_color):
            payload.update(status="draw", result_reason="timeout_insufficient_material")
        else:
            payload.update(status=f"{winner}_won", result_reason="timeout")
    else:
        raise HTTPException(409, "Bu amal hozir mumkin emas")
    resulting_status = str(payload.get("status") or game.get("status"))
    if resulting_status in ("white_won", "black_won"):
        payload["series_score"] = series_result_payload(game, resulting_status)
    rows = await store.call("PATCH", "games", params={"id": f"eq.{game_id}", "version": f"eq.{game['version']}"}, body=payload)
    if not rows:
        raise HTTPException(409, "O'yin holati o'zgardi")
    if body.action == "accept_takeback":
        try:
            await store.call("DELETE", "game_moves", params={"game_id": f"eq.{game_id}", "ply": f"gt.{len(rows[0].get('move_history') or [])}"}, prefer="return=minimal")
        except HTTPException:
            log.exception("Takeback move audit cleanup failed for %s", game_id)
    if rows[0]["status"] not in ("waiting", "active"):
        await apply_rating(rows[0])
    await game_sockets.broadcast(rows[0])
    if body.action in ("offer_draw", "request_takeback") or rows[0]["status"] not in ("waiting", "active"):
        asyncio.create_task(notify_game_event(rows[0], actor_id=str(user["id"]), action=body.action))
    return {"game": public_game(rows[0], user["id"])}


@app.post("/api/games/{game_id}/reaction")
async def send_reaction(game_id: UUID, body: ReactionRequest, user: dict[str, str] = Depends(current_user)) -> dict[str, bool]:
    game = await store.one("games", {"id": f"eq.{game_id}", "select": "id,white_id,black_id,white_name,black_name"})
    if not game:
        raise HTTPException(404, "O'yin topilmadi")
    color = game_for_player(game, user["id"])
    key = (str(game_id), str(user["id"]))
    stamp = now().timestamp()
    if stamp - reaction_limits.get(key, 0) < 1.2:
        raise HTTPException(429, "Reaksiyalar orasida biroz kuting")
    reaction_limits[key] = stamp
    if len(reaction_limits) > 5000:
        cutoff = stamp - 60
        for old_key, value in list(reaction_limits.items()):
            if value < cutoff:
                reaction_limits.pop(old_key, None)
    name = game.get("white_name") if color == "white" else game.get("black_name")
    await game_sockets.broadcast_event(str(game_id), {
        "reaction": {"emoji": body.emoji, "name": name or "O'yinchi", "color": color}
    })
    return {"ok": True}


async def clan_membership(user_id: str) -> dict[str, Any] | None:
    membership = await store.one("clan_members", {"user_id": f"eq.{user_id}", "select": "*"})
    if not membership:
        return None
    clan = await store.one("clans", {"id": f"eq.{membership['clan_id']}", "select": "*"})
    if not clan:
        return None
    return {"clan": clan, "membership": membership, "member_count": len(await store.call("GET", "clan_members", params={"clan_id": f"eq.{clan['id']}", "select": "user_id"}))}


async def settle_competition_progress(game: dict[str, Any], score_w: float) -> None:
    """Award clan XP and close a one-round arena tournament idempotently."""
    rewards = ((game["white_id"], score_w), (game["black_id"], 1 - score_w))
    for user_id, score in rewards:
        membership = await store.one("clan_members", {"user_id": f"eq.{user_id}", "select": "clan_id"})
        if not membership:
            continue
        clan = await store.one("clans", {"id": f"eq.{membership['clan_id']}", "select": "id,xp"})
        if clan:
            gain = 24 if score == 1 else 12 if score == 0.5 else 6
            await store.call("PATCH", "clans", params={"id": f"eq.{clan['id']}"}, body={"xp": int(clan.get("xp") or 0) + gain})

    tournament_id = game.get("tournament_id")
    if not tournament_id:
        return
    for user_id, score in rewards:
        entry = await store.one("tournament_players", {
            "tournament_id": f"eq.{tournament_id}", "user_id": f"eq.{user_id}", "select": "score",
        })
        if entry:
            await store.call(
                "PATCH", "tournament_players",
                params={"tournament_id": f"eq.{tournament_id}", "user_id": f"eq.{user_id}"},
                body={"score": float(entry.get("score") or 0) + score},
            )
    unfinished = await store.call("GET", "games", params={
        "tournament_id": f"eq.{tournament_id}", "status": "in.(waiting,active)", "select": "id", "limit": "1",
    })
    if not unfinished:
        await store.call("PATCH", "tournaments", params={"id": f"eq.{tournament_id}"}, body={"status": "finished"})


@app.get("/api/social")
async def social_hub(user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    await require_profile(user["id"])
    clan = await clan_membership(user["id"])
    clan_leaderboard = await store.call("GET", "clans", params={"select": "id,name,code,xp", "order": "xp.desc,created_at.asc", "limit": "10"})
    tournaments = await store.call("GET", "tournaments", params={
        "status": "in.(registration,active,finished)", "order": "created_at.desc", "limit": "20", "select": "*",
    })
    tournament_ids = ",".join(str(item["id"]) for item in tournaments)
    entries = await store.call("GET", "tournament_players", params={
        "tournament_id": f"in.({tournament_ids})", "select": "tournament_id,user_id,display_name,score", "limit": "640",
    }) if tournament_ids else []
    active_games = await store.call("GET", "games", params={
        "or": f"(white_id.eq.{user['id']},black_id.eq.{user['id']})",
        "tournament_id": "not.is.null", "status": "in.(waiting,active)", "select": "*",
    })
    counts: dict[str, int] = {}
    for entry in entries:
        key = str(entry["tournament_id"])
        counts[key] = counts.get(key, 0) + 1
    for tournament in tournaments:
        tournament["player_count"] = counts.get(str(tournament["id"]), 0)
        tournament["joined"] = any(str(e["tournament_id"]) == str(tournament["id"]) and e["user_id"] == user["id"] for e in entries)
        tournament["standings"] = sorted(
            [e for e in entries if str(e["tournament_id"]) == str(tournament["id"])],
            key=lambda item: (-float(item.get("score") or 0), item["display_name"]),
        )[:3]
        own_game = next((game for game in active_games if str(game.get("tournament_id")) == str(tournament["id"])), None)
        tournament["my_game"] = public_game(own_game, user["id"]) if own_game else None
    return {"clan": clan, "clan_leaderboard": clan_leaderboard, "tournaments": tournaments}


@app.post("/api/clans")
async def create_clan(body: ClanRequest, user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    profile = await require_profile(user["id"])
    if await clan_membership(user["id"]):
        raise HTTPException(409, "Siz allaqachon jamoaga a'zosiz")
    rows = await store.call("POST", "clans", body={"code": code(), "name": body.name.strip(), "owner_id": user["id"]})
    clan = rows[0]
    await store.call("POST", "clan_members", body={"clan_id": clan["id"], "user_id": user["id"], "role": "owner"})
    return {"clan": clan, "member_count": 1, "owner_name": profile["full_name"]}


@app.post("/api/clans/{clan_code}/join")
async def join_clan(clan_code: str, user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    await require_profile(user["id"])
    if await clan_membership(user["id"]):
        raise HTTPException(409, "Avvalgi jamoangizdan chiqishingiz kerak")
    clan = await store.one("clans", {"code": f"eq.{clan_code.upper().strip()}", "select": "*"})
    if not clan:
        raise HTTPException(404, "Jamoa kodi topilmadi")
    await store.call("POST", "clan_members", body={"clan_id": clan["id"], "user_id": user["id"]})
    return {"clan": clan}


@app.post("/api/tournaments")
async def create_tournament(body: TournamentRequest, user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    profile = await require_profile(user["id"])
    membership = await clan_membership(user["id"])
    rows = await store.call("POST", "tournaments", body={
        "code": code(), "name": body.name.strip(), "owner_id": user["id"], "max_players": body.max_players,
        "variant": body.variant, "time_control": body.time_control, "increment": body.increment,
        "clan_war": body.clan_war,
    })
    tournament = rows[0]
    await store.call("POST", "tournament_players", body={
        "tournament_id": tournament["id"], "user_id": user["id"], "display_name": profile["full_name"],
        "clan_id": membership["clan"]["id"] if membership else None,
    })
    tournament["player_count"] = 1
    tournament["joined"] = True
    return {"tournament": tournament}


@app.post("/api/tournaments/{tournament_id}/join")
async def join_tournament(tournament_id: UUID, user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    profile = await require_profile(user["id"])
    tournament = await store.one("tournaments", {"id": f"eq.{tournament_id}", "select": "*"})
    if not tournament or tournament["status"] != "registration":
        raise HTTPException(409, "Turnir ro'yxati yopilgan")
    players = await store.call("GET", "tournament_players", params={"tournament_id": f"eq.{tournament_id}", "select": "user_id"})
    if any(player["user_id"] == user["id"] for player in players):
        return {"tournament": tournament, "already_joined": True}
    if len(players) >= tournament["max_players"]:
        raise HTTPException(409, "Turnir to'lgan")
    membership = await clan_membership(user["id"])
    await store.call("POST", "tournament_players", body={
        "tournament_id": str(tournament_id), "user_id": user["id"], "display_name": profile["full_name"],
        "clan_id": membership["clan"]["id"] if membership else None,
    })
    return {"tournament": tournament, "player_count": len(players) + 1}


@app.post("/api/tournaments/{tournament_id}/start")
async def start_tournament(tournament_id: UUID, user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    tournament = await store.one("tournaments", {"id": f"eq.{tournament_id}", "select": "*"})
    if not tournament or tournament["owner_id"] != user["id"]:
        raise HTTPException(403, "Faqat turnir egasi boshlaydi")
    if tournament["status"] != "registration":
        raise HTTPException(409, "Turnir allaqachon boshlangan")
    players = await store.call("GET", "tournament_players", params={"tournament_id": f"eq.{tournament_id}", "select": "*"})
    if len(players) < 4:
        raise HTTPException(409, "Turnir uchun kamida 4 o'yinchi kerak")
    random.SystemRandom().shuffle(players)
    if len(players) % 2:
        bye = players[-1]
        await store.call(
            "PATCH", "tournament_players",
            params={"tournament_id": f"eq.{tournament_id}", "user_id": f"eq.{bye['user_id']}"},
            body={"score": float(bye.get("score") or 0) + 1.0},
        )
    games: list[dict[str, Any]] = []
    for index in range(0, len(players) - 1, 2):
        white, black = players[index], players[index + 1]
        games.append({
            "code": code(), "mode": "friend", "variant": tournament["variant"],
            "white_id": white["user_id"], "white_name": white["display_name"],
            "black_id": black["user_id"], "black_name": black["display_name"], "status": "active",
            "time_control": tournament["time_control"], "increment": tournament["increment"],
            "white_ms": tournament["time_control"] * 1000, "black_ms": tournament["time_control"] * 1000,
            "last_move_at": iso(), "tournament_id": str(tournament_id),
        })
    created = await store.call("POST", "games", body=games)
    await store.call("PATCH", "tournaments", params={"id": f"eq.{tournament_id}"}, body={"status": "active", "started_at": iso()})
    return {"games_created": len(created), "games": [public_game(game, user["id"]) for game in created if user["id"] in (game["white_id"], game["black_id"])]}


async def telegram(method: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    if not BOT_TOKEN:
        return None
    try:
        response = await outbound_client().post(f"https://api.telegram.org/bot{BOT_TOKEN}/{method}", json=payload)
        data = response.json()
        if response.status_code >= 400 or not data.get("ok"):
            log.error("Telegram %s failed: %s", method, response.text)
            return None
        return data
    except (httpx.HTTPError, ValueError) as exc:
        log.error("Telegram %s connection failed: %s", method, exc)
        return None


async def notify_player(game: dict[str, Any], user_id: str, text: str) -> None:
    """Notify only a participant who does not currently have this game open."""
    user_id = str(user_id or "")
    if not BOT_TOKEN or not user_id or user_id.startswith("AI:"):
        return
    if game_sockets.is_player_online(str(game["id"]), user_id):
        return
    await telegram("sendMessage", {
        "chat_id": int(user_id),
        "text": text,
        "reply_markup": {"inline_keyboard": [[{
            "text": "♟ O‘YINGA QAYTISH",
            "web_app": {"url": launch_url(user_id, str(game["code"]))},
        }]]},
    })


async def notify_game_event(
    game: dict[str, Any], actor_id: str | None, san: str = "", action: str = "",
) -> None:
    """Send move/result/draw alerts to offline participants, never on plain app open."""
    participants = [
        ("white", str(game.get("white_id") or ""), game.get("white_name") or "Oq"),
        ("black", str(game.get("black_id") or ""), game.get("black_name") or "Qora"),
    ]
    status = str(game.get("status") or "")
    finished = status not in ("waiting", "active")
    reason_labels = {
        "checkmate": "shox mot", "timeout": "vaqt tugadi", "resignation": "taslim bo‘lish",
        "agreement": "kelishilgan durang", "threefold_repetition": "uch karra takrorlanish",
        "fivefold_repetition": "besh karra takrorlanish", "fifty_moves": "50 yurish qoidasi",
        "seventyfive_moves": "75 yurish qoidasi", "stalemate": "pat",
        "insufficient_material": "donalar yetarli emas", "timeout_insufficient_material": "vaqt va material qoidasi",
        "kingofthehill": "markaziy taxt", "threecheck": "uchinchi shax",
    }
    actor_name = next((name for _, uid, name in participants if uid == str(actor_id)), "Raqib")
    for color, user_id, _ in participants:
        if not user_id or user_id.startswith("AI:") or user_id == str(actor_id or ""):
            continue
        if finished:
            if status == "draw" or status == "aborted":
                result = "Durang" if status == "draw" else "O‘yin bekor qilindi"
            elif status == f"{color}_won":
                result = "G‘alaba!"
            else:
                result = "Mag‘lubiyat"
            reason = reason_labels.get(str(game.get("result_reason") or ""), "o‘yin yakuni")
            text = f"🏁 {result} · {reason}.\nJang: {game['code']}"
        elif action == "offer_draw":
            text = f"½ {actor_name} durang taklif qildi.\nJang: {game['code']}"
        elif action == "request_takeback":
            text = f"↶ {actor_name} oxirgi yurishni qaytarishni so'radi.\nJang: {game['code']}"
        elif san:
            marker = " — SHAX!" if "+" in san or "#" in san else ""
            text = f"♟ {actor_name} yurdi: {san}{marker}\nNavbat sizda · Jang: {game['code']}"
        else:
            continue
        await notify_player(game, user_id, text)


@app.on_event("startup")
async def configure_telegram_bot() -> None:
    """Configure Telegram automatically on every Render deploy."""
    if SUPABASE_URL:
        log.info("Supabase Project URL configured: %s", SUPABASE_URL)
    else:
        log.error("Supabase Project URL could not be configured")
    if not BOT_TOKEN:
        log.warning("BOT_TOKEN is missing; Telegram bot is disabled")
        return
    if not APP_URL.startswith("https://"):
        log.warning("APP_URL must be the public https Render URL; got %s", APP_URL)
        return

    webhook_payload: dict[str, Any] = {
        "url": f"{APP_URL}/telegram/webhook",
        "allowed_updates": ["message"],
        "drop_pending_updates": False,
    }
    if WEBHOOK_SECRET:
        webhook_payload["secret_token"] = WEBHOOK_SECRET

    webhook = await telegram("setWebhook", webhook_payload)
    if webhook:
        log.info("Telegram webhook configured: %s/telegram/webhook", APP_URL)

    await telegram("setMyCommands", {
        "commands": [
            {"command": "start", "description": "3D shaxmat arenasini ochish"},
            {"command": "play", "description": "O'yinni boshlash"},
            {"command": "name", "description": "Ismni yangilash"},
            {"command": "privacy", "description": "Maxfiylik siyosati"},
        ]
    })
    menu = await telegram("setChatMenuButton", {
        "menu_button": {
            "type": "web_app",
            "text": "3D SHAXMAT",
            "web_app": {"url": APP_URL},
        }
    })
    if menu:
        log.info("Telegram Web App menu button configured")


@app.post("/telegram/webhook")
async def telegram_webhook(request: Request, x_telegram_bot_api_secret_token: str = Header(default="")) -> JSONResponse:
    if WEBHOOK_SECRET and not hmac.compare_digest(x_telegram_bot_api_secret_token, WEBHOOK_SECRET):
        raise HTTPException(403, "Webhook secret noto'g'ri")
    update = await request.json()
    message = update.get("message", {})
    user = message.get("from", {})
    chat_id = message.get("chat", {}).get("id")
    if not user or not chat_id:
        return JSONResponse({"ok": True})
    contact = message.get("contact")
    if contact:
        if str(contact.get("user_id")) != str(user.get("id")):
            await telegram("sendMessage", {"chat_id": chat_id, "text": "Iltimos, aynan o'zingizning raqamingizni yuboring."})
            return JSONResponse({"ok": True})
        user_key = str(user["id"])
        saved_state = await bot_state_for(user_key)
        full_name = str(saved_state.get("pending_name") or pending_names.get(user_key) or "").strip() or " ".join(filter(None, [user.get("first_name"), user.get("last_name")])).strip() or "Chess player"
        payload = {
            "telegram_id": user["id"], "username": user.get("username"), "full_name": full_name,
            "phone": normalize_phone(contact["phone_number"]), "updated_at": iso(),
        }
        try:
            await store.call("POST", "profiles", body=payload, prefer="resolution=merge-duplicates,return=minimal")
        except HTTPException as exc:
            log.exception("Contact profile save failed")
            await telegram("sendMessage", {
                "chat_id": chat_id,
                "text": f"Telefon qabul qilindi, ammo bazaga saqlashda xato bor. {exc.detail}",
            })
            return JSONResponse({"ok": True})
        challenge_code = str(saved_state.get("pending_challenge") or pending_challenges.get(user_key) or "")
        await save_bot_state(user_key, awaiting_name=False, pending_name=None, pending_challenge=None)
        challenge_joined = False
        if challenge_code:
            try:
                await claim_challenge(challenge_code, user_key, full_name)
                challenge_joined = True
            except HTTPException as exc:
                await telegram("sendMessage", {"chat_id": chat_id, "text": f"Challenge'ga qo'shilmadi: {exc.detail}"})
        await telegram("sendMessage", {
            "chat_id": chat_id,
            "text": "✅ Profil tayyor. Challenge qabul qilindi va jang boshlandi!" if challenge_joined else "✅ Profil tayyor. Endi arenaga kiring!",
            "reply_markup": {"remove_keyboard": True},
        })
        await telegram("sendMessage", {
            "chat_id": chat_id, "text": "♟ ZAMIN CHESS — jangni oching",
            "reply_markup": {"inline_keyboard": [[{
                "text": "⚔️ JANGNI OCHISH" if challenge_joined else "⚔️ ARENANI OCHISH",
                "web_app": {"url": launch_url(user_key, challenge_code if challenge_joined else "")},
            }]]},
        })
    elif str(message.get("text", "")).startswith("/privacy"):
        await telegram("sendMessage", {"chat_id": chat_id, "text": f"Maxfiylik siyosati: {APP_URL}/privacy"})
    elif str(message.get("text", "")).startswith("/name"):
        await save_bot_state(str(user["id"]), awaiting_name=True, pending_name=None)
        await telegram("sendMessage", {
            "chat_id": chat_id,
            "text": "Ism va familiyangizni yozing:",
            "reply_markup": {"force_reply": True, "input_field_placeholder": "Masalan: Aziz Karimov"},
        })
    elif str(message.get("text", "")).startswith(("/start", "/play")):
        user_key = str(user["id"])
        command_parts = str(message.get("text", "")).split(maxsplit=1)
        challenge_code = ""
        if command_parts[0].startswith("/start") and len(command_parts) == 2:
            challenge_match = re.fullmatch(r"join_([A-Za-z1-9]{7})", command_parts[1].strip())
            if challenge_match:
                challenge_code = challenge_match.group(1).upper()
        await save_bot_state(user_key, pending_challenge=challenge_code or None)
        try:
            existing = await profile_for(user_key)
        except HTTPException as exc:
            log.exception("Profile lookup failed during Telegram onboarding")
            await telegram("sendMessage", {
                "chat_id": chat_id,
                "text": f"Bot ishga tushdi, ammo baza tayyor emas. {exc.detail}",
            })
            return JSONResponse({"ok": True})
        if existing:
            challenge_joined = False
            if challenge_code:
                try:
                    await claim_challenge(challenge_code, user_key, existing["full_name"])
                    challenge_joined = True
                except HTTPException as exc:
                    await telegram("sendMessage", {"chat_id": chat_id, "text": f"Challenge'ga qo'shilmadi: {exc.detail}"})
            await save_bot_state(user_key, pending_challenge=None, awaiting_name=False, pending_name=None)
            await telegram("sendMessage", {
                "chat_id": chat_id,
                "text": f"⚔️ {existing['full_name']}, challenge qabul qilindi — jang boshlandi!" if challenge_joined else f"Qaytganingizdan xursandmiz, {existing['full_name']}!",
                "reply_markup": {"inline_keyboard": [[{
                    "text": "⚔️ JANGNI OCHISH" if challenge_joined else "♟ SHAXMATNI OCHISH",
                    "web_app": {"url": launch_url(user_key, challenge_code if challenge_joined else "")},
                }]]},
            })
        else:
            await save_bot_state(user_key, awaiting_name=True)
            await telegram("sendMessage", {
                "chat_id": chat_id,
                "text": "ZAMIN 3D CHESS'ga xush kelibsiz! Avval ism va familiyangizni yozing:",
                "reply_markup": {"force_reply": True, "input_field_placeholder": "Masalan: Aziz Karimov"},
            })
    elif message.get("text"):
        user_key = str(user["id"])
        saved_state = await bot_state_for(user_key)
        if not (saved_state.get("awaiting_name") or user_key in awaiting_name):
            return JSONResponse({"ok": True})
        full_name = " ".join(str(message["text"]).split())
        if len(full_name) < 2 or len(full_name) > 80:
            await telegram("sendMessage", {"chat_id": chat_id, "text": "Ism 2–80 ta belgidan iborat bo‘lishi kerak. Qayta yozing:"})
        else:
            await save_bot_state(user_key, pending_name=full_name, awaiting_name=False)
            await telegram("sendMessage", {
                "chat_id": chat_id,
                "text": f"Rahmat, {full_name}. Endi telefon raqamingizni tasdiqlang:",
                "reply_markup": {"keyboard": [[{"text": "📱 Raqamimni tasdiqlash", "request_contact": True}]], "resize_keyboard": True, "one_time_keyboard": True},
            })
    return JSONResponse({"ok": True})


@app.exception_handler(HTTPException)
async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)
