import re
from typing import Any


PRICE_RE = re.compile(r"(?<!\d)(\d{3,}(?:[\s\u00a0]\d{3})*(?:[,.]\d{1,2})?)(?!\d)")
CODE_PREFIX_RE = re.compile(r"^\s*[A-ZА-Я]{1,6}\s*\d+(?:[.,]\d+)*(?:\s*[A-ZА-Я])?[.)\-\s,;:]+", re.I)
TRAILING_COUNT_RE = re.compile(r"\s+\d{1,3}\s*$")
MONTHS_RE = re.compile(r"\b(январ[ья]|феврал[ья]|март[а]?|апрел[ья]|ма[йя]|июн[ья]|июл[ья]|август[а]?|сентябр[ья]|октябр[ья]|ноябр[ья]|декабр[ья])\b", re.I)
DATE_RE = re.compile(r"\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b")

SKIP_WORDS = {
    "цена", "стоимость", "прайс", "наименование", "услуга", "код", "итого",
    "скидка", "примечание", "адрес", "телефон", "бин", "страница", "лист",
    "приложение", "договор", "график", "таблица", "утвержден", "утверждено",
    "от", "с", "по", "дата", "год", "января", "февраля", "марта", "апреля",
}

SERVICE_KEYWORDS = [
    "прием", "приём", "консульта", "осмотр", "узи", "мрт", "кт", "рентген", "экг", "эхо",
    "анализ", "кров", "моч", "мазок", "тест", "проб", "иммун", "терап", "диагност",
    "спирометр", "спирограф", "монитор", "холтер", "фгдс", "колоно", "пункц", "биопс",
    "инъек", "капель", "перевяз", "удал", "лечение", "анестез", "массаж", "забор",
]


def parse_price_number(value: str) -> float | None:
    if not value:
        return None
    text = str(value).replace("\u00a0", " ").strip()
    matches = PRICE_RE.findall(text)
    if not matches:
        return None
    raw = matches[-1].replace(" ", "").replace("\u00a0", "").replace(",", ".")
    try:
        price = float(raw)
    except ValueError:
        return None
    if price < 100 or price > 20_000_000:
        return None
    return price


def has_service_signal(text: str) -> bool:
    n = (text or "").lower()
    return any(k in n for k in SERVICE_KEYWORDS)


def is_probably_header_or_noise(text: str) -> bool:
    normalized = re.sub(r"\s+", " ", (text or "").lower()).strip()
    if len(normalized) < 4:
        return True
    if normalized in SKIP_WORDS:
        return True
    if "приложение" in normalized or "утвержден" in normalized:
        return True
    if MONTHS_RE.search(normalized) and not has_service_signal(normalized):
        return True
    if DATE_RE.search(normalized) and not has_service_signal(normalized):
        return True
    if sum(1 for w in SKIP_WORDS if w in normalized) >= 2 and not has_service_signal(normalized):
        return True
    if re.fullmatch(r"[\d\W_]+", normalized):
        return True
    return False


def clean_service_name(value: str) -> str:
    text = str(value or "")
    text = re.sub(r"\s+", " ", text.replace("\u00a0", " ")).strip(" .,:;|-–—")
    text = CODE_PREFIX_RE.sub("", text).strip()
    text = re.sub(r"^\d+[.)\-\s]+", "", text).strip()
    # Many source files have a trailing internal catalog/category number after the service name.
    text = TRAILING_COUNT_RE.sub("", text).strip(" .,:;|-–—")
    return text


def row_to_item(cells: list[str]) -> dict[str, Any] | None:
    cells = [str(c or "").strip() for c in cells if str(c or "").strip()]
    if len(cells) < 2:
        return None

    price_idx = None
    price_value = None
    for idx in range(len(cells) - 1, -1, -1):
        price = parse_price_number(cells[idx])
        if price is not None:
            price_idx = idx
            price_value = price
            break
    if price_idx is None:
        return None

    name_candidates = []
    for cell in cells[:price_idx]:
        clean = clean_service_name(cell)
        if len(clean) >= 4 and not is_probably_header_or_noise(clean):
            score = len(clean) + (30 if has_service_signal(clean) else 0)
            name_candidates.append((score, clean))

    if not name_candidates:
        return None

    service_name = sorted(name_candidates, reverse=True)[0][1]
    if is_probably_header_or_noise(service_name):
        return None

    return {
        "original_name": service_name,
        "standardized_name": service_name,
        "service_code": None,
        "price": price_value,
        "price_resident_kzt": price_value,
        "price_nonresident_kzt": None,
        "currency": "KZT",
        "category": None,
        "confidence": 88 if has_service_signal(service_name) else 72,
    }


def line_to_item(line: str) -> dict[str, Any] | None:
    line = re.sub(r"\s+", " ", str(line or "").replace("\u00a0", " ")).strip()
    if len(line) < 8 or is_probably_header_or_noise(line):
        return None

    price = parse_price_number(line)
    if price is None:
        return None

    matches = list(PRICE_RE.finditer(line))
    if not matches:
        return None
    m = matches[-1]
    name = clean_service_name(line[:m.start()])
    name = re.sub(r"(?:цена|стоимость)\s*$", "", name, flags=re.I).strip(" .,:;|-–—")
    if is_probably_header_or_noise(name) or len(name) < 4:
        return None

    return {
        "original_name": name,
        "standardized_name": name,
        "service_code": None,
        "price": price,
        "price_resident_kzt": price,
        "price_nonresident_kzt": None,
        "currency": "KZT",
        "category": None,
        "confidence": 84 if has_service_signal(name) else 70,
    }


def parse_price_list_locally(raw_text: str, max_items: int = 5000) -> list[dict[str, Any]]:
    """Fast deterministic parser for tables/text.

    Max is high on purpose: hackathon ZIPs can contain huge price files. UI can
    paginate/display a subset, but extraction should not silently cut at 500.
    """
    items: list[dict[str, Any]] = []
    seen: set[tuple[str, float]] = set()

    for raw_line in (raw_text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue

        item = None
        if "\t" in line:
            item = row_to_item(line.split("\t"))
        if item is None:
            item = line_to_item(line)

        if not item:
            continue
        key = (item["original_name"].lower(), float(item["price"] or 0))
        if key in seen:
            continue
        seen.add(key)
        items.append(item)
        if len(items) >= max_items:
            break

    return items
