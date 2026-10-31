#!/usr/bin/env python3
"""Native desktop window with its own SQLite server (requires pywebview)."""
from pathlib import Path
import sys
from threading import Thread

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import DEFAULT_DB, start_server  # noqa: E402


def main():
    try:
        import webview
    except ImportError:
        raise SystemExit("Для десктопного окна установите: python -m pip install pywebview")
    httpd = start_server('127.0.0.1', 0, DEFAULT_DB)
    thread = Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    address = f'http://127.0.0.1:{httpd.server_port}/'
    try:
        webview.create_window('Nails CRM', address, width=1260, height=835, min_size=(850, 620))
        webview.start(private_mode=False, storage_path=str(DEFAULT_DB.parent / 'webview'))
    finally:
        httpd.shutdown()
        httpd.server_close()


if __name__ == '__main__':
    main()
