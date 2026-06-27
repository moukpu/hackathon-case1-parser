import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(BASE_DIR, "backend")
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import uvicorn

# Registers optional API routes without touching backend/main.py.
import backend.auth_routes  # noqa: F401,E402
import backend.account_migrations  # noqa: F401,E402
import backend.job_detail_patch  # noqa: F401,E402
import backend.export_routes  # noqa: F401,E402
import backend.job_state  # noqa: F401,E402
import backend.admin_job_control  # noqa: F401,E402
import backend.job_persistence  # noqa: F401,E402
import backend.upload_history  # noqa: F401,E402
import backend.review_candidates  # noqa: F401,E402
import backend.catalog_settings  # noqa: F401,E402
import backend.db_info  # noqa: F401,E402


raw_port = os.getenv("PORT", "8080")
try:
    port = int(raw_port)
except (TypeError, ValueError):
    port = 8080

uvicorn.run("backend.main:app", host="0.0.0.0", port=port)
