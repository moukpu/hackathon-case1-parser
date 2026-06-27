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
    "мрт": ["магнитно резонансная томография", "магнитно-резонансная томография"],
    "кт": ["компьютерная томография"],
    "оак": ["общий анализ крови"],
    "оам": ["общий анализ мочи"],
    "биохимия": ["биохимический анализ крови"],
    "лфк": ["лечебная физкультура", "лечебная физическая культура"],
    "эгдс": ["эзофагогастродуоденоскопия", "фгдс", "гастроскопия"],
    "фгдс": ["эзофагогастродуоденоскопия", "эгдс", "гастроскопия"],
}

TRASH_WORDS = {
    "без", "лс", "ими", "имн", "процедура", "исследование", "услуга", "час", "часа",
    "1", "2", "3", "4", "5", "один", "одна", "одно",
}


def norm(value) -> str:
    text = str(value or "").casefold().replace("ё", "е")
    text = re.sub(r"[^a-zа-я0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def terms(query: str) -> list[str]:
    base = norm(query)
    output = {base}
    tokens = [t for t in base.split() if t and t not in TRASH_WORDS]
    output.update(tokens)
    for token in tokens:
        for alias in ALIASES.get(token, []):
            output.add(norm(alias))
    for key, aliases in ALIASES.items():
        if key in tokens:
            output.add(norm(" ".join(aliases[:1])))
    return [t for t in output if len(t) >= 2]


def variants(service: Service) -> list[str]:
    values = [
        service.service_name,
        service.category,
        service.source_code,
        service.tarificatr_code,
        " ".join(service.synonyms),
    ]
    return [norm(v) for v in values if norm(v)]


def score_service(service: Service, query: str) -> int:
    qs = terms(query)
    vs = variants(service)
    if not qs or not vs:
        return 0

    best = 0
    for q in qs:
        for v in vs:
            if q == v:
                best = max(best, 120)
            elif q in v:
                best = max(best, 105 if len(q) <= 4 else 100)
            elif v in q and len(v) >= 5:
                best = max(best, 95)
            else:
                best = max(best, int(fuzz.WRatio(q, v)))
    return best


def patch_main_matcher() -> None:
    def service_matches_query(service: Service, query: str) -> bool:
        return score_service(service, query) >= 55

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
        ranked = [(score_service(s, q), s) for s in services]
        ranked = [(score, s) for score, s in ranked if score >= 45]
        ranked.sort(key=lambda item: (-item[0], norm(item[1].service_name)))
        return [s for _, s in ranked[:120]]
    return services[:500]


def patch_services_route() -> None:
    for route in main.app.router.routes:
        if getattr(route, "path", None) == "/api/services" and "GET" in getattr(route, "methods", set()):
            route.endpoint = list_services_safe
            if hasattr(route, "dependant"):
                route.dependant.call = list_services_safe


patch_main_matcher()
patch_services_route()
