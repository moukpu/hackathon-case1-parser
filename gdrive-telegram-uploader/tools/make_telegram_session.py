import asyncio
import os

from telethon import TelegramClient
from telethon.sessions import StringSession


async def main():
    api_id = int(os.getenv("TELEGRAM_API_ID") or input("TELEGRAM_API_ID: ").strip())
    api_hash = os.getenv("TELEGRAM_API_HASH") or input("TELEGRAM_API_HASH: ").strip()
    phone = os.getenv("TELEGRAM_PHONE") or input("Phone, example +77001234567: ").strip()

    async with TelegramClient(StringSession(), api_id, api_hash) as client:
        await client.start(phone=phone)
        print("\nSAVE THIS AS TELEGRAM_SESSION_STRING:\n")
        print(client.session.save())
        print("\nDo not send this value in chat and do not commit it to GitHub.\n")


if __name__ == "__main__":
    asyncio.run(main())
