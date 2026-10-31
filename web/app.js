/* Nails CRM client. Server mode: SQLite JSON API. Standalone/Android: localStorage. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const C = window.NailsCore;
  const standalone = location.protocol === 'file:' || location.hostname === 'appassets.androidplatform.net' || new URLSearchParams(location.search).has('standalone');
  const KEY = 'nails-crm-local-v1';
  const MONTHS = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
  const DEFAULT_CATEGORIES = [{id:'rent', label:'Аренда'}, {id:'materials', label:'Материалы'}, {id:'equipment', label:'Оборудование'}, {id:'other', label:'Прочее'}];
  const current = new Date();
  let viewYear = current.getFullYear();
  let viewMonth = current.getMonth();
  let selectedDate = localDate(current);
  let selectedPage = 'calendar';
  let operationKind = 'income';
  let editing = null;
  let state = {entries:[], categories:[]};
  let reportYear = viewYear;
  let saving = false;
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
  function initialState() {return {categories:structuredClone(DEFAULT_CATEGORIES), entries:[]};}
  function persistLocal() {localStorage.setItem(KEY, JSON.stringify(state));}
  function validateBackup(data) {
    if (!data || !Array.isArray(data.entries) || !Array.isArray(data.categories) || data.entries.length > 100000 || data.categories.length > 5000) throw Error('Неверный формат резервной копии');
    const ids = new Set(); const labels = new Set();
    for (const cat of data.categories) {
      if (typeof cat.id !== 'string' || !cat.id || typeof cat.label !== 'string' || !cat.label.trim() || labels.has(cat.label.toLowerCase()) || ids.has(cat.id)) throw Error('Некорректные статьи расходов');
      ids.add(cat.id); labels.add(cat.label.toLowerCase());
    }
    const entryIds = new Set();
    for (const e of data.entries) {
      if (typeof e.id !== 'string' || !e.id || entryIds.has(e.id) || !/^\d{4}-\d{2}-\d{2}$/.test(e.date || '') || !Number.isInteger(e.amount) || e.amount < 1 || !['income','expense'].includes(e.kind)) throw Error('Некорректные операции');
      if ((e.kind === 'income' && (!String(e.name || '').trim() || !Number.isFinite(e.taxRate) || e.taxRate < 0 || e.taxRate > 100)) || (e.kind === 'expense' && !ids.has(e.categoryId))) throw Error('Некорректная операция или категория');
      entryIds.add(e.id);
    }
    return {categories:data.categories, entries:data.entries};
  }
  async function refresh() {
    if (standalone) {
      try {state = validateBackup(JSON.parse(localStorage.getItem(KEY)) || initialState());}
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
    if (path === '/api/entries' && method === 'POST') {
      const ts = new Date().toISOString();
      state.entries.push({...body, id:crypto.randomUUID(), createdAt:ts, updatedAt:ts});
    } else if (path.startsWith('/api/entries/') && method === 'PUT') {
      const i = state.entries.findIndex(e => e.id === path.split('/').pop());
      if (i < 0) throw Error('Операция не найдена');
      state.entries[i] = {...state.entries[i], ...body, updatedAt:new Date().toISOString()};
    } else if (path.startsWith('/api/entries/') && method === 'DELETE') {
      state.entries = state.entries.filter(e => e.id !== path.split('/').pop());
    } else if (path === '/api/categories' && method === 'POST') {
      const label = body.label.trim();
      if (!label || state.categories.some(c => c.label.toLowerCase() === label.toLowerCase())) throw Error('Такая категория уже существует');
      state.categories.push({id:crypto.randomUUID(), label});
    } else if (path.startsWith('/api/categories/') && method === 'DELETE') {
      const id = path.split('/').pop();
      if (state.entries.some(e => e.categoryId === id)) throw Error('Категория используется в операциях. Сначала измените записи.');
      state.categories = state.categories.filter(c => c.id !== id);
    } else throw Error('Неизвестная операция');
    persistLocal(); render();
  }
  function render() {
    renderCalendar(); renderReports(); renderSettings();
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
      cells.push(`<button type="button" role="gridcell" data-date="${key}" aria-label="${safe(longDate(key))}, операций: ${entries.length}" aria-selected="${key===selectedDate}" class="calendar-day${outside?' outside':''}${key===selectedDate?' selected':''}${key===todayKey?' today':''}"><span class="day-number">${dt.getDate()}</span><span class="day-values">${daily.income ? display(daily.income) : ''}${daily.expenses ? display(-daily.expenses):''}</span>${entries.length?`<span class="day-count">${entries.length} зап.</span>`:''}</button>`);
    }
    $('calendar-grid').innerHTML = cells.join('');
    $('selected-day-heading').textContent = longDate(selectedDate);
    const selected = (buckets.get(selectedDate) || []).slice().sort((a,b) => b.createdAt.localeCompare(a.createdAt));
    const dayTotal = C.totals(selected);
    $('day-subtitle').textContent = `${selected.length} ${plural(selected.length, 'операция', 'операции', 'операций')}`;
    $('day-totals').innerHTML = `<div><span>Поступления</span><strong>${money(dayTotal.income)}</strong></div><div><span>Расходы + налог</span><strong>${money(dayTotal.expenses+dayTotal.tax)}</strong></div>`;
    $('day-list').innerHTML = selected.length ? selected.map(entry => {
      const income = entry.kind === 'income';
      const label = income ? entry.name : category(entry.categoryId);
      const sub = income ? `Налог ${entry.taxRate}% · ${money(C.tax(entry))}${entry.note ? ' · ' + safe(entry.note) : ''}` : (entry.note ? safe(entry.note) : 'Расход');
      return `<article class="entry-card"><span class="entry-icon ${income?'':'out'}">${income?'↗':'↘'}</span><div class="entry-desc"><strong>${safe(label)}</strong><small>${sub}</small></div><div class="entry-amount ${income?'in':'out'}">${income?'+':'−'}${money(entry.amount)}</div><div class="entry-actions"><button data-edit="${safe(entry.id)}" type="button" aria-label="Редактировать">✎</button><button data-remove="${safe(entry.id)}" type="button" aria-label="Удалить">×</button></div></article>`;
    }).join('') : '<div class="empty"><span class="empty-symbol">✧</span>На эту дату пока нет записей.<br>Нажмите ＋, чтобы добавить первую.</div>';
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
    $('entry-category').innerHTML = state.categories.map(c=>`<option value="${safe(c.id)}">${safe(c.label)}</option>`).join('');
  }
  function navigate(page) {
    selectedPage = page;
    document.querySelectorAll('.page').forEach(el => el.hidden = el.id !== `${page}-page`);
    document.querySelectorAll('[data-page]').forEach(el => el.classList.toggle('active',el.dataset.page===page));
    $('page-title').textContent = {calendar:'Календарь',reports:'Финансы',settings:'Настройки'}[page];
  }
  function setKind(kind) {
    operationKind = kind;
    document.querySelectorAll('[data-kind]').forEach(btn => btn.classList.toggle('active',btn.dataset.kind===kind));
    $('income-fields').hidden = kind !== 'income';
    $('expense-fields').hidden = kind !== 'expense';
    $('tax-preview').hidden = kind !== 'income';
    $('entry-name').required = kind === 'income';
    $('entry-category').required = kind === 'expense';
    updateRent(); updatePreview();
  }
  function updateRent() {
    const selected = $('entry-category').value;
    const rent = C.recentRent(state.entries.filter(e=>e.id!==editing), 'rent');
    $('rent-preset').hidden = operationKind!=='expense' || selected!=='rent' || rent===null;
    $('last-rent').textContent = rent === null ? '—' : money(rent);
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
  function openEntry(entry = null) {
    editing = entry?.id || null;
    $('dialog-title').textContent = editing ? 'Редактировать операцию' : 'Новая операция';
    $('entry-form').reset();
    $('entry-date').value = entry?.date || selectedDate;
    $('entry-name').value = entry?.name || '';
    $('entry-note').value = entry?.note || '';
    $('entry-amount').value = entry ? (entry.amount/100).toFixed(2) : '';
    $('entry-category').value = entry?.categoryId || state.categories[0]?.id || '';
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
    if(operationKind==='income' && !$('entry-name').value.trim()){toast('Введите имя клиента');return;}
    const item = {date:$('entry-date').value,kind:operationKind,name:operationKind==='income'?$('entry-name').value.trim():'', amount,
      taxRate: operationKind==='income'?taxRate:0, categoryId:operationKind==='expense'?$('entry-category').value:null, note:$('entry-note').value.trim()};
    saving=true;$('save-entry').disabled=true;
    try {await mutate(editing?'PUT':'POST',editing?`/api/entries/${editing}`:'/api/entries',item);selectedDate=item.date;viewYear=Number(item.date.slice(0,4));viewMonth=Number(item.date.slice(5,7))-1;render();closeEntry();toast('Операция сохранена');}
    catch(err){toast(err.message);}
    finally{saving=false;$('save-entry').disabled=false;}
  }
  async function importFile(file) {
    if (!file) return;
    try {
      if (file.size > 12 * 1024 * 1024) throw Error('Файл слишком большой');
      const data = validateBackup(JSON.parse(await file.text()));
      if (!confirm(`Заменить все текущие данные? В файле ${data.entries.length} операций и ${data.categories.length} статей.`)) return;
      if(standalone){state=data;persistLocal();render();}
      else {const r=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const json=await r.json();if(!r.ok)throw Error(json.error || 'Ошибка импорта');await refresh();}
      toast('Резервная копия загружена');
    } catch(err){toast('Ошибка импорта: '+err.message);} finally{$('import-data').value='';}
  }
  function exportData() {
    const json=JSON.stringify({schemaVersion:1,exportedAt:new Date().toISOString(),...state},null,2);
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
  $('use-last-rent').addEventListener('click',()=>{const rent=C.recentRent(state.entries.filter(e=>e.id!==editing),'rent');if(rent!==null){$('entry-amount').value=(rent/100).toFixed(2);updatePreview();}});
  $('calendar-grid').addEventListener('click',e=>{const el=e.target.closest('[data-date]');if(!el)return;selectedDate=el.dataset.date;viewYear=Number(selectedDate.slice(0,4));viewMonth=Number(selectedDate.slice(5,7))-1;renderCalendar();});
  $('prev-month').addEventListener('click',()=>{const dt=new Date(viewYear,viewMonth-1,1);viewYear=dt.getFullYear();viewMonth=dt.getMonth();selectedDate=localDate(dt);renderCalendar();});
  $('next-month').addEventListener('click',()=>{const dt=new Date(viewYear,viewMonth+1,1);viewYear=dt.getFullYear();viewMonth=dt.getMonth();selectedDate=localDate(dt);renderCalendar();});
  $('current-month').addEventListener('click',()=>{const dt=new Date();viewYear=dt.getFullYear();viewMonth=dt.getMonth();selectedDate=localDate(dt);renderCalendar();});
  $('day-list').addEventListener('click',async e=>{
    const edit=e.target.closest('[data-edit]'); const remove=e.target.closest('[data-remove]');
    if(edit) {const entry=state.entries.find(x=>x.id===edit.dataset.edit);if(entry)openEntry(entry);}
    if(remove&&confirm('Удалить эту операцию?')){try{await mutate('DELETE',`/api/entries/${remove.dataset.remove}`);toast('Операция удалена');}catch(err){toast(err.message);}}
  });
  $('report-year').addEventListener('change',e=>{reportYear=Number(e.target.value);renderReports();});
  $('category-form').addEventListener('submit',async e=>{e.preventDefault();const input=$('category-name');try{await mutate('POST','/api/categories',{label:input.value.trim()});input.value='';toast('Статья расходов добавлена');}catch(err){toast(err.message);}});
  $('category-list').addEventListener('click',async e=>{const btn=e.target.closest('[data-delete-category]');if(!btn||btn.disabled)return;if(!confirm('Удалить эту статью расходов?'))return;try{await mutate('DELETE',`/api/categories/${btn.dataset.deleteCategory}`);toast('Статья удалена');}catch(err){toast(err.message);}});
  $('export-data').addEventListener('click',exportData);
  $('import-data').addEventListener('change',e=>importFile(e.target.files?.[0]));
  if (!standalone && 'serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
  refresh().catch(err => {toast(err.message);$('connection-label').textContent='Сервер недоступен';});
  // Read-only refresh to reflect changes made from another browser on the same server.
  if(!standalone) setInterval(()=>{if(!$('entry-dialog').open && document.visibilityState==='visible') refresh().catch(()=>{});},15000);
})();
