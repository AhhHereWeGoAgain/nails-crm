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

    def test_clients_sources_and_appointment_time(self):
        state = self.storage.state()
        self.assertEqual([s['label'] for s in state['clientSources']],
                         ['Авито (модель)', 'Авито (маникюр)', 'Телеграм', 'Реклама', 'По рекомендации'])
        src = self.storage.add_source({'label':'ВКонтакте'})
        client = self.storage.save_client({'name':'Мария','phone':'+7 (999) 555-44-33',
                                           'sourceId':src['id'],'note':'Френч'})
        appointment = self.storage.save_entry({'kind':'income','date':'2026-11-02','time':'14:30',
                                                'clientId':client['id'],'amount':250000,'taxRate':4,'note':''})
        self.assertEqual(appointment['time'],'14:30')
        self.assertEqual(appointment['name'],'Мария')
        self.assertEqual(appointment['clientId'], client['id'])
        for operation in (lambda:self.storage.delete_client(client['id']),
                          lambda:self.storage.delete_source(src['id'])):
            with self.assertRaises(ApiError) as error:
                operation()
            self.assertEqual(error.exception.status,409)
        edited = self.storage.save_client({'name':'Мария Иванова','phone':'','note':'','sourceId':'referral'}, client['id'])
        self.assertEqual(edited['name'],'Мария Иванова')
        self.assertEqual(self.storage.state()['entries'][0]['name'],'Мария Иванова')
        self.storage.delete_source(src['id'])
        with self.assertRaises(ApiError):
            self.storage.save_entry({'kind':'income','date':'2026-11-02','time':'24:30',
                                     'clientId':client['id'],'amount':1000,'taxRate':4})
        with self.assertRaises(ApiError):
            self.storage.save_entry({'kind':'income','date':'2026-11-02','time':'11:60',
                                     'clientId':client['id'],'amount':1000,'taxRate':4})
        self.storage.delete_entry(appointment['id'])
        self.storage.delete_client(client['id'])

    def test_deal_status_and_finance_migration(self):
        client=self.storage.save_client({'name':'Елена','sourceId':'referral','phone':'','note':''})
        entry=self.storage.save_entry({'kind':'income','date':'2026-11-01','time':'11:30',
                                       'clientId':client['id'],'amount':300000,'taxRate':4,'status':'planned'})
        self.assertEqual(entry['status'],'planned')
        self.assertEqual(entry['time'],'11:30')
        updated=self.storage.set_deal_status(entry['id'],{'status':'completed'})
        self.assertEqual(updated['status'],'completed')
        with self.assertRaises(ApiError):self.storage.set_deal_status(entry['id'],{'status':'won'})
        with self.assertRaises(ApiError):self.storage.save_entry({'kind':'expense','date':'2026-11-01',
                       'amount':100,'categoryId':'rent','status':'paid'})
        data=self.storage.state()
        self.storage.replace_state(data)
        self.assertEqual(self.storage.state(),data)

    def test_backup_roundtrip_with_clients_and_legacy_backup(self):
        client=self.storage.save_client({'name':'Юлия','sourceId':'avito_manicure','phone':'','note':''})
        self.storage.save_entry({'kind':'income','date':'2026-11-03','clientId':client['id'],
                                 'time':'09:15','amount':125000,'taxRate':6,'note':''})
        backup=self.storage.state()
        self.storage.replace_state(backup)
        self.assertEqual(self.storage.state(),backup)
        old={'categories':[{'id':'rent','label':'Аренда'}],
             'entries':[{'id':'old1','kind':'income','date':'2026-10-10',
                         'name':'Вера','amount':40000,'taxRate':4,'note':''},
                        {'id':'old2','kind':'income','date':'2026-10-11',
                         'name':'Вера','amount':40000,'taxRate':4,'note':''}]}
        self.storage.replace_state(old)
        current=self.storage.state()
        self.assertEqual(len(current['clients']),1)
        self.assertEqual(current['entries'][0]['clientId'],current['entries'][1]['clientId'])
        self.assertEqual(current['entries'][0]['time'],None)
        invalid=json.loads(json.dumps(current)); invalid['clients'][0]['sourceId']='not-exist'
        with self.assertRaises(ApiError):
            self.storage.replace_state(invalid)
        self.assertEqual(self.storage.state(),current)

    def test_existing_database_migrates_without_loss(self):
        import sqlite3
        file=Path(self.temp.name)/'legacy.sqlite3'
        with sqlite3.connect(file) as c:
            c.executescript("""
                CREATE TABLE categories(id TEXT PRIMARY KEY,label TEXT NOT NULL COLLATE NOCASE UNIQUE);
                CREATE TABLE entries(id TEXT PRIMARY KEY,entry_date TEXT NOT NULL,
                    kind TEXT NOT NULL,client_name TEXT NOT NULL,amount_kopeks INTEGER NOT NULL,
                    tax_rate REAL NOT NULL,category_id TEXT,note TEXT NOT NULL,
                    created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
                INSERT INTO entries VALUES('old-id','2026-09-13','income','Алиса',235000,4,NULL,'',
                    '2026-09-13T00:00:00Z','2026-09-13T00:00:00Z');
            """)
        migrated=Storage(file)
        entry=migrated.state()['entries'][0]
        self.assertEqual(entry['amount'],235000)
        self.assertIsNotNone(entry['clientId'])
        self.assertEqual(migrated.state()['clients'][0]['name'],'Алиса')
        self.assertEqual(Storage(file).state()['clients'][0]['id'],entry['clientId'])


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

    def test_patch_deal_status_http(self):
        _,client=self.req('POST','/api/clients',{'name':'Ольга','sourceId':'referral','phone':'','note':''})
        _,entry=self.req('POST','/api/entries',{'kind':'income','date':'2026-10-24','time':'18:45',
                      'clientId':client['id'],'amount':95000,'taxRate':4,'status':'planned'})
        self.assertEqual(entry['status'],'planned')
        status,result=self.req('PATCH','/api/entries/'+entry['id']+'/status',{'status':'in_progress'})
        self.assertEqual(status,200)
        self.assertEqual(result['status'],'in_progress')
        status,_=self.req('PATCH','/api/entries/'+entry['id']+'/status',{'status':'invalid'})
        self.assertEqual(status,400)
        status,result=self.req('GET','/api/state')
        self.assertEqual(status,200)
        self.assertEqual(result['entries'][0]['status'],'in_progress')

    def test_clients_http_endpoints(self):
        status,source=self.req('POST','/api/client-sources',{'label':'Сайт'})
        self.assertEqual(status,201)
        status,client=self.req('POST','/api/clients',{'name':'Анна','phone':'','note':'', 'sourceId':source['id']})
        self.assertEqual(status,201)
        status,entry=self.req('POST','/api/entries',{'kind':'income','date':'2026-11-09',
               'time':'17:40','clientId':client['id'],'amount':200000,'taxRate':4})
        self.assertEqual(status,201)
        self.assertEqual(entry['time'],'17:40')
        status,_=self.req('DELETE','/api/clients/'+client['id'])
        self.assertEqual(status,409)
        status,client=self.req('PUT','/api/clients/'+client['id'],{'name':'Анна 2','phone':'','note':'','sourceId':'referral'})
        self.assertEqual(status,200)
        self.assertEqual(client['name'],'Анна 2')
        status,_=self.req('DELETE','/api/client-sources/'+source['id'])
        self.assertEqual(status,200)

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
