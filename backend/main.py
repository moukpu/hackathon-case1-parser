from fastapi import FastAPI, UploadFile, File, Form, Depends, HTTPException
from typing import List
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from fastapi.middleware.cors import CORSMiddleware
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from db import get_db, ServicePrice, engine, Base
from extractor import extract_text
from ai_processor import parse_price_list_with_ai

app = FastAPI(title="Hackathon Price Parser API")

# Разрешаем CORS чтобы Case 2 мог делать fetch запросы к парсеру
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Подключаем статику (для фронтенда)
frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/frontend", StaticFiles(directory=frontend_dir), name="frontend")

@app.get("/", response_class=HTMLResponse)
async def read_index():
    with open(os.path.join(frontend_dir, "index.html"), "r", encoding="utf-8") as f:
        return f.read()

@app.post("/api/upload")
async def upload_file(
    files: List[UploadFile] = File(...),
    clinic_name: str = Form(...),
    db: Session = Depends(get_db)
):
    try:
        all_parsed_items = []
        groq_api_key = os.getenv("GROQ_API_KEY")
        if not groq_api_key:
            raise HTTPException(status_code=500, detail="API ключ не настроен.")
        # 1-3. Читаем и парсим все файлы
        for file in files:
            contents = await file.read()
            raw_text = extract_text(file.filename, contents)
            
            if not raw_text.strip():
                if file.filename.lower().endswith('.pdf'):
                    raise ValueError(f"Файл {file.filename} не содержит распознаваемого текста. Если это скан или фотография, система пока не поддерживает OCR. Пожалуйста, используйте Excel или текстовый PDF.")
                continue
            
            parsed_data = parse_price_list_with_ai(raw_text, groq_api_key)
            if parsed_data:
                all_parsed_items.extend(parsed_data)
        
        if not all_parsed_items:
            raise HTTPException(status_code=400, detail="Не удалось извлечь данные ни из одного файла.")
            
        # 4. Дедупликация и сохранение
        existing_items = db.query(ServicePrice.standardized_name).filter(ServicePrice.clinic_name == clinic_name).all()
        existing_names = {item[0] for item in existing_items if item[0]}
        
        saved_items = []
        for item in all_parsed_items:
            std_name = item.get("standardized_name")
            if not std_name or std_name in existing_names:
                continue
                
            existing_names.add(std_name)
            
            db_item = ServicePrice(
                clinic_name=clinic_name,
                service_code=item.get("service_code"),
                original_name=item.get("original_name"),
                standardized_name=std_name,
                price=item.get("price"),
                category=item.get("category"),
                confidence=item.get("confidence", 100)
            )
            db.add(db_item)
            saved_items.append(item)
            
        db.commit()
        
        return {
            "message": "Успешно обработано!",
            "clinic_name": clinic_name,
            "items_found": len(all_parsed_items),
            "data": all_parsed_items
        }
        
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Внутренняя ошибка: {str(e)}")

@app.get("/api/prices")
async def get_prices(clinic_name: str = None, db: Session = Depends(get_db)):
    query = db.query(ServicePrice)
    if clinic_name:
        query = query.filter(ServicePrice.clinic_name == clinic_name)
    prices = query.all()
    return prices
