"""
Video Saver server.

Takes a public video URL (Facebook, TikTok, Instagram, X, YouTube, ...),
uses yt-dlp to resolve it, and sends the video file back to the app.

Endpoints:
  GET  /health
  POST /info      {"url": "..."}  -> title, thumbnail, duration, uploader
  GET  /download?url=...&audio_only=false -> the media file
"""

import ipaddress
import os
import re
import shutil
import socket
import tempfile
import time
from collections import defaultdict, deque
from urllib.parse import urlparse

import yt_dlp
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

API_KEY = os.environ.get("API_KEY", "")  # empty = no auth (local testing only)
MAX_DURATION_SEC = int(os.environ.get("MAX_DURATION_SEC", 60 * 60))  # 1 hour
MAX_FILESIZE_MB = int(os.environ.get("MAX_FILESIZE_MB", 500))
RATE_LIMIT_PER_MIN = int(os.environ.get("RATE_LIMIT_PER_MIN", 20))

app = FastAPI(title="Video Saver")

_hits: dict[str, deque] = defaultdict(deque)


class UrlBody(BaseModel):
    url: str
    audio_only: bool = False


def check_auth(x_api_key: str | None = Header(default=None)):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


def check_rate(request: Request):
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    q = _hits[ip]
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= RATE_LIMIT_PER_MIN:
        raise HTTPException(status_code=429, detail="Too many requests, try again in a minute")
    q.append(now)


def extract_url(text: str) -> str:
    """Shared text often looks like 'Watch this! https://...' - pull the link out."""
    m = re.search(r"https?://[^\s]+", text.strip())
    if not m:
        raise HTTPException(status_code=400, detail="No link found")
    return m.group(0).rstrip(").,;")


def validate_public_url(url: str) -> None:
    """Block non-http schemes and private/internal addresses (SSRF protection)."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=400, detail="Only http/https links are allowed")
    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except socket.gaierror:
        raise HTTPException(status_code=400, detail="Could not resolve the link host")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
        ):
            raise HTTPException(status_code=400, detail="This address is not allowed")


def base_opts() -> dict:
    return {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "socket_timeout": 20,
        "retries": 3,
        # only network downloads, never local files
        "allowed_extractors": ["default", "-generic"] if os.environ.get("BLOCK_GENERIC") else ["default"],
    }


@app.get("/health")
def health():
    return {"ok": True, "yt_dlp": yt_dlp.version.__version__}


@app.post("/info", dependencies=[Depends(check_auth), Depends(check_rate)])
def info(body: UrlBody):
    url = extract_url(body.url)
    validate_public_url(url)
    try:
        with yt_dlp.YoutubeDL(base_opts()) as ydl:
            data = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as e:
        raise HTTPException(status_code=422, detail=_clean_error(e))
    return {
        "url": url,
        "title": data.get("title"),
        "thumbnail": data.get("thumbnail"),
        "duration": data.get("duration"),
        "uploader": data.get("uploader"),
        "extractor": data.get("extractor_key"),
    }


@app.get("/download", dependencies=[Depends(check_auth), Depends(check_rate)])
def download(url: str, audio_only: bool = False):
    """GET so the mobile app can use a plain file download (headers carry the API key)."""
    url = extract_url(url)
    validate_public_url(url)
    body = UrlBody(url=url, audio_only=audio_only)

    tmpdir = tempfile.mkdtemp(prefix="vs_")
    opts = base_opts() | {
        "outtmpl": os.path.join(tmpdir, "%(id)s.%(ext)s"),
        "max_filesize": MAX_FILESIZE_MB * 1024 * 1024,
        "match_filter": yt_dlp.utils.match_filter_func(f"duration <=? {MAX_DURATION_SEC}"),
    }
    if body.audio_only:
        opts["format"] = "bestaudio[ext=m4a]/bestaudio/best"
    else:
        # prefer a single mp4 file that plays everywhere; fall back to merge
        opts["format"] = "best[ext=mp4]/bv*[ext=mp4]+ba[ext=m4a]/best"
        opts["merge_output_format"] = "mp4"

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as e:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise HTTPException(status_code=422, detail=_clean_error(e))

    files = [f for f in os.listdir(tmpdir) if not f.endswith((".part", ".ytdl"))]
    if not files:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise HTTPException(status_code=422, detail="Video is too long/large or unavailable")

    path = os.path.join(tmpdir, files[0])
    media_type = "audio/mp4" if body.audio_only else "video/mp4"
    return FileResponse(
        path,
        media_type=media_type,
        filename=files[0],
        background=BackgroundTask(shutil.rmtree, tmpdir, True),
    )


def _clean_error(e: Exception) -> str:
    msg = re.sub(r"\x1b\[[0-9;]*m", "", str(e))  # strip ANSI colors
    msg = msg.replace("ERROR: ", "")
    return msg[:300]
