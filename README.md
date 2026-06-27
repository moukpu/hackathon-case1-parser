# MedArchive Price Parser MVP

MVP for the hackathon case: automatic parsing of partner clinic price lists, matching extracted services to the target service catalog, verification queue, and search API.

## What is implemented

- FastAPI backend with Swagger at `/docs`
- Upload of price files via `/api/upload`
- ZIP unpacking with multiple price files inside
- Text extraction from PDF, XLSX/XLS/CSV, DOCX
- Service catalog import from XLSX/CSV/JSON via `/api/catalog/upload`
- Database schema close to the case requirements:
  - `Partner`
  - `PriceDocument`
  - `PriceItem`
  - `Service`
- Matching pipeline:
  - exact code match
  - exact/synonym name match
  - RapidFuzz fuzzy match
  - unmatched / low confidence queue
- Validation flags:
  - missing or invalid price
  - nonresident price lower than resident price
  - future effective date
- Operator endpoints:
  - `/api/unmatched`
  - `/api/match`
- Search endpoints:
  - `/api/services`
  - `/api/services/{id}/partners`
  - `/api/partners`
  - `/api/partners/{id}/services`
  - `/api/search?q=`
  - `/api/stats`

## Run locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export GROQ_API_KEY="your_key_here"
uvicorn backend.main:app --reload
```

Open:

```text
http://127.0.0.1:8000
http://127.0.0.1:8000/docs
```

## Load service catalog

Upload the organizer catalog first:

```bash
curl -X POST http://127.0.0.1:8000/api/catalog/upload \
  -F "file=@Справочник услуг.xlsx"
```

The importer supports columns like:

- `ID`
- `Code`
- `Name_ru`
- `Специальность`
- `TarificatrCode`
- `synonyms` if available

## Upload price list

```bash
curl -X POST http://127.0.0.1:8000/api/upload \
  -F "clinic_name=Demo Clinic" \
  -F "effective_date=2026-06-27" \
  -F "files=@price.xlsx"
```

You can also upload a ZIP archive with multiple PDF/XLSX/DOCX/CSV files inside.

## Case coverage

| Requirement | Status |
|---|---|
| ZIP archive upload | MVP supported |
| PDF text extraction | MVP supported |
| XLSX/XLS all-sheet extraction | MVP supported |
| DOCX tables/text extraction | MVP supported |
| Scan PDF OCR | Not implemented yet; documents are marked for error/review |
| Service catalog loading | MVP supported |
| Matching to catalog | exact + synonyms + fuzzy |
| Manual verification queue | API supported |
| Search API | MVP supported |
| OpenAPI documentation | FastAPI Swagger supported |
| Price history/versioning | Data model supports multiple documents/items by date; advanced archive rules are next step |

## Next steps before final demo

1. Add OCR fallback for scanned PDFs.
2. Add frontend tabs for catalog upload, unmatched queue and search.
3. Add anomaly check against previous prices > 50%.
4. Add tests with several organizer price files.
5. Add demo metrics export: documents processed, auto-match %, needs-review count.
