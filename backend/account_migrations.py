from sqlalchemy import text

from db import DATABASE_BACKEND, engine


def run_account_migrations() -> None:
    """Compatibility fixes for deployments created before account-scoped data."""
    if DATABASE_BACKEND != "postgresql":
        return

    with engine.begin() as conn:
        conn.execute(text('ALTER TABLE "partners" DROP CONSTRAINT IF EXISTS partners_name_key'))
        conn.execute(text('ALTER TABLE "partners" DROP CONSTRAINT IF EXISTS ix_partners_name'))
        conn.execute(text('DROP INDEX IF EXISTS "ix_partners_name"'))

        conn.execute(text('ALTER TABLE "services" DROP CONSTRAINT IF EXISTS services_source_code_key'))
        conn.execute(text('ALTER TABLE "services" DROP CONSTRAINT IF EXISTS uq_services_source_code'))
        conn.execute(text('ALTER TABLE "services" DROP CONSTRAINT IF EXISTS ix_services_source_code'))
        conn.execute(text('DROP INDEX IF EXISTS "ix_services_source_code"'))

        conn.execute(text('CREATE INDEX IF NOT EXISTS ix_partners_name_lookup ON "partners" (name)'))
        conn.execute(text('CREATE INDEX IF NOT EXISTS ix_services_source_code_lookup ON "services" (source_code)'))

        conn.execute(text(
            'CREATE UNIQUE INDEX IF NOT EXISTS uq_partners_user_name_idx '
            'ON "partners" (user_id, name) WHERE user_id IS NOT NULL'
        ))
        conn.execute(text(
            'CREATE UNIQUE INDEX IF NOT EXISTS uq_services_user_source_code_idx '
            'ON "services" (user_id, source_code) '
            'WHERE user_id IS NOT NULL AND source_code IS NOT NULL'
        ))


run_account_migrations()

try:
    import backend.catalog_defaults  # noqa: F401,E402
except Exception:
    pass
