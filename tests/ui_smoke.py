"""Optional UI smoke test with mocked API: python tests/ui_smoke.py (Playwright + Chromium)."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
html = (ROOT/'web/index.html').read_text()
css = (ROOT/'web/styles.css').read_text()
core = (ROOT/'web/core.js').read_text()
app = (ROOT/'web/app.js').read_text()
mock_api = '''
window.confirm = () => true;
window.mockState = {entries:[],categories:[{id:'rent',label:'Аренда'},{id:'materials',label:'Материалы'},{id:'equipment',label:'Оборудование'},{id:'other',label:'Прочее'}]};
window.fetch = async (url,options={}) => {
  let path=String(url), op=options.method || 'GET', response={},status=200;
  if(path === '/api/state') response=window.mockState;
  else if(path === '/api/entries' && op === 'POST') {const e=JSON.parse(options.body);const now=new Date().toISOString();response={...e,id:'generated-'+(window.mockState.entries.length+1),createdAt:now,updatedAt:now};window.mockState.entries.push(response);status=201;}
  else if(path === '/api/categories' && op === 'POST') {const e=JSON.parse(options.body);response={id:'new-cat',label:e.label};window.mockState.categories.push(response);status=201;}
  else if(path.startsWith('/api/entries/') && op === 'DELETE') {window.mockState.entries=window.mockState.entries.filter(e=>e.id!==path.split('/').pop());response={ok:true};}
  return {ok:true,status,json:async()=>JSON.parse(JSON.stringify(response))};
};
'''
html=html.replace('<link rel="stylesheet" href="./styles.css" />',f'<style>{css}</style>')
html=html.replace('<script src="./core.js"></script>',f'<script>{core}</script>')
html=html.replace('<script src="./app.js" defer></script>',f'<script>{mock_api}</script><script>{app}</script>')
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':900})
    errors=[]
    page.on('pageerror',lambda exc: errors.append(str(exc)))
    page.set_content(html)
    page.get_by_role('button',name='Новая операция').click()
    page.locator('#entry-name').fill('Анна')
    page.locator('#entry-amount').fill('2000')
    page.get_by_role('button',name='Сохранить').click()
    assert '2' in page.locator('#metric-income').inner_text()
    assert '80' in page.locator('#metric-tax').inner_text()
    page.screenshot(path='/mnt/data/nails-crm-desktop-preview.png',full_page=True)
    page.get_by_role('button',name='Новая операция').click()
    page.locator('[data-kind=expense]').click()
    page.locator('#entry-category').select_option('rent')
    page.locator('#entry-amount').fill('700')
    page.get_by_role('button',name='Сохранить').click()
    assert '1' in page.locator('#metric-profit').inner_text()
    page.get_by_role('button',name='Новая операция').click()
    page.locator('[data-kind=expense]').click()
    page.locator('#entry-category').select_option('rent')
    assert page.locator('#rent-preset').is_visible()
    page.get_by_role('button',name='Использовать').click()
    assert page.locator('#entry-amount').input_value()=='700.00'
    page.get_by_role('button',name='Отмена').click()
    page.locator('[data-page=reports]').first.click()
    assert page.locator('#year-income').is_visible()
    page.locator('[data-page=settings]').first.click()
    page.locator('#category-name').fill('Реклама')
    page.get_by_role('button',name='Добавить',exact=True).click()
    assert page.get_by_text('Реклама').count()>0
    mobile=browser.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
    mobile.set_content(html)
    assert mobile.locator('.bottom-nav').is_visible()
    mobile.screenshot(path='/mnt/data/nails-crm-mobile-preview.png',full_page=True)
    assert mobile.evaluate('document.documentElement.scrollWidth <= window.innerWidth+1'),(mobile.evaluate('document.documentElement.scrollWidth'), mobile.evaluate('window.innerWidth'))
    assert not errors,errors
    browser.close()
    print('UI smoke: OK')
