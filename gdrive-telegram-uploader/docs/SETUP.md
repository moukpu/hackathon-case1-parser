# Setup

## 0. Сразу по безопасности

Если ключи были отправлены в чат, считай их скомпрометированными. Перевыпусти RunPod API key. Для Telegram лучше создать новое приложение на my.telegram.org или заменить текущие credentials, если получится.

## 1. Google без service account key

Ошибка `iam.disableServiceAccountKeyCreation` значит, что JSON-key для service account заблокирован политикой организации. Поэтому используем OAuth Client.

1. Google Cloud Console → APIs & Services → Library → включить Google Drive API.
2. APIs & Services → OAuth consent screen → настроить External/Test.
3. Добавить себя в Test users.
4. APIs & Services → Credentials → Create credentials → OAuth client ID.
5. Application type: Desktop app.
6. Скопировать `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET`.
7. Локально:

```bash
cd gdrive-telegram-uploader/tools
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python make_google_refresh_token.py
```

Сохрани выданный `GOOGLE_REFRESH_TOKEN`.

## 2. Telegram session

```bash
cd gdrive-telegram-uploader/tools
source .venv/bin/activate
python make_telegram_session.py
```

Сохрани `TELEGRAM_SESSION_STRING`.

Для приватного канала надежнее использовать `TELEGRAM_CHANNEL=-100...`. Аккаунт, который создаёт session, должен быть админом канала. Если используешь invite link, он может сработать только для первого join; потом лучше заменить на числовой ID.

## 3. RunPod Serverless

1. Открыть RunPod → Serverless → New Endpoint.
2. Source: Docker image из этого проекта после сборки, либо GitHub repo build, если подключишь репу.
3. Container start command оставь по Dockerfile.
4. Timeout поставь больше, например 3600–7200 секунд.
5. Container disk должен вмещать самый большой файл, например 10–20 GB.
6. Добавить env/secrets:

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

7. Скопировать Endpoint ID.

## 4. Cloudflare Worker

```bash
cd gdrive-telegram-uploader/cloudflare-worker
npm install
npx wrangler login
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put RUNPOD_API_KEY
npx wrangler secret put RUNPOD_ENDPOINT_ID
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put GOOGLE_DRIVE_FOLDER_ID
npm run deploy
```

`GOOGLE_DRIVE_FOLDER_ID` для твоей папки:

```txt
1KtKXjwU_ODuuOrLs5ZpVUU4c3qBwK6YZ
```

## 5. Проверка

1. Открыть URL Cloudflare Worker.
2. Ввести ADMIN_PASSWORD.
3. Нажать “Загрузить список”.
4. Выбрать 1 маленький файл для теста.
5. Нажать “Отправить выбранные”.
6. После маленького файла тестить большой.
