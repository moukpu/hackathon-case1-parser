import os

import uvicorn

# Registers optional API routes without touching backend/main.py.
import backend.export_routes  # noqa: F401,E402


raw_port = os.getenv("PORT", "8080")
try:
    port = int(raw_port)
except (TypeError, ValueError):
    port = 8080

uvicorn.run("backend.main:app", host="0.0.0.0", port=port)
