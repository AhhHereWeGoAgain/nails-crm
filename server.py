#!/usr/bin/env python3
"""Nails CRM: dependency-free local SQLite server and web UI."""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import uuid
from datetime import date, datetime, timezone
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import RLock
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
DEFAULT_DB = Path.home() / ".nails-crm" / "data.sqlite3"
DEFAULT_CATEGORIES = (
    ("rent", "Аренда"),
    ("materials", "Материалы"),
    ("equipment", "Оборудование"),
    ("other", "Прочее"),
)


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def valid_date(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ApiError("Дата должна быть в формате YYYY-MM-DD")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise ApiError("Несуществующая дата") from exc
    return value


def valid_amount(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 10**12:
        raise ApiError("Сумма должна быть положительным числом в копейках")
    return value


def clean_text(value: object, field: str, limit: int = 240, required: bool = False) -> str:
    if not isinstance(value, str):
        raise ApiError(f"Поле «{field}» должно быть текстом")
    result = value.strip()
    if len(result) > limit or (required and not result):
        raise ApiError(f"Проверьте поле «{field}»")
    return result


class Storage:
    def __init__(self, file: Path):
        self.file = file
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()
        with self.db() as c:
            c.executescript("""
                CREATE TABLE IF NOT EXISTS categories (
                    id TEXT PRIMARY KEY,
                    label TEXT NOT NULL COLLATE NOCASE UNIQUE
                );
                CREATE TABLE IF NOT EXISTS entries (
                    id TEXT PRIMARY KEY,
                    entry_date TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('income','expense')),
                    client_name TEXT NOT NULL DEFAULT '',
                    amount_kopeks INTEGER NOT NULL CHECK(amount_kopeks > 0),
                    tax_rate REAL NOT NULL DEFAULT 0 CHECK(tax_rate >= 0 AND tax_rate <= 100),
                    category_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
                    note TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    CHECK((kind = 'income' AND category_id IS NULL) OR
                          (kind = 'expense' AND category_id IS NOT NULL))
                );
                CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(entry_date);
                CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at);
            """)
            c.executemany("INSERT OR IGNORE INTO categories(id,label) VALUES (?,?)", DEFAULT_CATEGORIES)

    @contextmanager
    def db(self):
        connection = sqlite3.connect(str(self.file), timeout=15)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("PRAGMA busy_timeout = 15000")
            with connection:
                yield connection
        finally:
            connection.close()

    def state(self) -> dict:
        with self.lock, self.db() as c:
            categories = [dict(r) for r in c.execute("SELECT id,label FROM categories ORDER BY rowid")]
            entries = [self.to_entry(r) for r in c.execute("SELECT * FROM entries ORDER BY entry_date, created_at, id")]
            return {"categories": categories, "entries": entries}

    @staticmethod
    def to_entry(r: sqlite3.Row) -> dict:
        return {"id": r["id"], "date": r["entry_date"], "kind": r["kind"],
                "name": r["client_name"], "amount": r["amount_kopeks"],
                "taxRate": r["tax_rate"], "categoryId": r["category_id"],
                "note": r["note"], "createdAt": r["created_at"], "updatedAt": r["updated_at"]}

    def validate_entry(self, data: object) -> tuple:
        if not isinstance(data, dict):
            raise ApiError("Некорректная операция")
        kind = data.get("kind")
        if kind not in ("income", "expense"):
            raise ApiError("Неизвестный тип операции")
        entry_date = valid_date(data.get("date"))
        amount = valid_amount(data.get("amount"))
        note = clean_text(data.get("note", ""), "Комментарий", 1000)
        if kind == "income":
            name = clean_text(data.get("name", ""), "Клиент", required=True)
            rate = data.get("taxRate")
            if isinstance(rate, bool) or not isinstance(rate, (int, float)) or not 0 <= rate <= 100:
                raise ApiError("Налог должен быть от 0 до 100%")
            return (entry_date, kind, name, amount, float(rate), None, note)
        category_id = data.get("categoryId")
        if not isinstance(category_id, str) or not category_id:
            raise ApiError("Выберите статью расходов")
        return (entry_date, kind, "", amount, 0, category_id, note)

    def save_entry(self, data: object, entry_id: str | None = None) -> dict:
        values = self.validate_entry(data)
        now = now_iso()
        with self.lock, self.db() as c:
            try:
                if values[1] == "expense" and not c.execute("SELECT 1 FROM categories WHERE id=?", (values[5],)).fetchone():
                    raise ApiError("Статья расходов не найдена")
                if entry_id:
                    row = c.execute("SELECT created_at FROM entries WHERE id=?", (entry_id,)).fetchone()
                    if row is None:
                        raise ApiError("Операция не найдена", 404)
                    c.execute("""UPDATE entries SET entry_date=?,kind=?,client_name=?,amount_kopeks=?,
                        tax_rate=?,category_id=?,note=?,updated_at=? WHERE id=?""", (*values, now, entry_id))
                else:
                    entry_id = str(uuid.uuid4())
                    c.execute("""INSERT INTO entries(id,entry_date,kind,client_name,amount_kopeks,
                        tax_rate,category_id,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                        (entry_id, *values, now, now))
                r = c.execute("SELECT * FROM entries WHERE id=?", (entry_id,)).fetchone()
                return self.to_entry(r)
            except sqlite3.IntegrityError as exc:
                raise ApiError("Не удалось сохранить запись из-за ограничения базы") from exc

    def delete_entry(self, entry_id: str) -> None:
        with self.lock, self.db() as c:
            if c.execute("DELETE FROM entries WHERE id=?", (entry_id,)).rowcount == 0:
                raise ApiError("Операция не найдена", 404)

    def add_category(self, data: object) -> dict:
        if not isinstance(data, dict):
            raise ApiError("Неверная статья расходов")
        label = clean_text(data.get("label", ""), "Название статьи", 50, required=True)
        item = {"id": str(uuid.uuid4()), "label": label}
        with self.lock, self.db() as c:
            try:
                c.execute("INSERT INTO categories(id,label) VALUES (?,?)", (item["id"], label))
            except sqlite3.IntegrityError as exc:
                raise ApiError("Такая статья расходов уже существует") from exc
        return item

    def delete_category(self, category_id: str) -> None:
        with self.lock, self.db() as c:
            if c.execute("SELECT 1 FROM entries WHERE category_id=? LIMIT 1", (category_id,)).fetchone():
                raise ApiError("Категория используется в записях. Сначала измените или удалите их.", 409)
            if c.execute("DELETE FROM categories WHERE id=?", (category_id,)).rowcount == 0:
                raise ApiError("Статья расходов не найдена", 404)

    def replace_state(self, data: object) -> None:
        if not isinstance(data, dict) or not isinstance(data.get("categories"), list) or not isinstance(data.get("entries"), list):
            raise ApiError("Некорректная резервная копия")
        if len(data["entries"]) > 100000 or len(data["categories"]) > 5000:
            raise ApiError("Превышен допустимый размер резервной копии")
        cat_ids, labels, categories, entries, entry_ids = set(), set(), [], [], set()
        for cat in data["categories"]:
            if not isinstance(cat, dict):
                raise ApiError("Некорректная категория")
            identifier = cat.get("id")
            if not isinstance(identifier, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", identifier) or identifier in cat_ids:
                raise ApiError("Неверный идентификатор категории")
            label = clean_text(cat.get("label", ""), "Название статьи", 50, required=True)
            if label.casefold() in labels:
                raise ApiError("Статьи расходов должны иметь уникальные названия")
            cat_ids.add(identifier)
            labels.add(label.casefold())
            categories.append((identifier, label))
        for e in data["entries"]:
            if not isinstance(e, dict):
                raise ApiError("Некорректная операция")
            identifier = e.get("id")
            if not isinstance(identifier, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", identifier) or identifier in entry_ids:
                raise ApiError("Неверный идентификатор операции")
            entry_ids.add(identifier)
            v = self.validate_entry(e)
            if v[1] == "expense" and v[5] not in cat_ids:
                raise ApiError("В операции указана отсутствующая категория")
            created = clean_text(e.get("createdAt", now_iso()), "Дата создания", 64, required=True)
            updated = clean_text(e.get("updatedAt", created), "Дата изменения", 64, required=True)
            entries.append((identifier, *v, created, updated))
        with self.lock, self.db() as c:
            c.execute("DELETE FROM entries")
            c.execute("DELETE FROM categories")
            c.executemany("INSERT INTO categories(id,label) VALUES (?,?)", categories)
            c.executemany("""INSERT INTO entries(id,entry_date,kind,client_name,amount_kopeks,
                tax_rate,category_id,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)""", entries)



class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, storage: Storage, **kwargs):
        self.storage = storage
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/state"):
            super().log_message(fmt, *args)

    def send_json(self, payload: object, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def run_action(self, action):
        try:
            action()
        except ApiError as exc:
            self.send_json({"error": str(exc)}, exc.status)
        except (json.JSONDecodeError, UnicodeError):
            self.send_json({"error": "Некорректный JSON"}, 400)
        except Exception:
            import traceback
            traceback.print_exc()
            self.send_json({"error": "Ошибка сервера"}, 500)

    def read_json(self, limit: int = 32_768):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > limit:
            raise ApiError("Размер запроса недопустим", 413)
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/state":
            return self.run_action(lambda: self.send_json(self.storage.state()))
        if path.startswith("/api/"):
            return self.send_json({"error": "Не найдено"}, 404)
        if path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        def fn():
            if self.path == "/api/entries":
                self.send_json(self.storage.save_entry(self.read_json()), 201)
            elif self.path == "/api/categories":
                self.send_json(self.storage.add_category(self.read_json()), 201)
            elif self.path == "/api/import":
                self.storage.replace_state(self.read_json(12_000_000))
                self.send_json({"ok": True})
            else:
                self.send_json({"error": "Не найдено"}, 404)
        self.run_action(fn)

    def do_PUT(self):
        def fn():
            path = urlsplit(self.path).path
            if path.startswith("/api/entries/") and path.count("/") == 3:
                self.send_json(self.storage.save_entry(self.read_json(), path.rsplit("/", 1)[1]))
            else:
                self.send_json({"error": "Не найдено"}, 404)
        self.run_action(fn)

    def do_DELETE(self):
        def fn():
            path = urlsplit(self.path).path
            if path.startswith("/api/entries/") and path.count("/") == 3:
                self.storage.delete_entry(path.rsplit("/", 1)[1])
            elif path.startswith("/api/categories/") and path.count("/") == 3:
                self.storage.delete_category(path.rsplit("/", 1)[1])
            else:
                self.send_json({"error": "Не найдено"}, 404)
                return
            self.send_json({"ok": True})
        self.run_action(fn)


def start_server(host: str = "127.0.0.1", port: int = 8765, db_path: Path = DEFAULT_DB):
    storage = Storage(Path(db_path))
    handler = partial(Handler, storage=storage)
    httpd = ThreadingHTTPServer((host, port), handler)
    return httpd


def main():
    parser = argparse.ArgumentParser(description="Nails CRM: календарь и финансы без облака")
    parser.add_argument("--host", default="127.0.0.1", help="0.0.0.0 — доступ через домашний Wi-Fi (без шифрования)")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    args = parser.parse_args()
    server = start_server(args.host, args.port, args.db)
    print(f"Nails CRM: http://127.0.0.1:{server.server_port}/")
    print(f"База данных: {args.db.resolve()}")
    if args.host == "0.0.0.0":
        print("ВНИМАНИЕ: доступно другим устройствам в сети. Только доверенный Wi-Fi!")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
