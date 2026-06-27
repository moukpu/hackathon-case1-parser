# Concrete implementation plan for the hackathon case

## Goal

Move the repository from a one-page AI price parser to a case-ready MVP:

1. Parse clinic price documents.
2. Load organizer service catalog.
3. Match raw extracted services to catalog services.
4. Store partners, documents, price items, services, statuses and verification flags.
5. Expose API and Swagger for search and operator review.

## Sprint 1 — Foundation

- Replace one-table DB with case entities: Partner, Service, PriceDocument, PriceItem.
- Keep existing frontend-compatible `/api/upload` response shape.
- Add `/api/catalog/upload` for organizer catalog.
- Add RapidFuzz normalizer.
- Add ZIP/DOCX/XLSX all-sheet extraction.
- Add `/api/services`, `/api/search`, `/api/unmatched`, `/api/match`, `/api/stats`.

## Sprint 2 — Demo UX

- Add UI sections:
  - catalog upload
  - price upload
  - search service -> partners/prices
  - unmatched queue
  - stats dashboard
- Add buttons for manual match and verification.

## Sprint 3 — Quality and scoring

- Add tests with sample XLSX, PDF, DOCX.
- Add previous-price anomaly check > 50%.
- Add OCR fallback for scanned PDFs.
- Add README screenshots and demo script.
- Add report endpoint/export with processing metrics.

## Judging focus

- Extraction quality: show XLSX/PDF/DOCX working.
- Normalization: show auto-match percent and unmatched queue.
- Verification: show operator can correct a match.
- API: show Swagger endpoints.
- UX: show quick admin flow.
