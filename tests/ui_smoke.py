"""Browser smoke for all three CRM pages (mock transport; backend tested independently)."""
from pathlib import Path
import struct
import zlib

def tiny_png():
    def chunk(kind, payload):
        return struct.pack('>I',len(payload))+kind+payload+struct.pack('>I',zlib.crc32(kind+payload))
    header=struct.pack('>IIBBBBB',1,1,8,2,0,0,0)
    return b'\x89PNG\\r\\n\x1a\\n'+chunk(b'IHDR',header)+chunk(b'IDAT',zlib.compress(b'\x00\xff\xff\xff'))+chunk(b'IEND',b'')

from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
SCREENSHOTS = Path('/mnt/data') if Path('/mnt/data').exists() else Path('/tmp')
html=(ROOT/'web/index.html').read_text()
styles=(ROOT/'web/styles.css').read_text() + '\n' + (ROOT/'web/design-2026.css').read_text()
icons=(ROOT/'web/icons.js').read_text()
core=(ROOT/'web/core.js').read_text()
app=(ROOT/'web/app.js').read_text()
mock='''
window.confirm=()=>true;
window.mockState={entries:[],categories:[{id:'rent',label:'Аренда'},{id:'materials',label:'Материалы'},{id:'equipment',label:'Оборудование'},{id:'other',label:'Прочее'}],clientSources:[{id:'avito_model',label:'Авито (модель)'},{id:'referral',label:'По рекомендации'}],clients:[]};
window.fetch=async (url, options={})=>{
  const path=String(url),method=options.method||'GET',data=options.body?JSON.parse(options.body):null;
  let result={},status=200;
  if(path==='/api/state') result=window.mockState;
  else if(path==='/api/client-sources'&&method==='POST') {result={id:'source-'+(window.mockState.clientSources.length+1),...data};window.mockState.clientSources.push(result);status=201;}
  else if(path==='/api/clients'&&method==='POST') {result={id:'client-'+(window.mockState.clients.length+1),createdAt:new Date().toISOString(),...data};window.mockState.clients.push(result);status=201;}
  else if(path==='/api/entries'&&method==='POST') {result={id:'deal-'+(window.mockState.entries.length+1),name:window.mockState.clients.find(c=>c.id===data.clientId)?.name||'',createdAt:new Date().toISOString(),...data};window.mockState.entries.push(result);status=201;}
  else if(path.endsWith('/status')&&method==='PATCH'){const id=path.split('/')[3];result=window.mockState.entries.find(x=>x.id===id);result.status=data.status;}
  else if(path.startsWith('/api/entries/')&&method==='PUT') {const id=path.split('/')[3];result=window.mockState.entries.find(x=>x.id===id);Object.assign(result,data);}
  else if(path.startsWith('/api/entries/')&&method==='DELETE') {window.mockState.entries=window.mockState.entries.filter(x=>x.id!==path.split('/')[3]);result={ok:true};}
  else if(path==='/api/categories'&&method==='POST') {result={id:'new-category',...data};window.mockState.categories.push(result);status=201;}
  return {ok:true,status,json:async()=>JSON.parse(JSON.stringify(result))};
};
'''
html=html.replace('<link rel="stylesheet" href="./styles.css" />',f'<style>{styles}</style>')
html=html.replace('<script src="./icons.js"></script>',f'<script>{icons}</script>')
html=html.replace('<script src="./core.js"></script>',f'<script>{core}</script>')
html=html.replace('<script src="./app.js" defer></script>',f'<script>{mock}</script><script>{app}</script>')
with sync_playwright() as p:
    chromium_path = '/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None
    browser=p.chromium.launch(executable_path=chromium_path,headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':900})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.set_content(html)
    page.locator('.sidebar [data-page="clients"]').click()
    page.locator('#add-client').click()
    page.locator('#client-name').fill('Анна Новая')
    page.locator('#client-phone').fill('+7 (999) 123-45-67')
    page.locator('#client-photo-file').set_input_files({
        'name':'avatar.png','mimeType':'image/png','buffer':tiny_png()
    })
    page.locator('#client-photo-preview-wrap').wait_for(state='visible')
    page.locator('#client-source').select_option('other')
    page.locator('#custom-source').fill('ВКонтакте')
    page.locator('#save-client').click()
    page.locator('#client-dialog').wait_for(state='hidden')
    assert page.locator('.client-avatar-photo').count()==1
    assert page.evaluate("window.mockState.clients[0].photo.startsWith('data:image/jpeg;base64,')")
    assert page.get_by_text('ВКонтакте').count()>=1
    page.locator('.sidebar [data-page="calendar"]').click()
    page.locator('.calendar-day:not(.outside)').nth(6).click()
    page.locator('#entry-dialog').wait_for(state='visible')
    page.locator('#entry-client').select_option(label='Анна Новая · +7 (999) 123-45-67')
    page.locator('#entry-time').fill('14:30')
    page.locator('#entry-amount').fill('2500')
    assert page.locator('#entry-status').input_value()=='planned'
    page.locator('#save-entry').click()
    page.locator('#entry-dialog').wait_for(state='hidden')
    assert '0' in page.locator('#metric-income').inner_text()
    page.locator('.sidebar [data-page="deals"]').click()
    page.locator('.stage-column-planned .kanban-card').wait_for()
    assert page.locator('.kanban-card').count()==1
    assert page.locator('.kanban-create').first.evaluate('(el) => getComputedStyle(el).justifyContent')=='flex-start'
    assert '14:30' in page.locator('.kanban-card-meta').first.inner_text()
    page.locator('[data-deal-status]').first.select_option('completed')
    page.locator('.stage-column-completed .kanban-card').wait_for()
    page.locator('.sidebar [data-page="calendar"]').click()
    assert '2' in page.locator('#metric-income').inner_text()
    assert page.locator('#add-on-day').inner_text().strip()=='Добавить'
    assert page.locator('.cell-add').count()==0
    page.locator('.sidebar [data-page="deals"]').click()
    page.screenshot(path=str(SCREENSHOTS/'nails-crm-design-kanban-desktop.png'),full_page=True)
    page.locator('.sidebar [data-page="calendar"]').click()
    page.screenshot(path=str(SCREENSHOTS/'nails-crm-design-calendar-desktop.png'),full_page=True)
    # Optional receipt photo and address in the Other-expense form.
    page.locator('#add-entry').click()
    page.locator('[data-kind="expense"]').click()
    page.locator('#entry-category').select_option('other')
    assert page.locator('#expense-address-wrap').is_visible()
    assert page.locator('#entry-photo-wrap').is_visible()
    page.locator('#entry-address').fill('ул. Ленина, 5')
    page.locator('#entry-amount').fill('350')
    page.locator('#entry-photo-file').set_input_files({
        'name':'receipt.png','mimeType':'image/png','buffer':tiny_png()
    })
    page.locator('#entry-photo-preview-wrap').wait_for(state='visible')
    page.locator('#save-entry').click()
    page.locator('#entry-dialog').wait_for(state='hidden')
    assert page.evaluate("window.mockState.entries.some(e=>e.kind==='expense' && e.address==='ул. Ленина, 5' && e.photo.startsWith('data:image/jpeg;base64,'))")
    page.locator('.sidebar [data-page="deals"]').click()
    assert page.locator('.kanban-photo').count()>=1

    mobile=browser.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
    mobile.on('pageerror',lambda e:errors.append(str(e)))
    mobile.set_content(html)
    mobile.locator('.bottom-nav [data-page="deals"]').click()
    assert mobile.locator('.bottom-nav').is_visible()
    mobile.screenshot(path=str(SCREENSHOTS/'nails-crm-design-kanban-mobile.png'),full_page=True)
    mobile.locator('.bottom-nav [data-page="calendar"]').click()
    mobile.screenshot(path=str(SCREENSHOTS/'nails-crm-design-calendar-mobile.png'),full_page=True)
    mobile.locator('.bottom-nav [data-page="deals"]').click()
    width=mobile.evaluate('document.documentElement.scrollWidth')
    if width>390:
        print('OVERFLOW',mobile.evaluate("() => [...document.querySelectorAll('*')].map(el=>({tag:el.tagName,cl:el.className?.baseVal||el.className,id:el.id,l:el.getBoundingClientRect().left,r:el.getBoundingClientRect().right})).filter(x=>x.r>391||x.l< -1).slice(0,30)"))
    assert width<=390,f'horizontal overflow: {width}'
    # One complete kanban column at phone widths, selectable with visible stage buttons.
    assert mobile.locator('.mobile-stage-tab').count()==4
    assert mobile.locator('.kanban-column:visible').count()==1
    mobile.locator('[data-mobile-stage="completed"]').click()
    assert mobile.locator('.stage-column-completed').is_visible()
    assert mobile.locator('.kanban-column:visible').count()==1
    assert mobile.locator('[data-mobile-stage="completed"]').get_attribute('aria-pressed')=='true'
    mobile.locator('.bottom-nav [data-page="settings"]').click()
    assert mobile.locator('#category-name').evaluate('(e)=>e.getBoundingClientRect().height')<=48
    assert mobile.locator('#source-name').evaluate('(e)=>e.getBoundingClientRect().height')<=48
    mobile.locator('.bottom-nav [data-page="deals"]').click()
    mobile.locator('#add-entry').click()
    assert mobile.locator('#entry-dialog').is_visible()
    assert mobile.locator('#save-entry').is_visible()
    assert mobile.locator('#save-entry').evaluate('(e)=>e.getBoundingClientRect().bottom')<=844
    mobile.locator('#entry-dialog').evaluate('(e)=>e.querySelector(".entry-form").scrollTop=500')
    assert mobile.locator('#save-entry').evaluate('(e)=>e.getBoundingClientRect().bottom')<=844
    mobile.locator('#close-dialog').click()
    for vw in [320,360,430]:
        mobile.set_viewport_size({'width':vw,'height':740})
        for tab in ['calendar','deals','reports','clients','settings']:
            mobile.locator(f'.bottom-nav [data-page="{tab}"]').click()
            assert mobile.evaluate('document.documentElement.scrollWidth')<=vw, f'{tab} overflow at {vw}'
        mobile.locator('.bottom-nav [data-page="deals"]').click()
        assert mobile.locator('.kanban-column:visible').count()==1
    # Calendar heading is visually centered; native date field stays within dialog on phones.
    for vw in [320,360,390,430]:
        mobile.set_viewport_size({'width':vw,'height':844})
        mobile.locator('.bottom-nav [data-page="calendar"]').click()
        geometry=mobile.evaluate("""() => {
          const b=sel=>document.querySelector(sel).getBoundingClientRect();
          const toolbar=b('.calendar-panel .calendar-toolbar');
          const month=b('.calendar-panel .month-switch h2');
          const calendar=b('.calendar-panel .calendar-grid');
          const panel=b('.calendar-panel');
          return {panelLeft:panel.left,panelRight:panel.right,
            calendarLeft:calendar.left,calendarRight:calendar.right,
            toolbarCenter:(toolbar.left+toolbar.right)/2,
            monthCenter:(month.left+month.right)/2};
        }""")
        assert geometry['panelLeft'] >= -1 and geometry['panelRight'] <= vw+1, (vw, geometry)
        assert geometry['calendarLeft'] >= geometry['panelLeft']-1, (vw, geometry)
        assert geometry['calendarRight'] <= geometry['panelRight']+1, (vw, geometry)
        assert abs(geometry['toolbarCenter']-geometry['monthCenter'])<=2, (vw, geometry)
        mobile.locator('#add-entry').click()
        date_geometry=mobile.evaluate("""() => {
          const date=document.querySelector('#entry-date').getBoundingClientRect();
          const time=document.querySelector('#entry-time').getBoundingClientRect();
          const dialog=document.querySelector('#entry-dialog').getBoundingClientRect();
          return {left:date.left,right:date.right,center:(date.left+date.right)/2,
                  timeLeft:time.left,timeRight:time.right,timeCenter:(time.left+time.right)/2,
                  dialogLeft:dialog.left,dialogRight:dialog.right,
                  dialogCenter:(dialog.left+dialog.right)/2};
        }""")
        assert date_geometry['left']>=date_geometry['dialogLeft']+8, (vw,date_geometry)
        assert date_geometry['right']<=date_geometry['dialogRight']-8, (vw,date_geometry)
        assert abs(date_geometry['center']-date_geometry['dialogCenter'])<=2, (vw,date_geometry)
        assert date_geometry['timeLeft']>=date_geometry['dialogLeft']+8, (vw,date_geometry)
        assert date_geometry['timeRight']<=date_geometry['dialogRight']-8, (vw,date_geometry)
        assert abs(date_geometry['timeCenter']-date_geometry['dialogCenter'])<=2, (vw,date_geometry)
        assert abs((date_geometry['right']-date_geometry['left'])-(date_geometry['timeRight']-date_geometry['timeLeft']))<=2, (vw,date_geometry)
        mobile.locator('#close-dialog').click()
        assert mobile.evaluate('document.documentElement.scrollWidth')<=vw, f'calendar overflow at {vw}'
    mobile.set_viewport_size({'width':390,'height':844})
    assert not errors,errors
    browser.close()
print('UI smoke: OK')
