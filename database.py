import sqlite3
import os
from pathlib import Path

DB_PATH = os.getenv('DB_PATH', 'emailcenter.db')
MIGRATIONS_DIR = Path(__file__).parent / 'migrations'


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def apply_migrations() -> None:
    conn = get_conn()
    with conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS _migrations (
                filename   TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        applied = {row[0] for row in conn.execute("SELECT filename FROM _migrations")}
        for path in sorted(MIGRATIONS_DIR.glob('*.sql')):
            if path.name not in applied:
                conn.executescript(path.read_text(encoding='utf-8'))
                conn.execute(
                    "INSERT INTO _migrations (filename) VALUES (?)",
                    (path.name,)
                )
                print(f"  applied {path.name}")
    conn.close()


if __name__ == '__main__':
    print(f"Database: {DB_PATH}")
    apply_migrations()
    print("Done.")
