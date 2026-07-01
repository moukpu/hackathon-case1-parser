# Google Drive → Telegram Uploader

Веб-панель для выбора файлов из Google Drive и отправки в Telegram-канал через Telegram user account / Telethon.

## Что внутри

- `cloudflare-worker/` — веб-панель + API: список файлов, запуск RunPod job, статус job.
- `runpod-worker/` — RunPod Serverless worker: скачивает файлы с Google Drive и отправляет их в Telegram.
- `tools/` — локальные скрипты для получения `TELEGRAM_SESSION_STRING`, `GOOGLE_REFRESH_TOKEN` и ID приватного Telegram-канала.

## Почему не service account

В твоём Google Cloud включена политика `iam.disableServiceAccountKeyCreation`, поэтому JSON-key для service account создать нельзя. Этот проект использует обычный Google OAuth refresh token.

## Важно по безопасности

Не коммить секреты в GitHub. Все реальные ключи добавляются только в Cloudflare secrets / RunPod secrets.

То, что случайно было отправлено в чат, лучше перевыпустить/заменить:

- RunPod API key;
- Telegram API hash / Telegram app credentials;
- invite link приватного Telegram-канала, если канал должен оставаться закрытым.

## Быстрый план запуска

1. Создать Google OAuth Client типа Desktop app.
2. Запустить `tools/make_google_refresh_token.py` и получить `GOOGLE_REFRESH_TOKEN`.
3. Запустить `tools/make_telegram_session.py` и получить `TELEGRAM_SESSION_STRING`.
4. Задеплоить `runpod-worker` как RunPod Serverless endpoint.
5. Добавить secrets в RunPod endpoint.
6. Задеплоить `cloudflare-worker`.
7. Добавить secrets в Cloudflare Worker.
8. Открыть Worker URL, ввести пароль, выбрать файлы и отправить.

## Нужные секреты

### RunPod Serverless env/secrets

```env
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_SESSION_STRING=
TELEGRAM_CHANNEL=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
MAX_FILE_BYTES=4294967296
TMP_DIR=/tmp/gdrive-tg
```

### Cloudflare Worker secrets

```env
ADMIN_PASSWORD=
RUNPOD_API_KEY=
RUNPOD_ENDPOINT_ID=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
GOOGLE_DRIVE_FOLDER_ID=
```

## Telegram private channel

Для приватного канала лучше использовать числовой ID вида `-100...`. Чтобы получить raw id:

```bash
python tools/list_telegram_chats.py
```

Если Telegram требует полный channel id, добавь `-100` перед raw id.
Аккаунт, через который создана `TELEGRAM_SESSION_STRING`, должен быть участником/админом канала.

## Google Drive folder

Можно использовать твой folder id:

```txt
1KtKXjwU_ODuuOrLs5ZpVUU4c3qBwK6YZ
```

Сайт будет показывать файлы только из этой папки.
