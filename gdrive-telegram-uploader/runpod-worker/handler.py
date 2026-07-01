import asyncio
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import runpod
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError
from telethon.sessions import StringSession

DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly"


def pick(auth: Dict[str, Any], name: str, default: Optional[str] = None, required: bool = True) -> str:
    value = auth.get(name)
    if value is None or value == "":
        value = os.getenv(name, default)
    if required and not value:
        raise RuntimeError(f"Missing setting: {name}")
    return str(value or "")


def drive_service(auth: Dict[str, Any]):
    creds = Credentials(
        token=None,
        refresh_token=pick(auth, "GOOGLE_REFRESH_TOKEN"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=pick(auth, "GOOGLE_CLIENT_ID"),
        client_secret=pick(auth, "GOOGLE_CLIENT_SECRET"),
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


async def telegram_send_code(auth: Dict[str, Any], phone: str) -> Dict[str, Any]:
    async with TelegramClient(
        StringSession(),
        int(pick(auth, "TELEGRAM_API_ID")),
        pick(auth, "TELEGRAM_API_HASH"),
    ) as client:
        sent = await client.send_code_request(phone)
        return {"ok": True, "phone_code_hash": sent.phone_code_hash}


async def telegram_verify_code(auth: Dict[str, Any], phone: str, code: str, phone_code_hash: str, password: str = "") -> Dict[str, Any]:
    async with TelegramClient(
        StringSession(),
        int(pick(auth, "TELEGRAM_API_ID")),
        pick(auth, "TELEGRAM_API_HASH"),
    ) as client:
        try:
            await client.sign_in(phone=phone, code=code, phone_code_hash=phone_code_hash)
        except SessionPasswordNeededError:
            if not password:
                return {"ok": False, "needs_password": True, "error": "2FA password required"}
            await client.sign_in(password=password)
        me = await client.get_me()
        return {"ok": True, "session": client.session.save(), "user": getattr(me, "username", None) or getattr(me, "first_name", "Telegram")}


async def telegram_list_chats(auth: Dict[str, Any]) -> Dict[str, Any]:
    async with TelegramClient(
        StringSession(pick(auth, "TELEGRAM_SESSION_STRING")),
        int(pick(auth, "TELEGRAM_API_ID")),
        pick(auth, "TELEGRAM_API_HASH"),
    ) as client:
        chats = []
        async for dialog in client.iter_dialogs():
            raw_id = getattr(dialog.entity, "id", None)
            chats.append({"name": dialog.name, "raw_id": raw_id, "channel_id_hint": f"-100{raw_id}" if raw_id else ""})
        return {"ok": True, "chats": chats[:200]}


async def send_to_telegram(auth: Dict[str, Any], message: str, local_files: List[str]) -> List[Dict[str, Any]]:
    client = TelegramClient(
        StringSession(pick(auth, "TELEGRAM_SESSION_STRING")),
        int(pick(auth, "TELEGRAM_API_ID")),
        pick(auth, "TELEGRAM_API_HASH"),
    )
    channel = pick(auth, "TELEGRAM_CHANNEL")
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


def upload_files(inp: Dict[str, Any]) -> Dict[str, Any]:
    started = time.time()
    auth = inp.get("auth") or {}
    message = str(inp.get("message") or "")
    files = inp.get("files") or []
    if not isinstance(files, list) or not files:
        return {"ok": False, "error": "No files selected"}

    max_file_bytes = int(pick(auth, "MAX_FILE_BYTES", str(4 * 1024 * 1024 * 1024), required=False))
    tmp_dir = pick(auth, "TMP_DIR", "/tmp/gdrive-tg", required=False)
    service = drive_service(auth)
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

        tg_results = asyncio.run(send_to_telegram(auth, message, downloaded))
        return {"ok": True, "seconds": round(time.time() - started, 2), "download_results": results, "telegram_results": tg_results}
    except Exception as exc:
        return {"ok": False, "error": repr(exc), "results": results}
    finally:
        for path in downloaded:
            try:
                os.remove(path)
            except Exception:
                pass


def handler(event: Dict[str, Any]) -> Dict[str, Any]:
    inp = event.get("input") or {}
    op = inp.get("op") or "upload"
    auth = inp.get("auth") or {}
    try:
        if op == "telegram_send_code":
            return asyncio.run(telegram_send_code(auth, str(inp.get("phone") or "")))
        if op == "telegram_verify_code":
            return asyncio.run(
                telegram_verify_code(
                    auth,
                    str(inp.get("phone") or ""),
                    str(inp.get("code") or ""),
                    str(inp.get("phone_code_hash") or ""),
                    str(inp.get("password") or ""),
                )
            )
        if op == "telegram_list_chats":
            return asyncio.run(telegram_list_chats(auth))
        return upload_files(inp)
    except Exception as exc:
        return {"ok": False, "error": repr(exc), "op": op}


runpod.serverless.start({"handler": handler})
