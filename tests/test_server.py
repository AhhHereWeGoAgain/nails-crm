from __future__ import annotations
import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import Storage, start_server, ApiError


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.storage = Storage(Path(self.temp.name) / 'db.sqlite3')

    def tearDown(self):
        self.temp.cleanup()

    def test_create_edit_delete_and_category_restriction(self):
        inc = self.storage.save_entry({'kind':'income','date':'2026-10-31','name':'Анна','amount':220000,'taxRate':4,'note':'Френч'})
        expense = self.storage.save_entry({'kind':'expense','date':'2026-10-31','amount':800000,'categoryId':'rent','note':''})
        self.assertEqual(len(self.storage.state()['entries']), 2)
        self.assertEqual(inc['taxRate'], 4)
        with self.assertRaises(ApiError) as ctx:
            self.storage.delete_category('rent')
        self.assertEqual(ctx.exception.status, 409)
        changed = self.storage.save_entry({'kind':'income','date':'2026-10-31','name':'Анна','amount':250000,'taxRate':6,'note':'Изменено'}, inc['id'])
        self.assertEqual(changed['amount'], 250000)
        self.storage.delete_entry(expense['id'])
        self.storage.delete_category('rent')
        self.assertFalse(any(x['id']=='rent' for x in self.storage.state()['categories']))

    def test_backup_restore_atomic(self):
        e = self.storage.save_entry({'kind':'income','date':'2026-10-31','name':'Анна','amount':200000,'taxRate':4,'note':''})
        original = self.storage.state()
        copy = json.loads(json.dumps(original))
        copy['entries'].append(dict(e, id='duplicated', date='2026-02-30'))
        with self.assertRaises(ApiError):
            self.storage.replace_state(copy)
        self.assertEqual(original, self.storage.state())
        self.storage.replace_state(original)
        self.assertEqual(self.storage.state(), original)

    def test_validation(self):
        for data in [
            {'kind':'income','date':'2026-02-29','name':'Оля','amount':100,'taxRate':4},
            {'kind':'income','date':'2026-10-31','name':'','amount':100,'taxRate':4},
            {'kind':'income','date':'2026-10-31','name':'Оля','amount':100,'taxRate':101},
            {'kind':'expense','date':'2026-10-31','amount':100,'categoryId':'unknown'},
        ]:
            with self.assertRaises(ApiError):
                self.storage.save_entry(data)
        self.assertEqual(self.storage.state()['entries'], [])


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.httpd = start_server('127.0.0.1', 0, Path(self.temp.name)/'db.sqlite3')
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown(); self.httpd.server_close(); self.thread.join()
        self.temp.cleanup()

    def req(self, method, path, body=None):
        c = HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=5)
        headers = {'Content-Type':'application/json'}
        c.request(method, path, None if body is None else json.dumps(body).encode(), headers)
        r = c.getresponse(); raw=r.read(); status=r.status; c.close()
        return status, json.loads(raw) if path.startswith('/api/') else raw

    def test_http_roundtrip(self):
        s, page = self.req('GET', '/'); self.assertEqual(s, 200);self.assertIn(b'Nails CRM', page)
        s, data = self.req('GET', '/api/state');self.assertEqual(s, 200);self.assertEqual(len(data['categories']), 4)
        s, entry = self.req('POST', '/api/entries', {'kind':'income','date':'2026-10-31','name':'Анна','amount':220000,'taxRate':4,'note':''})
        self.assertEqual(s,201)
        s, data = self.req('GET', '/api/state');self.assertEqual(len(data['entries']),1)
        s, data = self.req('POST', '/api/import', data)
        self.assertEqual(s, 200)
        s, data = self.req('DELETE', '/api/entries/'+entry['id']);self.assertEqual(s,200)
        s, data = self.req('GET', '/api/state');self.assertEqual(len(data['entries']),0)


if __name__ == '__main__':
    unittest.main()
