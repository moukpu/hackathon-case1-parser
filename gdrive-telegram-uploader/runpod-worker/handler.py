import asyncio
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List

import runpod
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from telethon import TelegramClient
from telethon.sessions import StringSession

DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly"


def env(name: str, default: str | None = None, required: bool = True) -> str:
    value = os.getenv(name, default)
    if required and not value:
        raise RuntimeError(f"Missing env var: {name}")
    return value or ""


def drive_service():
    creds = Credentials(
        token=None,
        refresh_token=env("GOOGLE_REFRESH_TOKEN"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=env("GOOGLE_CLIENT_ID"),
        client_secret=env("GOOGLE_CLIENT_SECRET"),
        scopes=[DRIVE_SCOPE],
    )
    creds.refresh(Request())
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def safe_name(name: str) -> str:
    name = name.strip().replace("/", "_").replace("\\", "_")
    return re.sub(r"[^\w .()\[\]{}@,+\-=!#%&;~А-Яа-яЁё]", "_", name)[:180] or "file"


def get_file_meta(service, file_id: str) -> Dict[str, Any]:
    return service.files().get(
        fileId=file_id,
        fields="id,name,size,mimeType,modifiedTime,webViewLink",
        supportsAllDrives=True,
    ).execute()


def download_file(service, meta: Dict[str, Any], tmp_dir: str) -> str:
    file_id = meta["id"]
    name = safe_name(meta.get("name") or file_id)
    mime_type = meta.get("mimeType", "")

    if mime_type.startswith("application/vnd.google-apps"):
        if not name.lower().endswith(".pdf"):
            name += ".pdf"
        request = service.files().export_media(fileId=file_id, mimeType="application/pdf")
    else:
        request = service.files().get_media(fileId=file_id, supportsAllDrives=True)

    Path(tmp_dir).mkdir(parents=True, exist_ok=True)
    local_path = str(Path(tmp_dir) / name)
    print(f"Downloading {name}", flush=True)

    with open(local_path, "wb") as fh:
        downloader = MediaIoBaseDownload(fh, request, chunksize=8 * 1024 * 1024)
        done = False
        while not done:
            status, done = downloader.next_chunk(num_retries=5)
            if status:
                print(f"Download {name}: {int(status.progress() * 100)}%", flush=True)
    return local_path


async def send_to_telegram(message: str, local_files: List[str]) -> List[Dict[str, Any]]:
    client = TelegramClient(
        StringSession(env("TELEGRAM_SESSION_STRING")),
        int(env("TELEGRAM_API_ID")),
        env("TELEGRAM_API_HASH"),
    )
    channel = env("TELEGRAM_CHANNEL")
    out: List[Dict[str, Any]] = []
    async with client:
        target = await client.get_entity(channel)
        if message.strip():
            msg = await client.send_message(target, message.strip())
            out.append({"type": "message", "id": msg.id, "ok": True})
        for path in local_files:
            sent = await client.send_file(target, path, force_document=True, part_size_kb=512)
            out.append({"type": "file", "name": Path(path).name, "id": sent.id, "ok": True})
    return out


def handler(event: Dict[str, Any]) -> Dict[str, Any]:
    started = time.time()
    inp = event.get("input") or {}
    message = str(inp.get("message") or "")
    files = inp.get("files") or []
    if not isinstance(files, list) or not files:
        return {"ok": False, "error": "No files selected"}

    max_file_bytes = int(env("MAX_FILE_BYTES", str(4 * 1024 * 1024 * 1024), required=False))
    tmp_dir = env("TMP_DIR", "/tmp/gdrive-tg", required=False)
    service = drive_service()
    downloaded: List[str] = []
    results: List[Dict[str, Any]] = []

    try:
        for item in files:
            file_id = item.get("id") if isinstance(item, dict) else str(item)
            meta = get_file_meta(service, file_id)
            size = int(meta.get("size") or 0)
            if size and size > max_file_bytes:
                results.append({"ok": False, "id": file_id, "name": meta.get("name"), "error": "too large"})
                continue
            local_path = download_file(service, meta, tmp_dir)
            downloaded.append(local_path)
            results.append({"ok": True, "id": file_id, "name": meta.get("name"), "stage": "downloaded"})

        if not downloaded:
            return {"ok": False, "results": results, "error": "No files downloaded"}

        tg_results = asyncio.run(send_to_telegram(message, downloaded))
        return {"ok": True, "seconds": round(time.time() - started, 2), "download_results": results, "telegram_results": tg_results}
    except Exception as exc:
        return {"ok": False, "error": repr(exc), "results": results}
    finally:
        for path in downloaded:
            try:
                os.remove(path)
            except Exception:
                pass


runpod.serverless.start({"handler": handler})
