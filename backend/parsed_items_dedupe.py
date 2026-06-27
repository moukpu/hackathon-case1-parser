import re
from decimal import Decimal, InvalidOperation
from typing import Any

from backend import main

ORIGINAL_PARSE_PRICE_LIST_WITH_AI = main.parse_price_list_with_ai

NAME_FIELDS = ("original_name", "service_name_raw", "standardized_name")
PRICE_FIELDS = ("price_resident_kzt", "price_nonresident_kzt", "price")


def normalize_text(value: Any) -> str:
    text = str(value or "").strip().lower().replace("ё", "е")
    text = re.sub(r"\s+", " ", text)
    return text


def normalize_price(value: Any) -> str:
    if value is None or value == "":
        return ""

    text = str(value).replace("\xa0", " ").replace(" ", "").replace(",", ".")
    try:
        return str(Decimal(text).quantize(Decimal("0.01")))
    except (InvalidOperation, ValueError):
        return normalize_text(value)


def primary_name(item: dict) -> str:
    for field in NAME_FIELDS:
        value = normalize_text(item.get(field))
        if value:
            return value
    return ""


def dedupe_key(item: dict) -> tuple[str, str, str, str, str]:
    return (
        normalize_text(item.get("service_code") or item.get("code")),
        primary_name(item),
        normalize_price(item.get("price_resident_kzt")),
        normalize_price(item.get("price_nonresident_kzt")),
        normalize_price(item.get("price")),
    )


def dedupe_parsed_items(items: list[dict]) -> list[dict]:
    seen: set[tuple[str, str, str, str, str]] = set()
    result: list[dict] = []

    for item in items:
        if not isinstance(item, dict):
            result.append(item)
            continue

        key = dedupe_key(item)
        has_name = bool(key[1])
        has_price = any(key[index] for index in (2, 3, 4))

        if has_name and has_price:
            if key in seen:
                continue
            seen.add(key)

        result.append(item)

    return result


def parse_price_list_with_dedupe(raw_text: str, groq_api_key: str) -> list[dict]:
    parsed = ORIGINAL_PARSE_PRICE_LIST_WITH_AI(raw_text, groq_api_key) or []
    return dedupe_parsed_items(parsed)


main.parse_price_list_with_ai = parse_price_list_with_dedupe
