from __future__ import annotations

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
from uuid import UUID

import chess
import httpx
import jwt
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

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
SUPABASE_ANON_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY") or os.getenv("SUPABASE_ANON_KEY", "")
APP_SECRET = os.getenv("APP_SECRET", "")
DEV_AUTH = os.getenv("DEV_AUTH", "false").lower() == "true"

app = FastAPI(title="Zamin 3D Chess", version="1.0.0")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


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
            async with httpx.AsyncClient(timeout=12) as client:
                response = await client.request(method, f"{self.base}/{table}", **request_args)
        except httpx.HTTPError as exc:
            log.error("Supabase connection failed: %s", type(exc).__name__)
            raise HTTPException(502, "Supabase bilan ulanishda xato") from exc
        if response.status_code >= 400:
            log.error("Supabase %s %s: %s", method, table, response.text)
            raise HTTPException(502, "Ma'lumotlar bazasi xatosi")
        if not response.content:
            return []
        data = response.json()
        return data if isinstance(data, list) else [data]

    async def one(self, table: str, params: dict[str, str]) -> dict[str, Any] | None:
        rows = await self.call("GET", table, params={**params, "limit": "1"})
        return rows[0] if rows else None


store = Store()


class SessionRequest(BaseModel):
    init_data: str = ""
    supabase_token: str = Field(min_length=20)


class ProfileRequest(BaseModel):
    full_name: str = Field(min_length=2, max_length=80)
    phone: str = Field(min_length=7, max_length=24)


class GameCreateRequest(BaseModel):
    mode: Literal["friend", "ai"]
    time_control: int = Field(default=600, ge=60, le=3600)
    increment: int = Field(default=3, ge=0, le=30)
    ai_level: int = Field(default=2, ge=1, le=4)


class MoveRequest(BaseModel):
    uci: str = Field(pattern=r"^[a-h][1-8][a-h][1-8][qrbn]?$", min_length=4, max_length=5)
    expected_version: int = Field(ge=0)


class ActionRequest(BaseModel):
    action: Literal["resign", "offer_draw", "accept_draw", "decline_draw", "abort", "claim_timeout"]


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


def make_token(user: dict[str, Any], auth_id: str) -> str:
    if not APP_SECRET:
        raise HTTPException(503, "APP_SECRET sozlanmagan")
    stamp = now()
    payload = {
        "sub": str(user["id"]),
        "telegram_id": str(user["id"]),
        "auth_id": auth_id,
        "aud": "zamin-api",
        "iat": int(stamp.timestamp()),
        "exp": int((stamp + timedelta(hours=12)).timestamp()),
    }
    return jwt.encode(payload, APP_SECRET, algorithm="HS256")


def current_user(authorization: str = Header(default="")) -> dict[str, str]:
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "Sessiya talab qilinadi")
    try:
        data = jwt.decode(
            authorization[7:], APP_SECRET, algorithms=["HS256"], audience="zamin-api"
        )
        return {"id": str(data["telegram_id"]), "auth_id": str(data["auth_id"])}
    except Exception as exc:
        raise HTTPException(401, "Sessiya yaroqsiz") from exc


def game_for_player(game: dict[str, Any], user_id: str) -> str:
    if game.get("white_id") == user_id:
        return "white"
    if game.get("black_id") == user_id:
        return "black"
    raise HTTPException(403, "Siz bu o'yin ishtirokchisi emassiz")


def public_game(game: dict[str, Any], user_id: str) -> dict[str, Any]:
    result = dict(game)
    result["my_color"] = game_for_player(game, user_id)
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
            "supabase_publishable_key": bool(SUPABASE_ANON_KEY),
            "supabase_secret_key": bool(SUPABASE_KEY),
            "telegram_bot_token": bool(BOT_TOKEN),
            "app_url": bool(APP_URL.startswith("https://")),
        },
        "time": iso(),
    }


@app.get("/api/config")
async def config() -> dict[str, Any]:
    return {
        "supabase_url": SUPABASE_URL,
        "supabase_anon_key": SUPABASE_ANON_KEY,
        "bot_username": BOT_USERNAME,
        "app_short_name": BOT_APP_SHORT_NAME,
        "dev_auth": DEV_AUTH,
    }


@app.post("/api/session")
async def session(body: SessionRequest) -> dict[str, Any]:
    telegram_user = verify_init_data(body.init_data)
    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        raise HTTPException(503, "Supabase public kaliti sozlanmagan")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            auth_response = await client.get(
                f"{SUPABASE_URL}/auth/v1/user",
                headers={"apikey": SUPABASE_ANON_KEY, "Authorization": f"Bearer {body.supabase_token}"},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(502, "Supabase Auth bilan ulanishda xato") from exc
    if auth_response.status_code != 200:
        raise HTTPException(401, "Supabase sessiyasi yaroqsiz")
    auth_id = str(auth_response.json()["id"])
    user_id = str(telegram_user["id"])
    auth_owner = await store.one("profiles", {"auth_id": f"eq.{auth_id}", "select": "telegram_id"})
    if auth_owner and str(auth_owner["telegram_id"]) != user_id:
        raise HTTPException(409, "SESSION_CONFLICT")
    profile = await profile_for(user_id)
    if profile and profile.get("auth_id") != auth_id:
        rows = await store.call("PATCH", "profiles", params={"telegram_id": f"eq.{user_id}"}, body={"auth_id": auth_id, "updated_at": iso()})
        profile = rows[0] if rows else profile
    return {
        "token": make_token(telegram_user, auth_id),
        "user": telegram_user,
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
        "auth_id": user["auth_id"],
        "full_name": full_name,
        "phone": phone,
        "updated_at": iso(),
    }
    if existing:
        rows = await store.call("PATCH", "profiles", params={"telegram_id": f"eq.{user['id']}"}, body=payload)
    else:
        rows = await store.call("POST", "profiles", body=payload, prefer="resolution=merge-duplicates,return=representation")
    return {"profile": rows[0] if rows else payload}


@app.get("/api/me/games")
async def my_games(user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    uid = user["id"]
    profile = await profile_for(uid)
    rows = await store.call(
        "GET", "games",
        params={
            "or": f"(white_id.eq.{uid},black_id.eq.{uid})",
            "order": "updated_at.desc", "limit": "20", "select": "*"
        },
    )
    return {"profile": profile, "games": [public_game(row, uid) for row in rows]}


@app.post("/api/games")
async def create_game(body: GameCreateRequest, user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    profile = await require_profile(user["id"])
    payload = {
        "code": code(), "mode": body.mode, "white_id": user["id"], "white_name": profile["full_name"],
        "black_id": f"AI:{body.ai_level}" if body.mode == "ai" else None,
        "black_name": f"Zamin AI · L{body.ai_level}" if body.mode == "ai" else None,
        "ai_level": body.ai_level if body.mode == "ai" else None,
        "status": "active" if body.mode == "ai" else "waiting",
        "time_control": body.time_control, "increment": body.increment,
        "white_ms": body.time_control * 1000, "black_ms": body.time_control * 1000,
        "last_move_at": iso() if body.mode == "ai" else None,
    }
    rows = await store.call("POST", "games", body=payload)
    game = rows[0]
    share_url = f"https://t.me/{BOT_USERNAME}/{BOT_APP_SHORT_NAME}?startapp=join_{game['code']}" if BOT_USERNAME else f"{APP_URL}/?startapp=join_{game['code']}"
    return {"game": public_game(game, user["id"]), "share_url": share_url}


@app.post("/api/challenges/{challenge_code}/join")
async def join_game(challenge_code: str, user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    profile = await require_profile(user["id"])
    challenge_code = challenge_code.upper().strip()
    if not re.fullmatch(r"[A-Z1-9]{7}", challenge_code):
        raise HTTPException(422, "Challenge kodi 7 belgidan iborat")
    game = await store.one("games", {"code": f"eq.{challenge_code}", "select": "*"})
    if not game:
        raise HTTPException(404, "Challenge topilmadi")
    if game["white_id"] == user["id"]:
        return {"game": public_game(game, user["id"])}
    if game.get("black_id") and game["black_id"] != user["id"]:
        raise HTTPException(409, "Bu challenge allaqachon qabul qilingan")
    rows = await store.call(
        "PATCH", "games",
        params={"id": f"eq.{game['id']}", "black_id": "is.null", "status": "eq.waiting"},
        body={"black_id": user["id"], "black_name": profile["full_name"], "status": "active", "last_move_at": iso(), "updated_at": iso(), "version": game["version"] + 1},
    )
    if not rows:
        raise HTTPException(409, "Challenge'ni boshqa o'yinchi qabul qildi")
    return {"game": public_game(rows[0], user["id"])}


@app.get("/api/games/{game_id}")
async def get_game(game_id: UUID, user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    game = await store.one("games", {"id": f"eq.{game_id}", "select": "*"})
    if not game:
        raise HTTPException(404, "O'yin topilmadi")
    return {"game": public_game(game, user["id"])}


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
        update = {
            "rating": max(100, player["rating"] + change),
            "games_played": player["games_played"] + 1,
            "wins": player["wins"] + (1 if won == 1 else 0),
            "losses": player["losses"] + (1 if won == 0 else 0),
            "draws": player["draws"] + (1 if won == 0.5 else 0),
            "updated_at": iso(),
        }
        await store.call("PATCH", "profiles", params={"telegram_id": f"eq.{player['telegram_id']}"}, body=update)
    await store.call("PATCH", "games", params={"id": f"eq.{game['id']}"}, body={"rating_applied": True})


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
        rows = await store.call("PATCH", "games", params={"id": f"eq.{game_id}", "version": f"eq.{game['version']}"}, body={"status": status, "result_reason": result_reason, "updated_at": iso(), "version": game["version"] + 1})
        if rows:
            await apply_rating(rows[0])
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
    status, reason = "active", None
    if board.is_checkmate():
        status, reason = ("white_won" if color == "white" else "black_won"), "checkmate"
    elif board.is_stalemate():
        status, reason = "draw", "stalemate"
    elif board.is_insufficient_material():
        status, reason = "draw", "insufficient_material"
    elif board.is_seventyfive_moves():
        status, reason = "draw", "seventyfive_moves"
    elif board.is_fivefold_repetition():
        status, reason = "draw", "fivefold_repetition"
    payload = {
        "fen": board.fen(), "move_history": history, "status": status, "result_reason": reason,
        "turn": "black" if color == "white" else "white", "draw_offer_by": None,
        remaining_key: remaining + int(game["increment"]) * 1000,
        "last_move_at": iso(), "updated_at": iso(), "version": game["version"] + 1,
    }
    rows = await store.call(
        "PATCH", "games",
        params={"id": f"eq.{game_id}", "version": f"eq.{game['version']}", "status": "eq.active"},
        body=payload,
    )
    if not rows:
        raise HTTPException(409, "Raqib yurib bo'ldi; holat yangilandi")
    updated = rows[0]
    try:
        await store.call("POST", "game_moves", body={"game_id": str(game_id), "ply": len(history), "player_id": actor_id, "uci": body.uci, "san": san, "fen_after": board.fen()}, prefer="resolution=ignore-duplicates,return=minimal")
    except HTTPException:
        log.exception("Move audit insert failed for %s", game_id)
    if status != "active":
        await apply_rating(updated)
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
    rows = await store.call("PATCH", "games", params={"id": f"eq.{game_id}", "version": f"eq.{game['version']}"}, body=payload)
    if not rows:
        raise HTTPException(409, "O'yin holati o'zgardi")
    if rows[0]["status"] not in ("waiting", "active"):
        await apply_rating(rows[0])
    return {"game": public_game(rows[0], user["id"])}


async def telegram(method: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    if not BOT_TOKEN:
        return None
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(f"https://api.telegram.org/bot{BOT_TOKEN}/{method}", json=payload)
        data = response.json()
        if response.status_code >= 400 or not data.get("ok"):
            log.error("Telegram %s failed: %s", method, response.text)
            return None
        return data
    except (httpx.HTTPError, ValueError) as exc:
        log.error("Telegram %s connection failed: %s", method, exc)
        return None


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
        full_name = " ".join(filter(None, [user.get("first_name"), user.get("last_name")])).strip() or "Chess player"
        payload = {
            "telegram_id": user["id"], "username": user.get("username"), "full_name": full_name,
            "phone": normalize_phone(contact["phone_number"]), "updated_at": iso(),
        }
        try:
            await store.call("POST", "profiles", body=payload, prefer="resolution=merge-duplicates,return=minimal")
        except HTTPException:
            log.exception("Contact profile save failed")
            await telegram("sendMessage", {
                "chat_id": chat_id,
                "text": "Telefon qabul qilindi, ammo bazaga saqlashda xato bor. Administrator Supabase sozlamalarini tekshirishi kerak.",
            })
            return JSONResponse({"ok": True})
        await telegram("sendMessage", {
            "chat_id": chat_id, "text": "✅ Profil tayyor. Endi 3D arenaga kiring!",
            "reply_markup": {"remove_keyboard": True},
        })
        await telegram("sendMessage", {
            "chat_id": chat_id, "text": "♟ ZAMIN 3D CHESS — o'yinni boshlang",
            "reply_markup": {"inline_keyboard": [[{"text": "⚔️ ARENANI OCHISH", "web_app": {"url": APP_URL}}]]},
        })
    elif str(message.get("text", "")).startswith("/privacy"):
        await telegram("sendMessage", {"chat_id": chat_id, "text": f"Maxfiylik siyosati: {APP_URL}/privacy"})
    elif str(message.get("text", "")).startswith(("/start", "/play")):
        try:
            existing = await profile_for(str(user["id"]))
        except HTTPException:
            log.exception("Profile lookup failed during Telegram onboarding")
            await telegram("sendMessage", {
                "chat_id": chat_id,
                "text": "Bot ishga tushdi, ammo ma'lumotlar bazasiga ulanishda xato bor. Administrator Render'dagi Supabase kalitlarini tekshirishi kerak.",
            })
            return JSONResponse({"ok": True})
        if existing:
            await telegram("sendMessage", {
                "chat_id": chat_id, "text": f"Qaytganingizdan xursandmiz, {existing['full_name']}!",
                "reply_markup": {"inline_keyboard": [[{"text": "♟ 3D SHAXMAT", "web_app": {"url": APP_URL}}]]},
            })
        else:
            await telegram("sendMessage", {
                "chat_id": chat_id,
                "text": "ZAMIN 3D CHESS'ga xush kelibsiz! Davom etish uchun ismingiz Telegram profilingizdan olinadi va telefon raqamingizni tasdiqlashingiz kerak.",
                "reply_markup": {"keyboard": [[{"text": "📱 Raqamimni tasdiqlash", "request_contact": True}]], "resize_keyboard": True, "one_time_keyboard": True},
            })
    return JSONResponse({"ok": True})


@app.exception_handler(HTTPException)
async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)
