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
DEFAULT_SOURCES = (
    ("avito_model", "Авито (модель)"),
    ("avito_manicure", "Авито (маникюр)"),
    ("telegram", "Телеграм"),
    ("ads", "Реклама"),
    ("referral", "По рекомендации"),
)
DEAL_STATUSES = ("planned", "in_progress", "completed", "cancelled")
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


def valid_time(value: object) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
        raise ApiError("Время записи должно быть в формате ЧЧ:ММ")
    return value


def valid_phone(value: object) -> str:
    phone = clean_text(value, "Телефон", 40)
    if phone and not re.fullmatch(r"[+0-9()\-\s]{4,40}", phone):
        raise ApiError("Проверьте номер телефона")
    return phone


def valid_id(value: object, field: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", value):
        raise ApiError(f"Неверный идентификатор: {field}")
    return value


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
                CREATE TABLE IF NOT EXISTS client_sources (
                    id TEXT PRIMARY KEY,
                    label TEXT NOT NULL COLLATE NOCASE UNIQUE
                );
                CREATE TABLE IF NOT EXISTS clients (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    phone TEXT NOT NULL DEFAULT '',
                    note TEXT NOT NULL DEFAULT '',
                    source_id TEXT REFERENCES client_sources(id) ON DELETE RESTRICT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
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
                CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(name);
            """)
            c.executemany("INSERT OR IGNORE INTO categories(id,label) VALUES (?,?)", DEFAULT_CATEGORIES)
            c.executemany("INSERT OR IGNORE INTO client_sources(id,label) VALUES (?,?)", DEFAULT_SOURCES)
            # Existing installations are migrated in place. No previous operation is deleted.
            columns = {r["name"] for r in c.execute("PRAGMA table_info(entries)")}
            if "entry_time" not in columns:
                c.execute("ALTER TABLE entries ADD COLUMN entry_time TEXT")
            if "client_id" not in columns:
                c.execute("ALTER TABLE entries ADD COLUMN client_id TEXT REFERENCES clients(id) ON DELETE RESTRICT")
            if "status" not in columns:
                c.execute("ALTER TABLE entries ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'")
            for row in c.execute("""SELECT DISTINCT client_name FROM entries
                                    WHERE kind='income' AND client_id IS NULL AND TRIM(client_name)<>''""").fetchall():
                name = row["client_name"].strip()
                existing = c.execute("SELECT id FROM clients WHERE name=? COLLATE NOCASE LIMIT 1", (name,)).fetchone()
                client_id = existing["id"] if existing else str(uuid.uuid4())
                if not existing:
                    now = now_iso()
                    c.execute("""INSERT INTO clients(id,name,phone,note,source_id,created_at,updated_at)
                                 VALUES (?,?, '', '', NULL,?,?)""", (client_id,name,now,now))
                c.execute("UPDATE entries SET client_id=? WHERE kind='income' AND client_id IS NULL AND client_name=?",
                          (client_id,row["client_name"]))
            c.execute("CREATE INDEX IF NOT EXISTS idx_entries_client ON entries(client_id)")

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
            sources = [dict(r) for r in c.execute("SELECT id,label FROM client_sources ORDER BY rowid")]
            clients = [self.to_client(r) for r in c.execute("SELECT * FROM clients ORDER BY name COLLATE NOCASE,id")]
            entries = [self.to_entry(r) for r in c.execute("SELECT * FROM entries ORDER BY entry_date,entry_time,created_at,id")]
            return {"categories": categories, "clientSources": sources, "clients": clients, "entries": entries}

    @staticmethod
    def to_client(r: sqlite3.Row) -> dict:
        return {"id":r["id"], "name":r["name"], "phone":r["phone"], "note":r["note"],
                "sourceId":r["source_id"], "createdAt":r["created_at"], "updatedAt":r["updated_at"]}

    @staticmethod
    def to_entry(r: sqlite3.Row) -> dict:
        return {"id": r["id"], "date": r["entry_date"], "time": r["entry_time"],
                "kind": r["kind"], "clientId": r["client_id"], "status": r["status"],
                "name": r["client_name"], "amount": r["amount_kopeks"],
                "taxRate": r["tax_rate"], "categoryId": r["category_id"],
                "note": r["note"], "createdAt": r["created_at"], "updatedAt": r["updated_at"]}

    @staticmethod
    def validate_entry(data: object) -> tuple:
        if not isinstance(data, dict):
            raise ApiError("Некорректная операция")
        kind = data.get("kind")
        if kind not in ("income", "expense"):
            raise ApiError("Неизвестный тип операции")
        entry_date = valid_date(data.get("date"))
        status = data.get("status", "completed")
        if status not in DEAL_STATUSES or not isinstance(status, str):
            raise ApiError("Недопустимая стадия сделки")
        amount = valid_amount(data.get("amount"))
        note = clean_text(data.get("note", ""), "Комментарий", 1000)
        if kind == "income":
            name = clean_text(data.get("name", ""), "Клиент")
            client_id = data.get("clientId") or None
            if client_id is not None:
                valid_id(client_id, "Клиент")
            if not name and client_id is None:
                raise ApiError("Выберите клиента")
            rate = data.get("taxRate")
            if isinstance(rate, bool) or not isinstance(rate, (int, float)) or not 0 <= rate <= 100:
                raise ApiError("Налог должен быть от 0 до 100%")
            return (entry_date, valid_time(data.get("time")), kind, client_id, name, amount, float(rate), None, note, status)
        category_id = data.get("categoryId")
        if not isinstance(category_id, str) or not category_id:
            raise ApiError("Выберите статью расходов")
        return (entry_date, None, kind, None, "", amount, 0, category_id, note, status)

    @staticmethod
    def resolve_entry_client(c: sqlite3.Connection, v: tuple) -> tuple:
        d, t, kind, client_id, name, amount, rate, category_id, note, status = v
        if kind == "income":
            if client_id is not None:
                client = c.execute("SELECT name FROM clients WHERE id=?", (client_id,)).fetchone()
                if client is None:
                    raise ApiError("Клиент не найден")
                name = client["name"]
            else:
                # Compatibility for old API callers and pre-clients JSON backups.
                client = c.execute("SELECT id FROM clients WHERE name=? COLLATE NOCASE LIMIT 1", (name,)).fetchone()
                client_id = client["id"] if client else str(uuid.uuid4())
                if not client:
                    now = now_iso()
                    c.execute("""INSERT INTO clients(id,name,phone,note,source_id,created_at,updated_at)
                                 VALUES (?,?, '', '', NULL,?,?)""", (client_id,name,now,now))
        else:
            if not c.execute("SELECT 1 FROM categories WHERE id=?", (category_id,)).fetchone():
                raise ApiError("Статья расходов не найдена")
        return (d,t,kind,client_id,name,amount,rate,category_id,note,status)

    def save_entry(self, data: object, entry_id: str | None = None) -> dict:
        values = self.validate_entry(data)
        now = now_iso()
        with self.lock, self.db() as c:
            try:
                if entry_id and not c.execute("SELECT 1 FROM entries WHERE id=?", (entry_id,)).fetchone():
                    raise ApiError("Операция не найдена", 404)
                values = self.resolve_entry_client(c, values)
                if entry_id:
                    c.execute("""UPDATE entries SET entry_date=?,entry_time=?,kind=?,client_id=?,client_name=?,
                        amount_kopeks=?,tax_rate=?,category_id=?,note=?,status=?,updated_at=? WHERE id=?""",
                        (*values, now, entry_id))
                else:
                    entry_id = str(uuid.uuid4())
                    c.execute("""INSERT INTO entries(id,entry_date,entry_time,kind,client_id,client_name,
                        amount_kopeks,tax_rate,category_id,note,status,created_at,updated_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", (entry_id,*values,now,now))
                return self.to_entry(c.execute("SELECT * FROM entries WHERE id=?", (entry_id,)).fetchone())
            except sqlite3.IntegrityError as exc:
                raise ApiError("Не удалось сохранить запись из-за ограничения базы") from exc

    def set_deal_status(self, entry_id: str, data: object) -> dict:
        if not isinstance(data, dict) or data.get("status") not in DEAL_STATUSES or not isinstance(data.get("status"), str):
            raise ApiError("Недопустимая стадия сделки")
        valid_id(entry_id, "Сделка")
        with self.lock, self.db() as c:
            if c.execute("UPDATE entries SET status=?,updated_at=? WHERE id=?", (data["status"], now_iso(), entry_id)).rowcount != 1:
                raise ApiError("Сделка не найдена", 404)
            return self.to_entry(c.execute("SELECT * FROM entries WHERE id=?", (entry_id,)).fetchone())

    def save_client(self, data: object, client_id: str | None = None) -> dict:
        if not isinstance(data, dict):
            raise ApiError("Некорректный клиент")
        name = clean_text(data.get("name", ""), "Имя клиента", required=True)
        phone = valid_phone(data.get("phone", ""))
        note = clean_text(data.get("note", ""), "Комментарий", 1000)
        source_id = data.get("sourceId") or None
        if source_id is not None:
            valid_id(source_id, "Источник")
        now = now_iso()
        with self.lock, self.db() as c:
            if source_id and not c.execute("SELECT 1 FROM client_sources WHERE id=?", (source_id,)).fetchone():
                raise ApiError("Источник клиента не найден")
            if client_id:
                if c.execute("""UPDATE clients SET name=?,phone=?,note=?,source_id=?,updated_at=?
                                WHERE id=?""", (name,phone,note,source_id,now,client_id)).rowcount == 0:
                    raise ApiError("Клиент не найден", 404)
                c.execute("UPDATE entries SET client_name=? WHERE client_id=?", (name,client_id))
            else:
                client_id = str(uuid.uuid4())
                c.execute("""INSERT INTO clients(id,name,phone,note,source_id,created_at,updated_at)
                             VALUES (?,?,?,?,?,?,?)""", (client_id,name,phone,note,source_id,now,now))
            return self.to_client(c.execute("SELECT * FROM clients WHERE id=?", (client_id,)).fetchone())

    def delete_client(self, client_id: str) -> None:
        with self.lock, self.db() as c:
            if c.execute("SELECT 1 FROM entries WHERE client_id=? LIMIT 1", (client_id,)).fetchone():
                raise ApiError("У клиента есть посещения. Сначала удалите его операции.", 409)
            if c.execute("DELETE FROM clients WHERE id=?", (client_id,)).rowcount == 0:
                raise ApiError("Клиент не найден", 404)

    def add_source(self, data: object) -> dict:
        if not isinstance(data, dict):
            raise ApiError("Некорректный источник")
        label = clean_text(data.get("label", ""), "Название источника", 70, required=True)
        item = {"id": str(uuid.uuid4()), "label": label}
        with self.lock, self.db() as c:
            try:
                c.execute("INSERT INTO client_sources(id,label) VALUES (?,?)", (item["id"],label))
            except sqlite3.IntegrityError as exc:
                raise ApiError("Такой источник уже существует") from exc
        return item

    def delete_source(self, source_id: str) -> None:
        with self.lock, self.db() as c:
            if c.execute("SELECT 1 FROM clients WHERE source_id=? LIMIT 1", (source_id,)).fetchone():
                raise ApiError("Источник указан у клиентов. Сначала измените их источник.", 409)
            if c.execute("DELETE FROM client_sources WHERE id=?", (source_id,)).rowcount == 0:
                raise ApiError("Источник не найден", 404)

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
        raw_sources = data.get("clientSources", [dict(id=i,label=l) for i,l in DEFAULT_SOURCES])
        raw_clients = data.get("clients", [])
        if not isinstance(raw_sources, list) or not isinstance(raw_clients, list):
            raise ApiError("Некорректная база клиентов")
        if any(len(a)>limit for a,limit in (
            (data["entries"],100000),(data["categories"],5000),(raw_sources,5000),(raw_clients,100000))):
            raise ApiError("Превышен допустимый размер резервной копии")
        def validate_labels(raw: list, title: str, max_length: int):
            ids, labels, result = set(),set(),[]
            for item in raw:
                if not isinstance(item,dict):
                    raise ApiError("Некорректный справочник")
                identifier = valid_id(item.get("id"), title)
                label = clean_text(item.get("label",""),title,max_length,required=True)
                if identifier in ids or label.casefold() in labels:
                    raise ApiError("Повторяющиеся названия или идентификаторы")
                ids.add(identifier);labels.add(label.casefold());result.append((identifier,label))
            return ids,result
        cat_ids,categories = validate_labels(data["categories"],"Статья расходов",50)
        source_ids,sources = validate_labels(raw_sources,"Источник",70)
        client_ids,clients = set(),[]
        for client in raw_clients:
            if not isinstance(client,dict):
                raise ApiError("Некорректный клиент")
            identifier = valid_id(client.get("id"),"Клиент")
            if identifier in client_ids:
                raise ApiError("Повторяющийся клиент")
            client_ids.add(identifier)
            source = client.get("sourceId") or None
            if source is not None and source not in source_ids:
                raise ApiError("В клиенте указан отсутствующий источник")
            created = clean_text(client.get("createdAt",now_iso()),"Дата создания",64,True)
            updated = clean_text(client.get("updatedAt",created),"Дата изменения",64,True)
            clients.append((identifier,clean_text(client.get("name",""),"Имя клиента",240,True),
                            valid_phone(client.get("phone","")),clean_text(client.get("note",""),"Комментарий",1000),
                            source,created,updated))
        entry_ids,entries = set(),[]
        for e in data["entries"]:
            if not isinstance(e,dict):
                raise ApiError("Некорректная операция")
            identifier = valid_id(e.get("id"),"Операция")
            if identifier in entry_ids:
                raise ApiError("Повторяющаяся операция")
            entry_ids.add(identifier)
            v = self.validate_entry(e)
            if v[2] == "expense" and v[7] not in cat_ids:
                raise ApiError("В операции указана отсутствующая статья расходов")
            if v[3] is not None and v[3] not in client_ids:
                raise ApiError("В операции указан отсутствующий клиент")
            created = clean_text(e.get("createdAt",now_iso()),"Дата создания",64,True)
            updated = clean_text(e.get("updatedAt",created),"Дата изменения",64,True)
            entries.append((identifier,v,created,updated))
        with self.lock, self.db() as c:
            # DB transaction makes old data survive any invalid import.
            c.execute("DELETE FROM entries")
            c.execute("DELETE FROM clients")
            c.execute("DELETE FROM client_sources")
            c.execute("DELETE FROM categories")
            c.executemany("INSERT INTO categories(id,label) VALUES (?,?)",categories)
            c.executemany("INSERT INTO client_sources(id,label) VALUES (?,?)",sources)
            c.executemany("""INSERT INTO clients(id,name,phone,note,source_id,created_at,updated_at)
                             VALUES (?,?,?,?,?,?,?)""",clients)
            for identifier,v,created,updated in entries:
                v = self.resolve_entry_client(c,v)
                c.execute("""INSERT INTO entries(id,entry_date,entry_time,kind,client_id,client_name,amount_kopeks,
                             tax_rate,category_id,note,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                          (identifier,*v,created,updated))



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
            elif self.path == "/api/clients":
                self.send_json(self.storage.save_client(self.read_json()), 201)
            elif self.path == "/api/client-sources":
                self.send_json(self.storage.add_source(self.read_json()), 201)
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
            elif path.startswith("/api/clients/") and path.count("/") == 3:
                self.send_json(self.storage.save_client(self.read_json(), path.rsplit("/", 1)[1]))
            else:
                self.send_json({"error": "Не найдено"}, 404)
        self.run_action(fn)

    def do_PATCH(self):
        def fn():
            path = urlsplit(self.path).path
            parts = path.split("/")
            if len(parts) == 5 and parts[:3] == ["", "api", "entries"] and parts[4] == "status":
                self.send_json(self.storage.set_deal_status(parts[3], self.read_json()))
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
            elif path.startswith("/api/clients/") and path.count("/") == 3:
                self.storage.delete_client(path.rsplit("/", 1)[1])
            elif path.startswith("/api/client-sources/") and path.count("/") == 3:
                self.storage.delete_source(path.rsplit("/", 1)[1])
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
