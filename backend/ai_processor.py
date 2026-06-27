import json
import time
from typing import Any

from groq import Groq

from local_parser import parse_price_list_locally


LOCAL_FIRST_MIN_ITEMS = 3
GROQ_RETRY_SECONDS = 6


def _extract_json_array(text: str) -> list[dict[str, Any]]:
    start_idx = text.find("[")
    end_idx = text.rfind("]")
    if start_idx == -1 or end_idx == -1 or end_idx <= start_idx:
        return []
    data = json.loads(text[start_idx : end_idx + 1])
    return data if isinstance(data, list) else []


def _looks_like_rate_limit_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return "429" in text or "rate limit" in text or "rate_limit" in text or "too many requests" in text


def parse_price_list_with_ai(raw_text: str, api_key: str):
    """Parse price list with local-first strategy.

    Big ZIP archives can contain dozens/hundreds of files. Sending every file to
    Groq immediately causes 429. So we first use deterministic table/regex
    parsing. Groq is only a fallback for hard documents.
    """
    local_items = parse_price_list_locally(raw_text)
    if len(local_items) >= LOCAL_FIRST_MIN_ITEMS:
        return local_items

    if not api_key:
        return local_items

    client = Groq(api_key=api_key)
    text_chunk = raw_text[:14000]

    system_prompt = """Ты эксперт по медицинским прайс-листам Казахстана.
Извлеки строки услуг из сырого текста прайса клиники.
Ответь ТОЛЬКО JSON-массивом объектов. Без markdown и пояснений.

Нужно извлечь каждую реальную услугу, пропуская заголовки разделов, мусор 1С, пустые строки и юридический текст.

Поля каждого объекта:
- original_name: исходное название услуги как в документе
- standardized_name: аккуратное нормализованное название, но НЕ выдумывай услугу
- service_code: код услуги из источника или null
- price: основная цена числом, если одна цена
- price_resident_kzt: цена для резидента KZT, если явно есть
- price_nonresident_kzt: цена для нерезидента KZT, если явно есть
- currency: KZT/USD/RUB, по умолчанию KZT
- category: категория услуги: лаборатория, диагностика, консультация, процедура, стоматология, операция, прочее
- confidence: уверенность извлечения 0..100

Правила:
1. Первичная и повторная консультация — разные услуги.
2. Если есть две цены резидент/нерезидент — заполни обе.
3. Цена должна быть числом без пробелов и валюты.
4. Если цена не распознана, ставь null и confidence ниже 80.
5. Сокращения раскрывай только очевидные: ОАК, ОАМ, ЭКГ, УЗИ, МРТ, КТ, ФГДС.
"""

    try:
        response = client.chat.completions.create(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Сырой текст прайс-листа:\n\n{text_chunk}"},
            ],
            model="llama-3.3-70b-versatile",
            temperature=0.0,
        )
    except Exception as exc:
        if _looks_like_rate_limit_error(exc):
            # One short retry for occasional bursts. Do not loop forever on Railway.
            time.sleep(GROQ_RETRY_SECONDS)
            try:
                response = client.chat.completions.create(
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": f"Сырой текст прайс-листа:\n\n{text_chunk}"},
                    ],
                    model="llama-3.3-70b-versatile",
                    temperature=0.0,
                )
            except Exception as retry_exc:
                if local_items:
                    return local_items
                raise ValueError("Groq 429 rate limit: лимит AI исчерпан. Локальный парсер не нашёл строки услуг.") from retry_exc
        else:
            if local_items:
                return local_items
            raise

    result_text = response.choices[0].message.content or ""
    try:
        ai_items = _extract_json_array(result_text)
        return ai_items or local_items
    except Exception as e:
        print(f"Ошибка парсинга JSON: {e}")
        print("Сырой ответ:", result_text)
        return local_items
