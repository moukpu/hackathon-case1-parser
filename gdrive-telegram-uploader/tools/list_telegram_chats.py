import asyncio
import os

from telethon import TelegramClient
from telethon.sessions import StringSession


async def main():
    api_id = int(os.getenv("TELEGRAM_API_ID") or input("TELEGRAM_API_ID: ").strip())
    api_hash = os.getenv("TELEGRAM_API_HASH") or input("TELEGRAM_API_HASH: ").strip()
    session = os.getenv("TELEGRAM_SESSION_STRING") or input("TELEGRAM_SESSION_STRING: ").strip()

    async with TelegramClient(StringSession(session), api_id, api_hash) as client:
        async for dialog in client.iter_dialogs():
            raw_id = getattr(dialog.entity, "id", "")
            print(f"{dialog.name} | raw id: {raw_id}")

    print("\nFor private channels, use the channel id in TELEGRAM_CHANNEL. If Telegram needs the full channel form, add the -100 prefix before the raw id.\n")


if __name__ == "__main__":
    asyncio.run(main())
