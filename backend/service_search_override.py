import re

from fastapi import Depends
from rapidfuzz import fuzz
from sqlalchemy.orm import Session

from auth import AuthUser, require_user
from backend import main
from db import Service, get_db

ALIASES = {
    "экг": ["электрокардиография", "электрокардиограмма", "ecg", "ekg"],
    "ecg": ["экг", "электрокардиография", "электрокардиограмма"],
    "ekg": ["экг", "электрокардиография", "электрокардиограмма"],
    "узи": ["ультразвуковое исследование", "ультразвуковая диагностика", "ультразвук"],
    "мрт": ["магнитно резонансная томография", "магнитно резонансный"],
    "кт": ["компьютерная томография"],
    "оак": ["общий анализ крови"],
    "оам": ["общий анализ мочи"],
    "фгдс": ["эзофагогастродуоденоскопия", "эгдс", "гастроскопия"],
    "эгдс": ["эзофагогастродуоденоскопия", "фгдс", "гастроскопия"],
}

TRASH_WORDS = {
    "без", "лс", "ими", "имн", "процедура", "исследование", "услуга", "час", "часа",
    "1", "2", "3", "4", "5", "один", "одна", "одно", "и", "или", "для", "на", "по",
}


def norm(value) -> str:
    text = str(value or "").casefold().replace("ё", "е")
    text = re.sub(r"[^a-zа-я0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def tokens(query: str) -> list[str]:
    return [t for t in norm(query).split() if t and t not in TRASH_WORDS]


def variants(service: Service) -> list[str]:
    values = [service.service_name, service.category, service.source_code, service.tarificatr_code, " ".join(service.synonyms)]
    return [norm(v) for v in values if norm(v)]


def alias_score(alias_key: str, service: Service) -> int:
    targets = [alias_key, *ALIASES.get(alias_key, [])]
    targets = [norm(t) for t in targets]
    best = 0
    for target in targets:
        for value in variants(service):
            if target == value:
                best = max(best, 130)
            elif target in value:
                best = max(best, 120)
            elif alias_key in value.split():
                best = max(best, 125)
    return best


def score_service(service: Service, query: str) -> int:
    base = norm(query)
    qs = tokens(query)
    vs = variants(service)
    if not base or not vs:
        return 0

    alias_keys = [t for t in qs if t in ALIASES]
    if alias_keys:
        # For short medical abbreviations do not fuzzy-match the whole catalog.
        return max(alias_score(key, service) for key in alias_keys)

    short_query = len(base) <= 4 or all(len(t) <= 4 for t in qs)
    best = 0
    for value in vs:
        if base == value:
            best = max(best, 120)
        elif base in value and len(base) >= 3:
            best = max(best, 105)
        elif value in base and len(value) >= 6:
            best = max(best, 95)
        elif not short_query:
            best = max(best, int(fuzz.WRatio(base, value)))
    return best


def patch_main_matcher() -> None:
    def service_matches_query(service: Service, query: str) -> bool:
        threshold = 100 if any(t in ALIASES for t in tokens(query)) else 65
        return score_service(service, query) >= threshold

    main.service_matches_query = service_matches_query


async def list_services_safe(category: str | None = None, q: str | None = None, db: Session = Depends(get_db), current_user: AuthUser = Depends(require_user)):
    services = (
        db.query(Service)
        .filter(Service.user_id == current_user.user_id, Service.is_active == True)  # noqa: E712
        .order_by(Service.category, Service.service_name)
        .limit(20000)
        .all()
    )
    if category:
        cat = norm(category)
        services = [s for s in services if cat in norm(s.category)]
    if q:
        alias_mode = any(t in ALIASES for t in tokens(q))
        threshold = 100 if alias_mode else 65
        limit = 30 if alias_mode else 80
        ranked = [(score_service(s, q), s) for s in services]
        ranked = [(score, s) for score, s in ranked if score >= threshold]
        ranked.sort(key=lambda item: (-item[0], norm(item[1].service_name)))
        return [s for _, s in ranked[:limit]]
    return services[:500]


def patch_services_route() -> None:
    for route in main.app.router.routes:
        if getattr(route, "path", None) == "/api/services" and "GET" in getattr(route, "methods", set()):
            route.endpoint = list_services_safe
            if hasattr(route, "dependant"):
                route.dependant.call = list_services_safe


patch_main_matcher()
patch_services_route()
