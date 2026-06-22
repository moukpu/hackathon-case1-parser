import pdfplumber
import pandas as pd
import io

def extract_text_from_pdf(file_bytes: bytes) -> str:
    text = ""
    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                text += page_text + "\n"
    return text

def extract_text_from_excel(file_bytes: bytes) -> str:
    try:
        # Пытаемся прочитать как XLSX/XLS
        df = pd.read_excel(io.BytesIO(file_bytes), header=None)
    except Exception:
        # Если не вышло, пробуем CSV
        df = pd.read_csv(io.BytesIO(file_bytes), header=None)
    
    # Преобразуем DataFrame в строку.
    # Нам не нужна идеальная структура таблицы для AI, 
    # LLM сама поймет, где название, а где цена.
    text = df.to_string(index=False, header=False)
    return text

def extract_text(filename: str, file_bytes: bytes) -> str:
    filename_lower = filename.lower()
    if filename_lower.endswith(".pdf"):
        return extract_text_from_pdf(file_bytes)
    elif filename_lower.endswith((".xlsx", ".xls")):
        return extract_text_from_excel(file_bytes)
    else:
        # Попробуем прочитать как обычный текст (в том числе CSV)
        try:
            return file_bytes.decode('utf-8')
        except UnicodeDecodeError:
            try:
                return file_bytes.decode('cp1251')
            except UnicodeDecodeError:
                raise ValueError(f"Формат файла {filename} не поддерживается.")
