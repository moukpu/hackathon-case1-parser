# Setup: host-only режим

Тут нет шага “запусти на своём компе”. Всё делается через браузер: GitHub, RunPod, Cloudflare, Google Cloud.

## 0. Сразу по безопасности

Если ключи были отправлены в чат, считай их скомпрометированными. Перевыпусти RunPod API key. Для Telegram лучше создать новое приложение на my.telegram.org или заменить текущие credentials, если получится.

## 1. Что уже готово в репе

- `runpod-worker/` — контейнер для RunPod Serverless. Он качает файлы с Google Drive и отправляет их в Telegram.
- `cloudflare-worker/` — веб-панель: сообщение, список файлов, галочки, кнопка отправки.
- `tools/` — запасные helper-скрипты. Они не обязательны, если делаешь всё через хост.

## 2. Google без service account key

Ошибка `iam.disableServiceAccountKeyCreation` значит, что JSON-key для service account заблокирован политикой организации. Поэтому используем OAuth Client.

Хостовой вариант без локального запуска:

1. Google Cloud Console → APIs & Services → Library → включить Google Drive API.
2. APIs & Services → OAuth consent screen → настроить External/Test.
3. Добавить себя в Test users.
4. APIs & Services → Credentials → Create credentials → OAuth client ID.
5. Application type: **Web application**.
6. Redirect URI укажешь после деплоя Cloudflare Worker:

```txt
https://YOUR-WORKER.workers.dev/api/google/callback
```

7. Скопировать `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET`.

## 3. RunPod Serverless

1. Открыть RunPod → Serverless → New Endpoint.
2. Source: Docker image/GitHub repo build из папки `gdrive-telegram-uploader/runpod-worker`.
3. Container start command оставь по Dockerfile.
4. Timeout поставь больше, например 3600–7200 секунд.
5. Container disk должен вмещать самый большой файл, например 10–20 GB.
6. Для первого деплоя в env можно добавить только:

```env
MAX_FILE_BYTES=4294967296
TMP_DIR=/tmp/gdrive-tg
```

Остальные секреты можно хранить на стороне Cloudflare Worker и отправлять в RunPod job при запуске.

7. Скопировать `RUNPOD_ENDPOINT_ID`.
8. Создать новый `RUNPOD_API_KEY`. Старый, который был отправлен в чат, лучше удалить.

## 4. Cloudflare Worker без локального wrangler

Через браузер:

1. Cloudflare Dashboard → Workers & Pages → Create Worker.
2. Вставить код из `gdrive-telegram-uploader/cloudflare-worker/src/index.js`.
3. Settings → Variables → добавить secret:

```env
ADMIN_PASSWORD=твой_пароль_для_панели
RUNPOD_API_KEY=новый_ключ_RunPod
RUNPOD_ENDPOINT_ID=endpoint_id_RunPod
GOOGLE_CLIENT_ID=client_id
GOOGLE_CLIENT_SECRET=client_secret
GOOGLE_DRIVE_FOLDER_ID=1KtKXjwU_ODuuOrLs5ZpVUU4c3qBwK6YZ
```

4. Deploy.
5. После деплоя скопировать URL Worker.
6. Вернуться в Google OAuth Client и добавить Redirect URI:

```txt
https://YOUR-WORKER.workers.dev/api/google/callback
```

## 5. Telegram session без локального запуска

Есть два хостовых варианта:

### Вариант A: через RunPod Web Terminal

Это не твой компьютер, это хост.

1. Открыть временный RunPod Pod или Web Terminal контейнера.
2. В нём запустить helper из репы.
3. Получить `TELEGRAM_SESSION_STRING`.
4. Вставить его в Cloudflare Worker Secret:

```env
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_SESSION_STRING=
TELEGRAM_CHANNEL=
```

### Вариант B: позже добавить hosted setup page

Можно сделать страницу, где ты вводишь номер, код Telegram и 2FA-пароль, а она получает session через RunPod. Это удобнее, но рискованнее по безопасности, поэтому MVP оставлен через Worker secrets / RunPod terminal.

## 6. Проверка

1. Открыть URL Cloudflare Worker.
2. Ввести ADMIN_PASSWORD.
3. Нажать “Загрузить список”.
4. Выбрать 1 маленький файл для теста.
5. Нажать “Отправить выбранные”.
6. После маленького файла тестить большой.
