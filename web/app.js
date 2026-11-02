/* Nails CRM client. Server mode: SQLite JSON API. Standalone/Android: localStorage. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const C = window.NailsCore;
  const icon = window.NailsIcons.icon;
  const DEAL_STAGES = [
    {id:'planned',title:'Запланировано',icon:'calendar-days'},
    {id:'in_progress',title:'В работе',icon:'clock-3'},
    {id:'completed',title:'Завершено',icon:'circle-check'},
    {id:'cancelled',title:'Отменено',icon:'circle-x'}
  ];
  const standalone = location.protocol === 'file:' || location.hostname === 'appassets.androidplatform.net' || new URLSearchParams(location.search).has('standalone');
  const KEY = 'nails-crm-local-v1';
  const MONTHS = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
  const DEFAULT_SOURCES = [{id:'avito_model',label:'Авито (модель)'},{id:'avito_manicure',label:'Авито (маникюр)'},{id:'telegram',label:'Телеграм'},{id:'ads',label:'Реклама'},{id:'referral',label:'По рекомендации'}];
  const expandedCompleted = new Set();
  const DEFAULT_CATEGORIES = [{id:'rent', label:'Аренда'}, {id:'materials', label:'Материалы'}, {id:'equipment', label:'Оборудование'}, {id:'other', label:'Прочее'}];
  const current = new Date();
  let viewYear = current.getFullYear();
  let viewMonth = current.getMonth();
  let selectedDate = localDate(current);
  let selectedPage = 'calendar';
  let operationKind = 'income';
  let editing = null;
  let state = {entries:[], categories:[], clients:[], clientSources:[]};
  let editingClient = null;
  let quickClient = false;
  let pendingEntryPhoto=null, pendingClientPhoto=null, photoLoading=false;
  const photoValid = v => v==null || (typeof v==='string' && v.length<=400000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v));
  const imageMarkup = (v,cls,alt) => v ? `<img class="${cls}" src="${safe(v)}" alt="${safe(alt)}" loading="lazy">` : '';
  function showPhoto(kind,value) {
    const wrap=$(kind+'-photo-preview-wrap'), preview=$(kind+'-photo-preview');
    wrap.hidden=!value;
    if(value)preview.src=value;else preview.removeAttribute('src');
  }
  async function compressPhoto(file) {
    if(!file || !file.type.startsWith('image/'))throw Error('Выберите фотографию');
    if(file.size>15*1024*1024)throw Error('Фото больше 15 МБ');
    const url=URL.createObjectURL(file);
    try {
      const img=await new Promise((ok,fail)=>{
        const element=new Image();
        element.onload=()=>ok(element);
        element.onerror=()=>fail(Error('Не удалось открыть изображение'));
        element.src=url;
      });
      for(const limit of [900,700,540,420]) {
        const scale=Math.min(1,limit/Math.max(img.naturalWidth,img.naturalHeight));
        const canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));
        canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
        const context=canvas.getContext('2d');
        if(!context)throw Error('Не удалось обработать фотографию');
        context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
        context.drawImage(img,0,0,canvas.width,canvas.height);
        for(const quality of [0.78,0.64,0.5]){
          const photo=canvas.toDataURL('image/jpeg',quality);
          if(photoValid(photo))return photo;
        }
      }
      throw Error('Не удалось сжать фото до 300 КБ');
    } finally {URL.revokeObjectURL(url);}
  }
  async function handlePhotoChange(kind,file) {
    if(!file)return;
    photoLoading=true;
    try {
      const photo=await compressPhoto(file);
      if(kind==='entry')pendingEntryPhoto=photo;else pendingClientPhoto=photo;
      showPhoto(kind,photo);
    }catch(e){toast(e.message);}
    finally{$(kind+'-photo-file').value='';photoLoading=false;}
  }
  let reportYear = viewYear;
  let saving = false;
  let dealFilter = 'all';
  let mobileDealStage = 'planned';
  let toastTimer;

  function localDate(dt) {
    return [dt.getFullYear(), String(dt.getMonth()+1).padStart(2,'0'), String(dt.getDate()).padStart(2,'0')].join('-');
  }
  function dateFromKey(key) { const [y,m,d] = key.split('-').map(Number); return new Date(y,m-1,d); }
  function longDate(key) { return dateFromKey(key).toLocaleDateString('ru-RU', {day:'numeric', month:'long', year:'numeric'}); }
  function safe(s) {return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function category(id) {return state.categories.find(c => c.id === id)?.label || 'Удалённая статья';}
  function money(v) {return C.money(v);}
  function toast(message) {
    const el = $('message'); el.textContent = message; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => {el.hidden = true;}, 4200);
  }
  function initialState() {return {categories:structuredClone(DEFAULT_CATEGORIES), clientSources:structuredClone(DEFAULT_SOURCES),clients:[], entries:[]};}
  async function storageDB(operation,value) {
    if(!window.indexedDB)throw Error('IndexedDB недоступна');
    const db=await new Promise((resolve,reject)=>{
      const request=indexedDB.open('nails-crm-offline',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('state');
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error||Error('Ошибка открытия хранилища'));
    });
    try {
      return await new Promise((resolve,reject)=>{
        const tx=db.transaction('state',operation==='get'?'readonly':'readwrite');
        const request=operation==='get'?tx.objectStore('state').get(KEY):tx.objectStore('state').put(value,KEY);
        request.onsuccess=()=>{if(operation==='get')resolve(request.result);};
        tx.oncomplete=()=>{if(operation!=='get')resolve();};
        request.onerror=()=>reject(request.error||Error('Ошибка чтения данных'));
        tx.onerror=()=>reject(tx.error||Error('Ошибка сохранения данных'));
      });
    } finally {db.close();}
  }
  async function readLocalState() {
    try {
      const saved=await storageDB('get');
      if(saved)return saved;
      const legacy=JSON.parse(localStorage.getItem(KEY)||'null');
      if(legacy){await storageDB('put',legacy);return legacy;}
      return initialState();
    }catch(e){
      console.warn('IndexedDB unavailable; falling back to localStorage',e);
      return JSON.parse(localStorage.getItem(KEY)||'null')||initialState();
    }
  }
  async function persistLocal() {
    try {
      await storageDB('put',state);
    }catch(e){
      console.warn('IndexedDB write failed',e);
      try{localStorage.setItem(KEY,JSON.stringify(state));}
      catch(_){throw Error('Недостаточно памяти для фото. Скачайте резервную копию и освободите место.');}
    }
  }
  function validateBackup(data) {
    if (!data || !Array.isArray(data.entries) || !Array.isArray(data.categories) || data.entries.length > 100000 || data.categories.length > 5000) throw Error('Неверный формат резервной копии');
    const result = structuredClone(data);
    result.clientSources ??= structuredClone(DEFAULT_SOURCES);
    result.clients ??= [];
    if (!Array.isArray(result.clientSources) || !Array.isArray(result.clients) || result.clients.length > 100000 || result.clientSources.length > 5000) throw Error('Неверная база клиентов');
    function validateDictionary(items, maxLength) {
      const ids = new Set(), labels = new Set();
      for (const item of items) {
        if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > maxLength || ids.has(item.id) || labels.has(item.label.trim().toLowerCase())) throw Error('Повторяющийся или неверный вариант справочника');
        ids.add(item.id);labels.add(item.label.trim().toLowerCase());
      }
      return ids;
    }
    const categoryIds = validateDictionary(result.categories,50);
    const sourceIds = validateDictionary(result.clientSources,70);
    const clientIds = new Set();
    const byName = new Map();
    for (const client of result.clients) {
      if (!client || typeof client.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(client.id) || clientIds.has(client.id) || typeof client.name !== 'string' || !client.name.trim() || client.name.length > 240 || (client.sourceId && !sourceIds.has(client.sourceId))) throw Error('Неверная карточка клиента');
      if (typeof (client.phone ?? '') !== 'string' || typeof (client.note ?? '') !== 'string' || !photoValid(client.photo)) throw Error('Неверные данные клиента');
      client.photo ||= null;
      clientIds.add(client.id);
      byName.set(client.name.trim().toLowerCase(), client.id);
    }
    const entryIds = new Set();
    for (const e of result.entries) {
      if (!e || typeof e.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(e.id) || entryIds.has(e.id) || !/^\d{4}-\d{2}-\d{2}$/.test(e.date || '') || !Number.isInteger(e.amount) || e.amount < 1 || !['income','expense'].includes(e.kind)) throw Error('Некорректные сделки');
      e.status ??= 'completed';
      if (!DEAL_STAGES.some(st => st.id === e.status)) throw Error('Некорректная стадия сделки');
      if (e.kind === 'income') {
        if (!Number.isFinite(e.taxRate) || e.taxRate < 0 || e.taxRate > 100 || (e.time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(e.time))) throw Error('Некорректное время или налог');
        if (e.clientId && !clientIds.has(e.clientId)) throw Error('Операция с отсутствующим клиентом');
        if (!e.clientId) {
          if (!String(e.name || '').trim()) throw Error('Операция без клиента');
          const key=e.name.trim().toLowerCase(); let id=byName.get(key);
          if(!id){id=crypto.randomUUID();result.clients.push({id,name:e.name.trim(),phone:'',note:'',sourceId:null,photo:null,createdAt:e.createdAt||new Date().toISOString(),updatedAt:e.updatedAt||new Date().toISOString()});clientIds.add(id);byName.set(key,id);}
          e.clientId=id;
        }
        e.name=result.clients.find(c=>c.id===e.clientId).name;
        e.time ||= null;
      } else if (!categoryIds.has(e.categoryId)) throw Error('Операция с отсутствующей статьёй расходов');
      else {e.clientId=null;e.time=null;}
      if (e.purchaseSource != null && (typeof e.purchaseSource !== 'string' || e.purchaseSource.length > 100 || e.kind !== 'expense' || !['materials','equipment'].includes(e.categoryId))) throw Error('Некорректное место покупки');
      e.purchaseSource ||= null;
      if(!photoValid(e.photo) || (e.kind==='expense' && !['materials','equipment','other'].includes(e.categoryId) && e.photo))throw Error('Некорректное фото');
      e.photo ||= null;
      if(typeof (e.address??'')!=='string' || (e.address||'').length>240 || (e.address&&(e.kind!=='expense'||e.categoryId!=='other')))throw Error('Некорректный адрес');
      e.address ||= '';
      entryIds.add(e.id);
    }
    return {categories:result.categories, entries:result.entries, clients:result.clients, clientSources:result.clientSources};
  }
  async function refresh() {
    if (standalone) {
      try {state = validateBackup(await readLocalState());}
      catch (e) { console.warn('Storage reset blocked:', e); state = initialState(); toast('Не удалось прочитать локальные данные. Проверьте резервную копию.'); }
    } else {
      const r = await fetch('/api/state', {cache:'no-store'});
      if (!r.ok) throw Error('Нет подключения к локальному серверу');
      state = await r.json();
    }
    render();
  }
  async function mutate(method, path, body) {
    if (!standalone) {
      const response = await fetch(path, {method, headers: body ? {'Content-Type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
      const payload = await response.json();
      if (!response.ok) throw Error(payload.error || 'Ошибка сохранения');
      await refresh();
      return payload;
    }
    let result = {ok:true};
    if (path === '/api/entries' && method === 'POST') {
      const ts = new Date().toISOString();
      if(body.kind==='income') {
        const client=state.clients.find(c=>c.id===body.clientId);
        if(!client)throw Error('Выберите клиента');
        body.name=client.name;
      }
      result={...body, id:crypto.randomUUID(), createdAt:ts, updatedAt:ts};
      state.entries.push(result);
    } else if (path.startsWith('/api/entries/') && method === 'PUT') {
      const i = state.entries.findIndex(e => e.id === path.split('/').pop());
      if (i < 0) throw Error('Операция не найдена');
      const client=body.kind==='income' ? state.clients.find(c=>c.id===body.clientId) : null;
      if(body.kind==='income'&&!client)throw Error('Выберите клиента');
      result={...state.entries[i],...body,name:client?.name||'',updatedAt:new Date().toISOString()};
      state.entries[i] = result;
    } else if (/^\/api\/entries\/[^/]+\/status$/.test(path) && method === 'PATCH') {
      if(!DEAL_STAGES.some(st=>st.id===body.status))throw Error('Неизвестная стадия сделки');
      const item=state.entries.find(e=>e.id===path.split('/')[3]);
      if(!item)throw Error('Сделка не найдена');
      item.status=body.status;item.updatedAt=new Date().toISOString();result=item;
    } else if (path.startsWith('/api/entries/') && method === 'DELETE') {
      state.entries = state.entries.filter(e => e.id !== path.split('/').pop());
    } else if (path === '/api/clients' && method === 'POST') {
      if(!body.name.trim())throw Error('Введите имя клиента');
      if(body.sourceId&&!state.clientSources.some(x=>x.id===body.sourceId))throw Error('Источник не найден');
      result={...body,id:crypto.randomUUID(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      state.clients.push(result);
    } else if (path.startsWith('/api/clients/') && method === 'PUT') {
      const i=state.clients.findIndex(c=>c.id===path.split('/').pop());
      if(i<0)throw Error('Клиент не найден');
      if(body.sourceId&&!state.clientSources.some(x=>x.id===body.sourceId))throw Error('Источник не найден');
      result={...state.clients[i],...body,updatedAt:new Date().toISOString()};
      state.clients[i]=result;
      state.entries.filter(e=>e.clientId===result.id).forEach(e=>{e.name=result.name;});
    } else if (path.startsWith('/api/clients/') && method === 'DELETE') {
      const id=path.split('/').pop();
      if(state.entries.some(e=>e.clientId===id))throw Error('У клиента есть посещения. Сначала удалите операции.');
      state.clients=state.clients.filter(c=>c.id!==id);
    } else if (path === '/api/client-sources' && method === 'POST') {
      const label=body.label.trim();
      if(!label || state.clientSources.some(c=>c.label.toLowerCase()===label.toLowerCase()))throw Error('Такой источник уже существует');
      result={id:crypto.randomUUID(),label};state.clientSources.push(result);
    } else if (path.startsWith('/api/client-sources/') && method === 'DELETE') {
      const id=path.split('/').pop();
      if(state.clients.some(c=>c.sourceId===id))throw Error('Источник используется у клиентов');
      state.clientSources=state.clientSources.filter(c=>c.id!==id);
    } else if (path === '/api/categories' && method === 'POST') {
      const label = body.label.trim();
      if (!label || state.categories.some(c => c.label.toLowerCase() === label.toLowerCase())) throw Error('Такая категория уже существует');
      result={id:crypto.randomUUID(), label};state.categories.push(result);
    } else if (path.startsWith('/api/categories/') && method === 'DELETE') {
      const id = path.split('/').pop();
      if (state.entries.some(e => e.categoryId === id)) throw Error('Категория используется в операциях. Сначала измените записи.');
      state.categories = state.categories.filter(c => c.id !== id);
    } else throw Error('Неизвестная команда');
    await persistLocal(); render();
    return result;
  }
  function render() {
    renderCalendar(); renderDeals(); renderReports(); renderSettings(); renderClients();
    window.NailsIcons.hydrate(document);
    $('connection-label').textContent = standalone ? 'Автономное хранение' : 'Локальная база SQLite';
  }
  function renderCalendar() {
    $('month-label').textContent = `${MONTHS[viewMonth].charAt(0).toUpperCase()}${MONTHS[viewMonth].slice(1)} ${viewYear}`;
    const data = C.monthEntries(state.entries, viewYear, viewMonth);
    const t = C.totals(data);
    for (const [key,val] of Object.entries({'metric-income':t.income,'metric-expenses':t.expenses,'metric-tax':t.tax,'metric-profit':t.profit})) $(key).textContent = money(val);
    const firstDay = new Date(viewYear, viewMonth, 1);
    const weekOffset = (firstDay.getDay() + 6) % 7;
    const count = Math.ceil((weekOffset + new Date(viewYear,viewMonth+1,0).getDate()) / 7) * 7;
    const buckets = new Map();
    for (const entry of state.entries) {
      if (!buckets.has(entry.date)) buckets.set(entry.date, []);
      buckets.get(entry.date).push(entry);
    }
    const todayKey = localDate(new Date());
    const cells = [];
    for (let n=0; n<count; n++) {
      const dt = new Date(viewYear,viewMonth,n - weekOffset + 1);
      const key = localDate(dt);
      const outside = dt.getMonth() !== viewMonth;
      const entries = buckets.get(key) || [];
      const daily = C.totals(entries);
      const display = v => '<span class="' + (v > 0 ? 'income' : 'expense') + '">' + (v > 0 ? '+' : '−') + money(Math.abs(v)) + '</span>';
      cells.push(`<button type="button" role="gridcell" data-date="${key}" aria-label="${safe(longDate(key))}, сделок: ${entries.length}. Открыть создание сделки" aria-selected="${key===selectedDate}" class="calendar-day${outside?' outside':''}${key===selectedDate?' selected':''}${key===todayKey?' today':''}"><span class="day-number">${dt.getDate()}</span><span class="day-values">${daily.income ? display(daily.income) : ''}${daily.expenses ? display(-daily.expenses):''}</span>${entries.length?`<span class="day-count">${entries.length} ${plural(entries.length,'сделка','сделки','сделок')}</span>`:''}</button>`);
    }
    $('calendar-grid').innerHTML = cells.join('');
    $('selected-day-heading').textContent = longDate(selectedDate);
    const selected = (buckets.get(selectedDate) || []).slice().sort((a,b) => (a.time||'99:99').localeCompare(b.time||'99:99') || b.createdAt.localeCompare(a.createdAt));
    const dayTotal = C.totals(selected);
    $('day-subtitle').textContent = `${selected.length} ${plural(selected.length, 'сделка', 'сделки', 'сделок')}`;
    $('day-totals').innerHTML = `<div><span>Поступления</span><strong>${money(dayTotal.income)}</strong></div><div><span>Расходы + налог</span><strong>${money(dayTotal.expenses+dayTotal.tax)}</strong></div>`;
    $('day-list').innerHTML = selected.length ? selected.map(entry => {
      const income = entry.kind === 'income';
      const label = income ? entry.name : category(entry.categoryId);
      const stage = DEAL_STAGES.find(x=>x.id===(entry.status||'completed')) || DEAL_STAGES[2];
      const sub = income ? `${entry.time ? `<b class="appointment-time">${safe(entry.time)}</b> · ` : ''}Налог ${entry.taxRate}%${entry.note ? ' · ' + safe(entry.note) : ''}` : `${entry.purchaseSource ? 'Магазин: '+safe(entry.purchaseSource) : 'Расход'}${entry.note ? ' · '+safe(entry.note) : ''}`;
      return `<article class="entry-card"><span class="entry-icon ${income?'':'out'}">${icon(income?'user-round':'wallet')}</span><div class="entry-desc"><strong>${safe(label)}</strong><small><span class="status-pill stage-${safe(stage.id)}">${safe(stage.title)}</span> ${sub}</small></div><div class="entry-amount ${income?'in':'out'}">${income?'+':'−'}${money(entry.amount)}</div><div class="entry-actions"><button data-edit="${safe(entry.id)}" type="button" aria-label="Редактировать">${icon('pencil',16)}</button><button data-remove="${safe(entry.id)}" type="button" aria-label="Удалить">${icon('trash-2',16)}</button></div></article>`;
    }).join('') : '<div class="empty"><span class="empty-symbol">'+icon('calendar-days',34)+'</span>На эту дату сделок нет.<br>Нажмите «+», чтобы добавить первую.</div>';
  }
  function renderDeals() {
    const query = $('deal-search').value.toLocaleLowerCase('ru').trim();
    const filtered = state.entries.filter(e =>
      (dealFilter==='all' || e.kind===dealFilter) &&
      `${e.name||''} ${category(e.categoryId)} ${e.note||''}`.toLocaleLowerCase('ru').includes(query));
    const booked = filtered.filter(e=>(e.status||'completed')!=='cancelled');
    const pending = booked.filter(e=>(e.status||'completed')!=='completed');
    $('deals-summary').innerHTML = `<div>${icon('list-checks')} <strong>${filtered.length}</strong> сделок на доске</div><div>${icon('clock-3')} <strong>${pending.length}</strong> ожидают завершения</div><div>${icon('circle-check')} <strong>${booked.length-pending.length}</strong> завершено</div>`;
    const mobileTabs = $('mobile-stage-tabs');
    mobileTabs.innerHTML = DEAL_STAGES.map(stage => {
      const n = filtered.filter(e=>(e.status||'completed')===stage.id).length;
      return `<button type="button" class="mobile-stage-tab ${stage.id===mobileDealStage?'active':''}" aria-pressed="${stage.id===mobileDealStage}" aria-label="${safe(stage.title)}: ${n} сделок" data-mobile-stage="${stage.id}"><span>${icon(stage.icon,16)}${safe(stage.id==='planned'?'Планы':stage.title)}</span><b>${n}</b></button>`;
    }).join('');
    $('kanban-board').innerHTML = DEAL_STAGES.map(stage => {
      const list=filtered.filter(e=>(e.status||'completed')===stage.id).sort((a,b)=>a.date.localeCompare(b.date)||(a.time||'99:99').localeCompare(b.time||'99:99'));
      const total=list.reduce((n,e)=>n+e.amount,0);
      return `<section class="kanban-column stage-column-${stage.id} ${stage.id===mobileDealStage?'mobile-current':''}" data-stage="${stage.id}" aria-label="${safe(stage.title)}">
        <header class="kanban-column-head"><div class="kanban-title">${icon(stage.icon,18)}<strong>${safe(stage.title)}</strong><span class="kanban-count">${list.length}</span></div><div class="kanban-total">${money(total)}</div></header>
        <div class="kanban-cards">${list.length?list.map(e=>{
          const income=e.kind==='income';
          const done = stage.id==='completed';
          const compact = done && !expandedCompleted.has(e.id);
          const displayName = income ? e.name : e.categoryId==='rent' ? 'Аренда' : ['materials','equipment'].includes(e.categoryId) ? (e.note || category(e.categoryId)) : category(e.categoryId);
          return `<article class="kanban-card ${compact?'completed-compact':''}" draggable="${!compact}" data-deal-id="${safe(e.id)}">
            <div class="kanban-card-top" ${compact?'hidden':''}><span class="kanban-kind ${income?'kind-income':'kind-expense'}">${icon(income?'user-round':'wallet',14)} ${income?'Клиент':'Расход'}</span><span class="drag-grip" title="Перетащите на другую стадию">${icon('grip-vertical',17)}</span></div>
            <div class="kanban-compact-line"><strong class="kanban-card-title">${safe(displayName)}</strong>${done?`<button type="button" class="completed-toggle" data-toggle-completed="${safe(e.id)}" aria-expanded="${!compact}" aria-label="${compact?'Развернуть':'Свернуть'} завершённую сделку">${icon(compact?'chevron-down':'chevron-up',16)}</button>`:''}</div>
            <div class="kanban-card-meta" ${compact?'hidden':''}>${icon('calendar-days',14)} ${safe(longDate(e.date))}${e.time?' · '+safe(e.time):''}</div>
            ${!compact && e.purchaseSource ? `<p class="kanban-note">Магазин: ${safe(e.purchaseSource)}</p>` : ''}
            ${!compact && e.note?`<p class="kanban-note">${safe(e.note)}</p>`:''}
            ${!compact && e.address?`<p class="kanban-note">Адрес: ${safe(e.address)}</p>`:''}
            ${!compact && e.photo?imageMarkup(e.photo,'kanban-photo','Фото сделки'):''}
            <div class="kanban-card-footer"><strong class="kanban-price">${money(e.amount)}</strong><button ${compact?'hidden':''} type="button" data-kanban-edit="${safe(e.id)}" aria-label="Редактировать сделку">${icon('pencil',16)}</button></div>
            <label class="kanban-status-label" ${compact?'hidden':''}>Стадия <select data-deal-status="${safe(e.id)}" aria-label="Стадия сделки ${safe(income?e.name:category(e.categoryId))}">${DEAL_STAGES.map(opt=>`<option value="${opt.id}" ${opt.id===stage.id?'selected':''}>${safe(opt.title)}</option>`).join('')}</select></label>
          </article>`;}).join(''):'<p class="kanban-empty">Здесь пока нет сделок</p>'}</div>
        <button class="kanban-create" type="button" data-create-stage="${stage.id}">${icon('plus',16)} <span>Добавить сделку</span></button>
      </section>`;
    }).join('');
  }
  function plural(n,one,two,five){ const a=n%10,b=n%100;return b>10&&b<15?five:a===1?one:a>1&&a<5?two:five; }
  function renderReports() {
    const years = new Set([viewYear, new Date().getFullYear(), reportYear]);
    state.entries.forEach(e => years.add(Number(e.date.slice(0,4))));
    const opts = [...years].sort((a,b)=>b-a);
    $('report-year').innerHTML = opts.map(y=>`<option value="${y}" ${y===reportYear?'selected':''}>${y}</option>`).join('');
    const entries = state.entries.filter(e=>e.date.startsWith(String(reportYear)+'-'));
    const t = C.totals(entries);
    for(const [id,value] of Object.entries({'year-income':t.income,'year-expenses':t.expenses,'year-tax':t.tax,'year-profit':t.profit})) $(id).textContent = money(value);
    const monthly = MONTHS.map((m,i)=>({label:m.slice(0,3),t:C.totals(C.monthEntries(entries,reportYear,i))}));
    const biggest = Math.max(1,...monthly.map(v=>Math.abs(v.t.profit)));
    $('monthly-bars').innerHTML = monthly.map(o=>`<div class="bar-row"><span>${safe(o.label)}</span><div class="bar-track"><span class="bar-fill" style="width:${Math.max(0,Math.round(Math.abs(o.t.profit)/biggest*100))}%;background:${o.t.profit < 0 ? '#d6ad7a' : '#bc7894'}"></span></div><strong>${money(o.t.profit)}</strong></div>`).join('');
    const sums = new Map();
    entries.filter(e=>e.kind==='expense').forEach(e=>sums.set(e.categoryId,(sums.get(e.categoryId)||0)+e.amount));
    const sorted = [...sums].sort((a,b)=>b[1]-a[1]);
    $('expense-breakdown').innerHTML = sorted.length ? sorted.map(([id,value])=>`<div class="breakdown-row"><div class="breakdown-label"><span>${safe(category(id))}</span><strong>${money(value)}</strong></div><div class="bar-track"><div class="bar-fill" style="width:${t.expenses?Math.round(value/t.expenses*100):0}%;background:#c69aa9"></div></div></div>`).join('') : '<div class="empty">Расходы за выбранный год отсутствуют</div>';
  }
  function renderSettings() {
    $('category-list').innerHTML = state.categories.map(c => {
      const uses = state.entries.filter(e=>e.categoryId===c.id).length;
      return `<div class="category-item"><span>${safe(c.label)} <small>${uses} записей</small></span><button type="button" data-delete-category="${safe(c.id)}" ${uses?'disabled title="Категория используется"':''}>Удалить</button></div>`;
    }).join('') || '<div class="empty">Пока нет статей расходов</div>';
    const currentCategory=$('entry-category').value;
    $('entry-category').innerHTML = state.categories.map(c=>`<option value="${safe(c.id)}">${safe(c.label)}</option>`).join('');
    if(state.categories.some(c=>c.id===currentCategory))$('entry-category').value=currentCategory;
    const currentClient=$('entry-client').value;
    $('entry-client').innerHTML = `<option value="">Выберите клиента</option>`+state.clients.map(c=>`<option value="${safe(c.id)}">${safe(c.name)}${c.phone ? ' · '+safe(c.phone) : ''}</option>`).join('');
    if(state.clients.some(c=>c.id===currentClient))$('entry-client').value=currentClient;
    const currentSource=$('client-source').value;
    $('client-source').innerHTML=`<option value="">Не указан</option>`+state.clientSources.map(c=>`<option value="${safe(c.id)}">${safe(c.label)}</option>`).join('')+`<option value="other">Другое — добавить новый</option>`;
    if(currentSource==='other'||state.clientSources.some(c=>c.id===currentSource))$('client-source').value=currentSource;
    $('source-list').innerHTML=state.clientSources.map(c=>{
      const uses=state.clients.filter(x=>x.sourceId===c.id).length;
      return `<div class="category-item"><span>${safe(c.label)} <small>${uses} клиентов</small></span><button type="button" data-delete-source="${safe(c.id)}" ${uses?'disabled title="Источник используется"':''}>Удалить</button></div>`;
    }).join('');
  }
  function clientSource(id) {return state.clientSources.find(s=>s.id===id)?.label||'Не указан';}
  function renderClients(){
    const query=$('client-search').value.toLocaleLowerCase('ru').trim();
    const clients=state.clients.filter(c=>`${c.name} ${c.phone}`.toLocaleLowerCase('ru').includes(query));
    $('clients-count').textContent=`Найдено: ${clients.length} · Всего клиентов: ${state.clients.length}`;
    $('clients-list').innerHTML=clients.length?clients.map(c=>{
      const visits=state.entries.filter(e=>e.clientId===c.id&&e.kind==='income');
      const spent=visits.reduce((n,e)=>n+e.amount,0);
      return `<article class="client-card"><div class="client-avatar">${c.photo ? imageMarkup(c.photo,'client-avatar-photo','Фото клиента') : safe(c.name.slice(0,1).toUpperCase())}</div><div class="client-info"><strong>${safe(c.name)}</strong><small>${safe(clientSource(c.sourceId))}${c.phone?' · '+safe(c.phone):''}</small>${c.note?`<small>${safe(c.note)}</small>`:''}<small>${visits.length} посещений · ${money(spent)}</small></div><div class="client-actions"><button type="button" class="btn btn-outline" data-client-history="${safe(c.id)}">История</button><button type="button" class="icon-btn" aria-label="Редактировать клиента" data-client-edit="${safe(c.id)}">${icon('pencil',16)}</button><button type="button" class="icon-btn" aria-label="Удалить клиента" data-client-remove="${safe(c.id)}" ${visits.length?'disabled title="Есть посещения"':''}>${icon('trash-2',16)}</button></div></article>`;
    }).join(''):'<div class="empty">Клиенты не найдены. Добавьте первого клиента.</div>';
  }
  function openClient(client=null,fromEntry=false){
    editingClient=client?.id||null;quickClient=fromEntry;
    $('client-dialog-title').textContent=editingClient?'Редактировать клиента':'Новый клиент';
    $('client-form').reset();
    $('client-name').value=client?.name||'';
    $('client-phone').value=client?.phone||'';
    $('client-note').value=client?.note||'';
    $('client-source').value=client?.sourceId||'';
    pendingClientPhoto=client?.photo||null;
    showPhoto('client',pendingClientPhoto);
    updateCustomSource();
    $('client-dialog').showModal();
    $('client-name').focus();
  }
  function updateCustomSource(){
    const custom=$('client-source').value==='other';
    $('custom-source-wrap').hidden=!custom;
    $('custom-source').required=custom;
  }
  async function handleClientSave(event){
    event.preventDefault();
    const button=$('save-client');button.disabled=true;
    try {
      let sourceId=$('client-source').value||null;
      if(sourceId==='other'){
        const name=$('custom-source').value.trim();
        if(!name)throw Error('Введите источник');
        const existing=state.clientSources.find(s=>s.label.toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru'));
        sourceId=existing?.id||(await mutate('POST','/api/client-sources',{label:name})).id;
      }
      if(photoLoading)throw Error('Фото ещё обрабатывается');
      const payload={name:$('client-name').value.trim(),phone:$('client-phone').value.trim(),note:$('client-note').value.trim(),sourceId,photo:pendingClientPhoto};
      const result=await mutate(editingClient?'PUT':'POST',editingClient?`/api/clients/${editingClient}`:'/api/clients',payload);
      $('client-dialog').close();
      if(quickClient && $('entry-dialog').open){$('entry-client').value=result.id;}
      toast(editingClient?'Клиент обновлён':'Клиент добавлен');
      editingClient=null;quickClient=false;
    }catch(err){toast(err.message);}finally{button.disabled=false;}
  }
  function openHistory(client){
    const entries=state.entries.filter(e=>e.kind==='income'&&e.clientId===client.id).sort((a,b)=>b.date.localeCompare(a.date)||(b.time||'').localeCompare(a.time||''));
    $('history-title').textContent=`${client.name} — посещения`;
    $('client-history').innerHTML=entries.length?`<p class="muted">Всего ${entries.length}, выручка ${money(entries.reduce((n,e)=>n+e.amount,0))}</p>`+entries.map(e=>`<div class="history-row"><div><strong>${safe(longDate(e.date))}${e.time?' · '+safe(e.time):''}</strong><small>${safe(e.note||'Посещение')} · налог ${e.taxRate}%</small></div><strong>${money(e.amount)}</strong></div>`).join(''):'<p class="muted">Посещений пока нет</p>';
    $('history-dialog').showModal();
  }
  function navigate(page) {
    selectedPage = page;
    document.documentElement.dataset.activePage = page;
    document.querySelectorAll('.page').forEach(el => el.hidden = el.id !== `${page}-page`);
    document.querySelectorAll('[data-page]').forEach(el => el.classList.toggle('active',el.dataset.page===page));
    const title={calendar:'Календарь',deals:'Сделки',reports:'Финансы',clients:'Клиенты',settings:'Настройки'}[page];
    $('page-title').textContent=title;
    $('breadcrumb').textContent=title.toLocaleUpperCase('ru');
  }
  function setKind(kind) {
    operationKind = kind;
    document.querySelectorAll('[data-kind]').forEach(btn => btn.classList.toggle('active',btn.dataset.kind===kind));
    $('income-fields').hidden = kind !== 'income';
    $('expense-fields').hidden = kind !== 'expense';
    $('tax-preview').hidden = kind !== 'income';
    $('entry-client').required = kind === 'income';
    $('entry-category').required = kind === 'expense';
    updateRent(); updatePreview();
  }
  function updateRent() {
    const selected = $('entry-category').value;
    $('purchase-source-wrap').hidden = operationKind!=='expense' || !['materials','equipment'].includes(selected);
    $('expense-address-wrap').hidden = operationKind!=='expense' || selected!=='other';
    $('entry-photo-wrap').hidden = operationKind==='expense' && !['materials','equipment','other'].includes(selected);
    updatePurchaseSource();
    const rent = C.recentRent(state.entries.filter(e=>e.id!==editing), 'rent');
    $('rent-preset').hidden = operationKind!=='expense' || selected!=='rent' || rent===null;
    $('last-rent').textContent = rent === null ? '—' : money(rent);
  }
  function updatePurchaseSource() {
    const custom = !$('purchase-source-wrap').hidden && $('purchase-source').value === 'other';
    $('custom-purchase-wrap').hidden = !custom;
    $('custom-purchase').required = custom;
  }
  function updateTaxControl() {
    $('custom-tax-wrap').hidden = $('tax-select').value !== 'custom';
    $('custom-tax').required = !$('custom-tax-wrap').hidden;
    updatePreview();
  }
  function rate() {return $('tax-select').value === 'custom' ? Number($('custom-tax').value) : Number($('tax-select').value);}
  function parseAmount() {const n=Number(String($('entry-amount').value).replace(',','.'));return Math.round(n*100);}
  function updatePreview() {
    const amount = Number.isFinite(parseAmount()) ? Math.max(0,parseAmount()) : 0;
    const r = Number.isFinite(rate()) ? rate() : 0;
    const tax = Math.round(amount*r/100);
    $('preview-tax').textContent = money(tax);$('preview-net').textContent=money(amount-tax);
  }
  function openEntry(entry = null, stage = null) {
    editing = entry?.id || null;
    $('dialog-title').textContent = editing ? 'Редактировать сделку' : 'Новая сделка';
    $('entry-form').reset();
    $('entry-date').value = entry?.date || selectedDate;
    $('entry-client').value = entry?.clientId || '';
    $('entry-time').value = entry?.time || '';
    $('entry-status').value = entry?.status || stage || 'planned';
    $('entry-note').value = entry?.note || '';
    $('entry-address').value = entry?.address || '';
    pendingEntryPhoto=entry?.photo||null;
    showPhoto('entry',pendingEntryPhoto);
    $('entry-amount').value = entry ? (entry.amount/100).toFixed(2) : '';
    $('entry-category').value = entry?.categoryId || state.categories[0]?.id || '';
    const source = entry?.purchaseSource || '';
    $('purchase-source').value = ['', 'Wildberries', 'Ozon'].includes(source) ? source : 'other';
    $('custom-purchase').value = ['', 'Wildberries', 'Ozon'].includes(source) ? '' : source;
    if (entry && entry.kind==='income' && ![0,4,6].includes(Number(entry.taxRate))) {
      $('tax-select').value = 'custom'; $('custom-tax').value = entry.taxRate;
    } else $('tax-select').value = String(entry?.taxRate ?? 4);
    updateTaxControl();setKind(entry?.kind || 'income');
    $('entry-dialog').showModal();
    setTimeout(()=>$('entry-amount').focus(),0);
  }
  function closeEntry() {$('entry-dialog').close(); editing=null;}
  async function handleSave(e) {
    e.preventDefault();if(saving) return;
    const amount = parseAmount();
    const taxRate = rate();
    if(!Number.isSafeInteger(amount) || amount<=0 || amount>1e12){toast('Укажите корректную сумму');return;}
    if(operationKind==='income' && (!Number.isFinite(taxRate) || taxRate<0 || taxRate>100)){toast('Налоговая ставка должна быть от 0 до 100%');return;}
    if(operationKind==='income' && !state.clients.some(c=>c.id===$('entry-client').value)){toast('Выберите клиента или создайте нового');return;}
    const materialExpense = operationKind==='expense' && ['materials','equipment'].includes($('entry-category').value);
    const purchaseSource = materialExpense ? ($('purchase-source').value==='other' ? $('custom-purchase').value.trim() : $('purchase-source').value) : null;
    if(materialExpense && $('purchase-source').value==='other' && !purchaseSource){toast('Введите название магазина');return;}
    if(photoLoading){toast('Фото ещё обрабатывается');return;}
    const chosenCategory=operationKind==='expense' ? $('entry-category').value : null;
    const photo=operationKind==='income'||['materials','equipment','other'].includes(chosenCategory)?pendingEntryPhoto:null;
    const address=chosenCategory==='other' ? $('entry-address').value.trim() : '';
    const item = {photo,address,purchaseSource: purchaseSource || null, date:$('entry-date').value,kind:operationKind,status:$('entry-status').value,clientId:operationKind==='income'?$('entry-client').value:null,time:operationKind==='income'?($('entry-time').value||null):null,amount,
      taxRate: operationKind==='income'?taxRate:0, categoryId:operationKind==='expense'?$('entry-category').value:null, note:$('entry-note').value.trim()};
    saving=true;$('save-entry').disabled=true;
    try {await mutate(editing?'PUT':'POST',editing?`/api/entries/${editing}`:'/api/entries',item);selectedDate=item.date;viewYear=Number(item.date.slice(0,4));viewMonth=Number(item.date.slice(5,7))-1;render();closeEntry();toast('Сделка сохранена');}
    catch(err){toast(err.message);}
    finally{saving=false;$('save-entry').disabled=false;}
  }
  async function persistLocalBackup(data) {
    const previous=state;
    state=data;
    try {await persistLocal();}catch(err){state=previous;throw err;}
  }
  async function importFile(file) {
    if (!file) return;
    try {
      if (file.size > 50 * 1024 * 1024) throw Error('Файл слишком большой');
      const data = validateBackup(JSON.parse(await file.text()));
      if (!confirm(`Заменить все текущие данные? В файле ${data.entries.length} операций и ${data.clients.length} клиентов.`)) return;
      if(standalone){await persistLocalBackup(data);render();}
      else {const r=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const json=await r.json();if(!r.ok)throw Error(json.error || 'Ошибка импорта');await refresh();}
      toast('Резервная копия загружена');
    } catch(err){toast('Ошибка импорта: '+err.message);} finally{$('import-data').value='';}
  }
  function exportData() {
    const json=JSON.stringify({schemaVersion:3,exportedAt:new Date().toISOString(),...state},null,2);
    if(window.Android && typeof window.Android.saveBackup==='function') {window.Android.saveBackup(json);return;}
    const blob=new Blob([json],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`nails-crm-${localDate(new Date())}.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000);
  }
  document.querySelectorAll('[data-page]').forEach(el=>el.addEventListener('click',()=>navigate(el.dataset.page)));
  $('add-entry').addEventListener('click',()=>openEntry());$('add-on-day').addEventListener('click',()=>openEntry());
  $('close-dialog').addEventListener('click',closeEntry);$('cancel-entry').addEventListener('click',closeEntry);
  document.querySelectorAll('[data-kind]').forEach(el=>el.addEventListener('click',()=>setKind(el.dataset.kind)));
  $('entry-form').addEventListener('submit',handleSave);
  $('tax-select').addEventListener('change',updateTaxControl);$('custom-tax').addEventListener('input',updatePreview);$('entry-amount').addEventListener('input',updatePreview);
  $('entry-category').addEventListener('change',updateRent);
  $('entry-photo-file').addEventListener('change',e=>handlePhotoChange('entry',e.target.files?.[0]));
  $('client-photo-file').addEventListener('change',e=>handlePhotoChange('client',e.target.files?.[0]));
  $('remove-entry-photo').addEventListener('click',()=>{pendingEntryPhoto=null;showPhoto('entry',null);});
  $('remove-client-photo').addEventListener('click',()=>{pendingClientPhoto=null;showPhoto('client',null);});
  $('purchase-source').addEventListener('change',updatePurchaseSource);
  $('use-last-rent').addEventListener('click',()=>{const rent=C.recentRent(state.entries.filter(e=>e.id!==editing),'rent');if(rent!==null){$('entry-amount').value=(rent/100).toFixed(2);updatePreview();}});
  $('calendar-grid').addEventListener('click',e=>{const el=e.target.closest('[data-date]');if(!el)return;selectedDate=el.dataset.date;viewYear=Number(selectedDate.slice(0,4));viewMonth=Number(selectedDate.slice(5,7))-1;renderCalendar();openEntry();});
  $('prev-month').addEventListener('click',()=>{const dt=new Date(viewYear,viewMonth-1,1);viewYear=dt.getFullYear();viewMonth=dt.getMonth();selectedDate=localDate(dt);renderCalendar();});
  $('next-month').addEventListener('click',()=>{const dt=new Date(viewYear,viewMonth+1,1);viewYear=dt.getFullYear();viewMonth=dt.getMonth();selectedDate=localDate(dt);renderCalendar();});
  $('current-month').addEventListener('click',()=>{const dt=new Date();viewYear=dt.getFullYear();viewMonth=dt.getMonth();selectedDate=localDate(dt);renderCalendar();});
  $('day-list').addEventListener('click',async e=>{
    const edit=e.target.closest('[data-edit]'); const remove=e.target.closest('[data-remove]');
    if(edit) {const entry=state.entries.find(x=>x.id===edit.dataset.edit);if(entry)openEntry(entry);}
    if(remove&&confirm('Удалить эту сделку?')){try{await mutate('DELETE',`/api/entries/${remove.dataset.remove}`);toast('Сделка удалена');}catch(err){toast(err.message);}}
  });
  $('report-year').addEventListener('change',e=>{reportYear=Number(e.target.value);renderReports();});
  document.querySelectorAll('[data-deal-filter]').forEach(btn=>btn.addEventListener('click',()=>{
    dealFilter=btn.dataset.dealFilter;
    document.querySelectorAll('[data-deal-filter]').forEach(b=>b.classList.toggle('active',b===btn));renderDeals();
  }));
  $('deal-search').addEventListener('input',renderDeals);
  $('mobile-stage-tabs').addEventListener('click',event=>{
    const tab=event.target.closest('[data-mobile-stage]');
    if (!tab)return;
    mobileDealStage=tab.dataset.mobileStage;
    renderDeals();
  });
  $('kanban-board').addEventListener('click',e=>{
    const toggle=e.target.closest('[data-toggle-completed]');
    if(toggle){const id=toggle.dataset.toggleCompleted;if(expandedCompleted.has(id))expandedCompleted.delete(id);else expandedCompleted.add(id);renderDeals();return;}
    const compactCard=e.target.closest('.kanban-card.completed-compact');
    if(compactCard && !e.target.closest('button,select,input,a')){expandedCompleted.add(compactCard.dataset.dealId);renderDeals();return;}
    const edit=e.target.closest('[data-kanban-edit]');
    const create=e.target.closest('[data-create-stage]');
    if(edit){const item=state.entries.find(x=>x.id===edit.dataset.kanbanEdit);if(item)openEntry(item);}
    if(create)openEntry(null,create.dataset.createStage);
  });
  async function updateDealStatus(id,status){
    const item=state.entries.find(e=>e.id===id);
    if(!item || !DEAL_STAGES.some(s=>s.id===status) || (item.status||'completed')===status)return;
    try{await mutate('PATCH',`/api/entries/${id}/status`,{status});toast('Стадия сделки обновлена');}
    catch(err){toast(err.message);renderDeals();}
  }
  $('kanban-board').addEventListener('change',e=>{
    const select=e.target.closest('[data-deal-status]');
    if(select)updateDealStatus(select.dataset.dealStatus,select.value);
  });
  $('kanban-board').addEventListener('dragstart',e=>{
    const card=e.target.closest('[data-deal-id]');if(!card || e.target.closest('button,select,input'))return;
    e.dataTransfer.setData('text/plain',card.dataset.dealId);e.dataTransfer.effectAllowed='move';card.classList.add('dragging');
  });
  $('kanban-board').addEventListener('dragend',()=>document.querySelectorAll('.kanban-column').forEach(c=>c.classList.remove('drop-target')));
  $('kanban-board').addEventListener('dragover',e=>{
    const column=e.target.closest('[data-stage]');if(!column)return;
    e.preventDefault();e.dataTransfer.dropEffect='move';
    document.querySelectorAll('.kanban-column').forEach(c=>c.classList.toggle('drop-target',c===column));
  });
  $('kanban-board').addEventListener('drop',e=>{
    e.preventDefault();document.querySelectorAll('.kanban-column').forEach(c=>c.classList.remove('drop-target'));
    const column=e.target.closest('[data-stage]');
    const id=e.dataTransfer.getData('text/plain');
    if(column && id)updateDealStatus(id,column.dataset.stage);
  });
  $('category-form').addEventListener('submit',async e=>{e.preventDefault();const input=$('category-name');try{await mutate('POST','/api/categories',{label:input.value.trim()});input.value='';toast('Статья расходов добавлена');}catch(err){toast(err.message);}});
  $('category-list').addEventListener('click',async e=>{const btn=e.target.closest('[data-delete-category]');if(!btn||btn.disabled)return;if(!confirm('Удалить эту статью расходов?'))return;try{await mutate('DELETE',`/api/categories/${btn.dataset.deleteCategory}`);toast('Статья удалена');}catch(err){toast(err.message);}});
  $('add-client').addEventListener('click',()=>openClient());
  $('quick-add-client').addEventListener('click',()=>openClient(null,true));
  $('close-client-dialog').addEventListener('click',()=>$('client-dialog').close());
  $('cancel-client').addEventListener('click',()=>$('client-dialog').close());
  $('client-source').addEventListener('change',updateCustomSource);
  $('client-form').addEventListener('submit',handleClientSave);
  $('client-search').addEventListener('input',renderClients);
  $('clients-list').addEventListener('click',async e=>{
    const edit=e.target.closest('[data-client-edit]');const remove=e.target.closest('[data-client-remove]');const history=e.target.closest('[data-client-history]');
    if(edit){const c=state.clients.find(x=>x.id===edit.dataset.clientEdit);if(c)openClient(c);}
    if(history){const c=state.clients.find(x=>x.id===history.dataset.clientHistory);if(c)openHistory(c);}
    if(remove&&!remove.disabled&&confirm('Удалить клиента без истории посещений?')){
      try{await mutate('DELETE',`/api/clients/${remove.dataset.clientRemove}`);toast('Клиент удалён');}catch(err){toast(err.message);}
    }
  });
  $('close-history').addEventListener('click',()=>$('history-dialog').close());
  $('history-done').addEventListener('click',()=>$('history-dialog').close());
  $('source-form').addEventListener('submit',async e=>{e.preventDefault();const input=$('source-name');try{await mutate('POST','/api/client-sources',{label:input.value.trim()});input.value='';toast('Источник добавлен');}catch(err){toast(err.message);}});
  $('source-list').addEventListener('click',async e=>{const btn=e.target.closest('[data-delete-source]');if(!btn||btn.disabled)return;if(!confirm('Удалить этот источник?'))return;try{await mutate('DELETE',`/api/client-sources/${btn.dataset.deleteSource}`);toast('Источник удалён');}catch(err){toast(err.message);}});
  $('export-data').addEventListener('click',exportData);
  $('import-data').addEventListener('change',e=>importFile(e.target.files?.[0]));
  window.NailsIcons.hydrate(document);
  if (!standalone && 'serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
  refresh().catch(err => {toast(err.message);$('connection-label').textContent='Сервер недоступен';});
  // Read-only refresh to reflect changes made from another browser on the same server.
  if(!standalone) setInterval(()=>{if(!$('entry-dialog').open && !$('client-dialog').open && document.visibilityState==='visible') refresh().catch(()=>{});},15000);
})();
