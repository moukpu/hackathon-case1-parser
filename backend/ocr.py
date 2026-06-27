import io
import os
import shutil
from typing import Iterable

import fitz  # PyMuPDF
import pytesseract
from PIL import Image, ImageOps


OCR_ENABLED = os.getenv("OCR_ENABLED", "1").lower() not in {"0", "false", "no", "off"}
OCR_LANG = os.getenv("OCR_LANG", "rus+eng+kaz")
OCR_MAX_PAGES = int(os.getenv("OCR_MAX_PAGES", "8"))
OCR_RENDER_DPI = int(os.getenv("OCR_RENDER_DPI", "200"))
OCR_MIN_CHARS = int(os.getenv("OCR_MIN_CHARS", "40"))


def ocr_available() -> bool:
    return OCR_ENABLED and shutil.which("tesseract") is not None


def _iter_pdf_page_images(file_bytes: bytes, max_pages: int) -> Iterable[tuple[int, Image.Image]]:
    with fitz.open(stream=file_bytes, filetype="pdf") as doc:
        zoom = OCR_RENDER_DPI / 72
        matrix = fitz.Matrix(zoom, zoom)
        page_count = min(len(doc), max_pages)
        for page_index in range(page_count):
            page = doc.load_page(page_index)
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            image = Image.open(io.BytesIO(pix.tobytes("png")))
            yield page_index + 1, image


def _prepare_image(image: Image.Image) -> Image.Image:
    image = image.convert("L")
    image = ImageOps.autocontrast(image)
    return image


def ocr_pdf_text(file_bytes: bytes, max_pages: int | None = None) -> str:
    """Run OCR over PDF pages and return plain text.

    This is intentionally a fallback for scanned PDFs. Normal text/table
    extraction should run first because it is faster and more accurate for
    digital PDFs.
    """
    if not ocr_available():
        return ""

    pages_limit = max_pages or OCR_MAX_PAGES
    chunks: list[str] = []
    for page_num, image in _iter_pdf_page_images(file_bytes, pages_limit):
        try:
            prepared = _prepare_image(image)
            text = pytesseract.image_to_string(prepared, lang=OCR_LANG, config="--psm 6")
        except Exception:
            # Some containers may miss an optional language pack. Retry with rus+eng.
            try:
                text = pytesseract.image_to_string(_prepare_image(image), lang="rus+eng", config="--psm 6")
            except Exception:
                text = ""
        if text.strip():
            chunks.append(f"\n--- OCR PDF page {page_num} ---\n{text.strip()}")

    result = "\n".join(chunks).strip()
    return result if len(result.strip()) >= OCR_MIN_CHARS else ""
