from pathlib import Path
from config import config

PAYLOADS_DIR = Path(config.payloads_dir)


def ensure_dirs() -> None:
    PAYLOADS_DIR.mkdir(parents=True, exist_ok=True)
