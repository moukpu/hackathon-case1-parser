import io
import zipfile
from pathlib import PurePosixPath
from typing import Iterable, Tuple

import pandas as pd
import pdfplumber
from docx import Document


SUPPORTED_EXTENSIONS = (".pdf", ".xlsx", ".xls", ".csv", ".docx", ".txt")


def detect_file_format(filename: str, file_bytes: bytes | None = None) -> str:
    lower = filename.lower()
    if lower.endswith(".pdf"):
        return "pdf"
    if lower.endswith((".xlsx", ".xls")):
        return "xlsx"
    if lower.endswith(".docx"):
        return "docx"
    if lower.endswith(".csv"):
        return "csv"
    if lower.endswith(".zip"):
        return "zip"
    return "text"


def iter_input_files(filename: str, file_bytes: bytes) -> Iterable[Tuple[str, bytes]]:
    """Yield original file or files inside ZIP.

    For ZIP files we keep the inner relative path, not just basename. This allows
    the API to infer partner/clinic names from folders like `Clinic A/price.xlsx`.
    """
    if filename.lower().endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(file_bytes)) as archive:
            for info in archive.infolist():
                if info.is_dir():
                    continue
                inner_path = str(PurePosixPath(info.filename.replace("\\", "/")))
                basename = PurePosixPath(inner_path).name
                if not basename or basename.startswith(".") or "__MACOSX" in inner_path:
                    continue
                if not basename.lower().endswith(SUPPORTED_EXTENSIONS):
                    continue
                yield inner_path, archive.read(info.filename)
    else:
        yield filename, file_bytes


def extract_text_from_pdf(file_bytes: bytes) -> str:
    chunks: list[str] = []
    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        for page_index, page in enumerate(pdf.pages, start=1):
            page_text = page.extract_text() or ""
            if page_text.strip():
                chunks.append(f"\n--- PDF page {page_index} text ---\n{page_text}")

            try:
                tables = page.extract_tables() or []
            except Exception:
                tables = []

            for table_index, table in enumerate(tables, start=1):
                rows = []
                for row in table:
                    rows.append("\t".join("" if cell is None else str(cell).strip() for cell in row))
                if rows:
                    chunks.append(f"\n--- PDF page {page_index} table {table_index} ---\n" + "\n".join(rows))

    return "\n".join(chunks).strip()


def extract_text_from_excel(file_bytes: bytes, filename: str = "") -> str:
    lower = filename.lower()
    if lower.endswith(".csv"):
        df = pd.read_csv(io.BytesIO(file_bytes), header=None, dtype=str)
        return df.fillna("").to_string(index=False, header=False)

    sheets = pd.read_excel(io.BytesIO(file_bytes), sheet_name=None, header=None, dtype=str)
    chunks: list[str] = []
    for sheet_name, df in sheets.items():
        df = df.dropna(how="all").fillna("")
        if df.empty:
            continue
        lines = []
        for row in df.astype(str).values.tolist():
            cleaned = [cell.strip() for cell in row]
            if any(cleaned):
                lines.append("\t".join(cleaned))
        if lines:
            chunks.append(f"\n--- XLSX sheet: {sheet_name} ---\n" + "\n".join(lines))
    return "\n".join(chunks).strip()


def extract_text_from_docx(file_bytes: bytes) -> str:
    doc = Document(io.BytesIO(file_bytes))
    chunks: list[str] = []

    paragraphs = [p.text.strip() for p in doc.paragraphs if p.text and p.text.strip()]
    if paragraphs:
        chunks.append("\n--- DOCX text ---\n" + "\n".join(paragraphs))

    for table_index, table in enumerate(doc.tables, start=1):
        rows = []
        for row in table.rows:
            rows.append("\t".join(cell.text.strip() for cell in row.cells))
        if rows:
            chunks.append(f"\n--- DOCX table {table_index} ---\n" + "\n".join(rows))

    return "\n".join(chunks).strip()


def extract_text(filename: str, file_bytes: bytes) -> str:
    filename_lower = filename.lower()
    if filename_lower.endswith(".pdf"):
        return extract_text_from_pdf(file_bytes)
    if filename_lower.endswith((".xlsx", ".xls", ".csv")):
        return extract_text_from_excel(file_bytes, filename)
    if filename_lower.endswith(".docx"):
        return extract_text_from_docx(file_bytes)

    try:
        return file_bytes.decode("utf-8")
    except UnicodeDecodeError:
        try:
            return file_bytes.decode("cp1251")
        except UnicodeDecodeError as exc:
            raise ValueError(f"Формат файла {filename} не поддерживается.") from exc
