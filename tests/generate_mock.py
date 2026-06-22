import pandas as pd
import os

os.makedirs("/home/moukpu/.gemini/antigravity/scratch/price-parser-hackathon/uploads", exist_ok=True)

data = [
    ["Код", "Услуга (грязное название)", "Цена (тенге)"],
    ["A01.01", "Консультация терапевта первичная", "10 000"],
    ["A01.02", "Конс. терапевта повт.", "8000"],
    ["B03.14", "МРТ гол. мозга с контрастом", "45000"],
    ["-", "УЗИ брюшн. пол.", "12000"],
    ["C11.1", "Общий анализ крови (ОАК)", "2500"]
]
df = pd.DataFrame(data)
df.to_excel("/home/moukpu/.gemini/antigravity/scratch/price-parser-hackathon/uploads/test_price.xlsx", index=False, header=False)
print("Тестовый файл test_price.xlsx успешно создан!")
