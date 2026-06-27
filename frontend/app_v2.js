const $ = (id) => document.getElementById(id);
let currentJobTimer = null;
let selectedReviewItemId = null;
let allPartners = [];
let selectedPartnerId = null;
let lastReviewItems = [];
let lastStats = null;
let catalogSearchTimer = null;

const pageMeta = {
  upload: ['Прайсы', 'Загрузка архивов и контроль обработки.'],
  partners: ['Партнёры', 'Клиники из загруженных прайсов.'],
  search: ['Поиск', 'Поиск цен по позициям партнёров.'],
  review: ['Ревью', 'Ручная проверка сомнительных строк.'],
  stats: ['Статистика', 'Состояние базы.'],
  catalog: ['Справочник', 'Загруженный каталог услуг.'],
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
}
function money(v) { return v == null ? '—' : Number(v).toLocaleString('ru-RU') + ' ₸'; }
function yearFrom(v) { const m = String(v || '').match(/\b(20\d{2})\b/); return m ? m[1] : '—'; }
function dash(v) { return (v === null || v === undefined || v === '') ? '—' : esc(v); }

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data.raw || res.statusText));
  return data;
}

function applyRuntimeUiTweaks() {
  if (!$('runtimeUiTweaks')) {
    const style = document.createElement('style');
    style.id = 'runtimeUiTweaks';
    style.textContent = `
      .main{max-width:none!important}.header,.content{padding-left:40px!important;padding-right:40px!important}.layout-prices{grid-template-columns:minmax(300px,350px) minmax(0,1fr)!important}.sidebar-foot{line-height:17px!important}.table tr.selected td{background:var(--primary-soft)!important}.review-guide{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:16px}.review-step{background:#f4f1ed;border:1px solid #e5e0d8;border-radius:8px;padding:12px}.review-step b{display:block;margin-bottom:4px}.review-match,.review-apply{display:grid;grid-template-columns:1fr auto;gap:12px;margin-bottom:12px}.review-selected{margin-bottom:12px}.review-row{cursor:pointer}.review-row:hover td{background:#f4f1ed!important}.catalog-preview{margin-top:24px}.catalog-preview-head{display:grid;grid-template-columns:1fr minmax(220px,360px) auto;gap:12px;align-items:end}.catalog-services-table{max-height:420px!important}#catalogPreviewList{margin-top:16px}#reviewLowOnly{display:none!important}#uploadResult .items-table{max-height:360px!important}@media(max-width:1180px){.layout-prices{grid-template-columns:1fr!important}.review-guide,.catalog-preview-head{grid-template-columns:1fr!important}}@media(max-width:768px){.header,.content{padding-left:16px!important;padding-right:16px!important}.review-match,.review-apply{grid-template-columns:1fr!important}}
    `;
    document.head.appendChild(style);
  }
  const footer = document.querySelector('.sidebar-foot');
  if (footer) footer.innerHTML = 'Ревью — это не ошибки.<br/>Это строки, где системе нужна ручная проверка.';

  const reviewPanel = $('review')?.querySelector('.panel');
  if (reviewPanel && !reviewPanel.dataset.simpleReview) {
    reviewPanel.dataset.simpleReview = '1';
    reviewPanel.innerHTML = `
      <div class="panel-head"><div><h2 class="h1">Ревью</h2><p class="hint">Сомнительные строки: нет match, низкая уверенность или странная цена.</p></div><button id="loadReviewBtn" class="btn btn-soft">Обновить</button></div>
      <div class="review-guide"><div class="review-step"><b>1. Выбери строку</b><span class="hint">Кликни по позиции в таблице.</span></div><div class="review-step"><b>2. Найди услугу</b><span class="hint">Название подставится в поиск.</span></div><div class="review-step"><b>3. Примени match</b><span class="hint">Позиция уйдёт из ревью.</span></div></div>
      <input id="reviewClinicFilter" class="input" placeholder="Фильтр по клинике, услуге или причине" style="margin-bottom:12px" />
      <input id="reviewMaxConfidence" type="hidden" value="" style="display:none" /><input id="reviewLowOnly" type="checkbox" style="display:none" />
      <div id="reviewSelected" class="review-selected hint">Позиция не выбрана.</div>
      <div class="review-match"><input id="reviewServiceSearch" class="input" placeholder="Услуга из справочника" /><button id="reviewServiceBtn" class="btn">Найти в справочнике</button></div>
      <div class="review-apply"><select id="reviewServiceSelect" class="input"></select><button id="applyReviewMatchBtn" class="btn btn-primary">Применить match</button></div>
      <div id="reviewResult"></div>`;
  }

  const catalogPanel = $('catalog')?.querySelector('.panel');
  if (catalogPanel && !$('catalogPreviewList')) {
    catalogPanel.insertAdjacentHTML('beforeend', `
      <section class="catalog-preview">
        <div class="catalog-preview-head"><div><h3 class="h1">Загруженный справочник</h3><p id="catalogPreviewSummary" class="hint">Показываю объединённый справочник из базы.</p></div><input id="catalogSearchInput" class="input" placeholder="Найти в справочнике" /><button id="refreshCatalogPreviewBtn" class="btn btn-soft">Обновить</button></div>
        <div id="catalogPreviewList"></div>
      </section>`);
  }
}

function activateTab(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('tab-active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.hidden = p.id !== name);
  if ($('pageTitle')) $('pageTitle').textContent = pageMeta[name]?.[0] || name;
  if ($('pageNote')) $('pageNote').textContent = pageMeta[name]?.[1] || '';
  if (name === 'stats') refreshStats();
  if (name === 'partners') loadPartners();
  if (name === 'review') loadUnmatched();
  if (name === 'catalog') loadCatalogPreview();
}
document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => activateTab(btn.dataset.tab)));
applyRuntimeUiTweaks();

function badge(status) {
  if (status === 'done' || status === 'completed') return '<span class="badge ok">готово</span>';
  if (status === 'needs_review') return '<span class="badge warn">ревью</span>';
  if (status === 'finished_with_errors') return '<span class="badge warn">есть ошибки</span>';
  if (status === 'processing') return '<span class="badge warn">обработка</span>';
  if (status === 'pending') return '<span class="badge">ожидает</span>';
  if (status === 'error' || status === 'failed') return '<span class="badge bad">ошибка</span>';
  return `<span class="badge">${esc(status || '—')}</span>`;
}
function docBadge(doc) {
  if (doc.error || doc.status === 'error' || doc.status === 'failed') return badge('error');
  if (doc.status === 'processing') return badge('processing');
  if (doc.status === 'pending') return badge('pending');
  return badge('done');
}
function itemStatus(item) { return item.needs_review ? '<span class="badge warn">ревью</span>' : '<span class="badge ok">ok</span>'; }
function table(headers, rows, empty = 'Ничего', extraClass = '') {
  return `<div class="table-wrap ${extraClass}"><table class="table"><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="muted">${esc(empty)}</td></tr>`}</tbody></table></div>`;
}

function scrollKey(el, index) {
  const named = Array.from(el.classList || []).filter(c => c !== 'table-wrap').join('.');
  return named || `table-${index}`;
}
function captureScroll(root) {
  if (!root) return null;
  const state = { rootTop: root.scrollTop || 0, tables: {} };
  root.querySelectorAll('.table-wrap').forEach((el, i) => {
    state.tables[scrollKey(el, i)] = { top: el.scrollTop || 0, left: el.scrollLeft || 0 };
  });
  return state;
}
function restoreScroll(root, state) {
  if (!root || !state) return;
  root.scrollTop = state.rootTop || 0;
  root.querySelectorAll('.table-wrap').forEach((el, i) => {
    const saved = state.tables[scrollKey(el, i)];
    if (saved) { el.scrollTop = saved.top || 0; el.scrollLeft = saved.left || 0; }
  });
}

async function refreshStats() {
  try {
    const s = await api('/api/stats');
    lastStats = s;
    const cards = [['Партнёры', s.partners], ['Справочник', s.services], ['Документы', s.documents], ['Позиции', s.price_items], ['На ревью', s.needs_review], ['Auto-match', (s.auto_normalization_percent ?? 0) + '%']];
    if ($('kpi')) $('kpi').innerHTML = cards.map(([label, value]) => `<div class="metric"><div class="metric-label">${esc(label)}</div><div class="metric-value">${esc(value ?? 0)}</div></div>`).join('');
  } catch(e) { if ($('kpi')) $('kpi').innerHTML = `<div class="card"><span class="badge bad">${esc(e.message)}</span></div>`; }
}

function setupDrop() {
  const input = $('priceFiles'), hint = $('filePickHint'), drop = $('dropZone');
  if (input && hint && drop) {
    const refreshHint = () => {
      const files = Array.from(input.files || []);
      hint.textContent = files.length ? files.map(f => f.name).join(' · ') : 'ZIP, PDF, DOCX, XLSX, XLS';
    };
    input.addEventListener('change', refreshHint);
    ['dragenter','dragover'].forEach(evt => drop.addEventListener(evt, e => { e.preventDefault(); drop.classList.add('dragover'); }));
    ['dragleave','drop'].forEach(evt => drop.addEventListener(evt, e => { e.preventDefault(); drop.classList.remove('dragover'); }));
    drop.addEventListener('drop', e => { input.files = e.dataTransfer.files; input.dispatchEvent(new Event('change')); });
  }

  const catalog = $('catalogFile'), catalogHint = $('catalogFileHint');
  if (catalog && catalogHint) {
    catalog.addEventListener('change', () => { catalogHint.textContent = catalog.files?.[0]?.name || 'Файл не выбран'; });
  }
}

$('priceForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (currentJobTimer) clearInterval(currentJobTimer);
  $('uploadResult').style.display = 'block';
  $('uploadResult').innerHTML = '<div class="muted"><b>Файлы приняты.</b> Создаю очередь...</div>';
  const fd = new FormData();
  fd.append('clinic_name', 'Auto');
  Array.from($('priceFiles').files).forEach(f => fd.append('files', f));
  try {
    const job = await api('/api/upload-async', { method: 'POST', body: fd });
    renderJob(job, false);
    pollJob(job.job_id);
  } catch(e) { $('uploadResult').innerHTML = `<div class="card"><span class="badge bad">${esc(e.message)}</span></div>`; }
});

async function pollJob(jobId) {
  currentJobTimer = setInterval(async () => {
    try {
      const job = await api('/api/jobs/' + encodeURIComponent(jobId));
      renderJob(job, true);
      if (['done','finished_with_errors','error'].includes(job.status)) {
        clearInterval(currentJobTimer);
        loadPartners();
        refreshStats();
      }
    } catch(e) {
      clearInterval(currentJobTimer);
      $('uploadResult').insertAdjacentHTML('afterbegin', `<div class="card"><span class="badge bad">${esc(e.message)}</span></div>`);
    }
  }, 2000);
}

function renderJob(job, keepScroll = true) {
  const root = $('uploadResult');
  const scrollState = keepScroll ? captureScroll(root) : null;
  root.style.display = 'block';
  const docs = job.documents || [];
  const docRows = docs.map(doc => {
    const error = doc.error ? `<span class="badge bad">${esc(doc.error)}</span>` : '<span class="muted">—</span>';
    return `<tr><td><b>${esc(doc.clinic_name || '—')}</b></td><td>${esc(yearFrom(doc.file_name))}</td><td>${esc(doc.file_name || '—')}</td><td>${docBadge(doc)}</td><td>${doc.items ?? 0}</td><td><b>${doc.review_items ?? 0}</b></td><td>${error}</td></tr>`;
  }).join('');
  const items = [], seen = new Set();
  for (const item of job.data || []) {
    const key = `${item.clinic_name}|${item.standardized_name || item.original_name}|${item.price}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= 500) break;
  }
  const itemRows = items.map(item => `<tr><td><b>${esc(item.clinic_name || '—')}</b></td><td>${esc(item.standardized_name || item.original_name)}</td><td>${money(item.price)}</td><td>${esc(item.category || '—')}</td><td>${esc(item.confidence)}%</td><td>${itemStatus(item)}</td></tr>`).join('');
  root.innerHTML = `<div class="grid-3 job-metrics"><div class="metric"><div class="metric-label">Статус</div><div style="margin-top:8px">${badge(job.status)}</div></div><div class="metric"><div class="metric-label">Файлы</div><div class="metric-value">${job.processed_files || 0}/${job.total_files || 0}</div></div><div class="metric"><div class="metric-label">Всего / на проверку</div><div class="metric-value">${job.items_found || 0} / ${job.needs_review || 0}</div></div></div>${table(['Клиника','Год','Файл','Статус','Услуг','Ревью','Ошибка'], docRows, 'Нет файлов', 'docs-table')}<div class="section-gap"></div>${table(['Клиника','Услуга','Цена','Категория','Match','Статус'], itemRows, 'Позиции пока не извлечены', 'items-table')}`;
  requestAnimationFrame(() => restoreScroll(root, scrollState));
}

async function loadPartners() {
  try { allPartners = await api('/api/partners'); renderPartners(); }
  catch(e) { $('partnersList').innerHTML = `<div class="card"><span class="badge bad">${esc(e.message)}</span></div>`; }
}
function renderPartners() {
  const filter = ($('partnerFilter')?.value || '').toLowerCase();
  const partners = (allPartners || []).filter(p => String(p.name || '').toLowerCase().includes(filter));
  $('partnersList').innerHTML = partners.map(p => `<button class="partner-btn ${p.partner_id === selectedPartnerId ? 'active' : ''}" data-partner-id="${esc(p.partner_id)}"><b>${esc(p.name)}</b><div class="mini">${p.is_active === false ? 'неактивен' : 'активен'}</div></button>`).join('') || '<div class="muted" style="padding:16px">Пока нет клиник.</div>';
  document.querySelectorAll('[data-partner-id]').forEach(btn => btn.addEventListener('click', () => selectPartner(btn.dataset.partnerId)));
}
async function selectPartner(partnerId) {
  selectedPartnerId = partnerId;
  renderPartners();
  const partner = allPartners.find(p => p.partner_id === partnerId);
  $('partnerDetails').innerHTML = '<div class="muted">Загружаю услуги...</div>';
  try {
    const items = await api('/api/partners/' + encodeURIComponent(partnerId) + '/services');
    const rows = items.map(i => `<tr><td>${esc(i.standardized_name || i.original_name)}</td><td>${money(i.price)}</td><td>${esc(i.category || '—')}</td><td>${esc(i.confidence)}%</td><td>${itemStatus(i)}</td><td>${dash(i.effective_date)}</td></tr>`).join('');
    $('partnerDetails').innerHTML = `<div class="panel-head partner-detail-head"><div><div class="h1">${esc(partner?.name || 'Клиника')}</div><div class="hint">${items.length} позиций</div></div></div>${table(['Услуга','Цена','Категория','Match','Статус','Дата'], rows, 'У этой клиники пока нет услуг', 'partner-services-table')}`;
  } catch(e) { $('partnerDetails').innerHTML = `<div class="card"><span class="badge bad">${esc(e.message)}</span></div>`; }
}
$('partnerFilter')?.addEventListener('input', renderPartners);
$('refreshPartnersBtn')?.addEventListener('click', loadPartners);

$('searchBtn')?.addEventListener('click', doSearch);
$('searchInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
async function doSearch() {
  const q = $('searchInput').value.trim();
  if (!q) return;
  $('searchResult').innerHTML = '<div class="muted">Ищу...</div>';
  try {
    const data = await api('/api/search?q=' + encodeURIComponent(q));
    const prices = data.prices || [];
    const rows = prices.map(p => `<tr><td><b>${esc(p.clinic_name)}</b></td><td>${esc(p.standardized_name || p.original_name)}</td><td>${money(p.price)}</td><td>${esc(p.category || '—')}</td><td>${esc(p.confidence)}%</td><td>${itemStatus(p)}</td></tr>`).join('');
    $('searchResult').innerHTML = table(['Клиника','Услуга','Цена','Категория','Match','Статус'], rows, 'Ничего не найдено', 'search-table');
  } catch(e) { $('searchResult').innerHTML = `<div class="card"><span class="badge bad">${esc(e.message)}</span></div>`; }
}

$('loadReviewBtn')?.addEventListener('click', loadUnmatched);
async function loadUnmatched() {
  $('reviewResult').innerHTML = '<div class="muted">Загружаю...</div>';
  try { lastReviewItems = await api('/api/unmatched'); renderReview(); }
  catch(e) { $('reviewResult').innerHTML = `<div class="card"><span class="badge bad">${esc(e.message)}</span></div>`; }
}
function reviewReason(item) {
  if (item.note) return item.note;
  if (!item.service_id) return 'Не найдено совпадение в справочнике';
  if (Number(item.confidence || 0) < 72) return 'Низкая уверенность match';
  return 'Нужна ручная проверка';
}
function reviewPassesFilter(item) {
  const q = ($('reviewClinicFilter')?.value || '').trim().toLowerCase();
  const haystack = `${item.clinic_name || ''} ${item.standardized_name || ''} ${item.original_name || ''} ${reviewReason(item)}`.toLowerCase();
  return !q || haystack.includes(q);
}
function selectReviewItem(itemId) {
  selectedReviewItemId = itemId;
  const item = lastReviewItems.find(i => String(i.item_id) === String(itemId));
  if (item) {
    const name = item.standardized_name || item.original_name || '';
    if ($('reviewServiceSearch')) $('reviewServiceSearch').value = name;
    if ($('reviewSelected')) $('reviewSelected').innerHTML = `<b>Выбрано:</b> ${esc(item.clinic_name || '—')} · ${esc(name)} · ${money(item.price)}`;
  }
  renderReview();
}
function renderReview() {
  const filtered = (lastReviewItems || []).filter(reviewPassesFilter);
  const rows = filtered.map(i => `<tr class="review-row ${String(i.item_id) === String(selectedReviewItemId) ? 'selected' : ''}" data-review-id="${esc(i.item_id)}"><td><b>${esc(i.clinic_name || '—')}</b></td><td>${esc(i.standardized_name || i.original_name)}</td><td>${money(i.price)}</td><td>${esc(i.confidence)}%</td><td>${esc(reviewReason(i))}</td></tr>`).join('');
  $('reviewResult').innerHTML = `<div class="hint" style="margin-bottom:10px">Показано ${filtered.length} из ${lastReviewItems.length}. Кликни по строке, потом выбери правильную услугу справочника.</div>${table(['Клиника','Позиция','Цена','Match','Причина'], rows, 'Очередь пустая', 'review-table')}`;
  document.querySelectorAll('[data-review-id]').forEach(row => row.addEventListener('click', () => selectReviewItem(row.dataset.reviewId)));
}
$('reviewClinicFilter')?.addEventListener('input', renderReview);

$('reviewServiceBtn')?.addEventListener('click', async () => {
  const q = $('reviewServiceSearch').value.trim();
  if (!q) return;
  $('reviewServiceSelect').innerHTML = '<option>Ищу...</option>';
  const services = await api('/api/services?q=' + encodeURIComponent(q));
  $('reviewServiceSelect').innerHTML = services.length ? services.map(s => `<option value="${esc(s.service_id)}">${esc(s.service_name)} · ${esc(s.category || '')}</option>`).join('') : '<option value="">Ничего не найдено</option>';
});
async function applyReviewMatch() {
  if (!selectedReviewItemId || !$('reviewServiceSelect').value) return alert('Выбери позицию и услугу справочника');
  await api('/api/match', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ item_id: selectedReviewItemId, service_id: $('reviewServiceSelect').value }) });
  selectedReviewItemId = null;
  if ($('reviewSelected')) $('reviewSelected').textContent = 'Готово. Позиция ушла из ревью.';
  await loadUnmatched();
}
$('reviewServiceSelect')?.addEventListener('dblclick', applyReviewMatch);
$('applyReviewMatchBtn')?.addEventListener('click', applyReviewMatch);

function catalogSummary(data, fallbackTitle) {
  const services = data.services ?? data.total_services ?? data.imported ?? data.created ?? 0;
  const title = data.skipped_bootstrap ? 'Справочник уже загружен' : fallbackTitle;
  const details = services ? `${services} услуг в справочнике` : (data.message || 'Готово');
  return `<div class="card"><span class="badge ok">готово</span><div style="margin-top:10px"><b>${esc(title)}</b></div><div class="hint">${esc(details)}</div></div>`;
}
async function loadCatalogPreview() {
  if (!$('catalogPreviewList')) return;
  const q = ($('catalogSearchInput')?.value || '').trim();
  $('catalogPreviewList').innerHTML = '<div class="muted">Загружаю справочник...</div>';
  try {
    if (!lastStats) {
      try { lastStats = await api('/api/stats'); } catch (_) {}
    }
    const services = await api('/api/services' + (q ? ('?q=' + encodeURIComponent(q)) : ''));
    const rows = services.map(s => `<tr><td>${dash(s.source_code)}</td><td><b>${esc(s.service_name || '—')}</b></td><td>${dash(s.category)}</td><td>${dash(s.tarificatr_code)}</td></tr>`).join('');
    const total = lastStats?.services;
    if ($('catalogPreviewSummary')) $('catalogPreviewSummary').textContent = q ? `Найдено: ${services.length}` : `Показано ${services.length}${total ? ` из ${total}` : ''}. Если загружено несколько файлов, здесь уже объединённый справочник.`;
    $('catalogPreviewList').innerHTML = table(['Код','Услуга','Категория','Тарификатор'], rows, 'Справочник пустой', 'catalog-services-table');
  } catch(e) { $('catalogPreviewList').innerHTML = `<div class="card"><span class="badge bad">${esc(e.message)}</span></div>`; }
}
$('refreshCatalogPreviewBtn')?.addEventListener('click', loadCatalogPreview);
$('catalogSearchInput')?.addEventListener('input', () => { clearTimeout(catalogSearchTimer); catalogSearchTimer = setTimeout(loadCatalogPreview, 350); });
$('bootstrapBtn')?.addEventListener('click', async () => {
  const box = $('catalogResult');
  box.style.display = 'block';
  box.innerHTML = '<div class="muted">Проверяю справочник...</div>';
  try { box.innerHTML = catalogSummary(await api('/api/catalog/bootstrap', { method: 'POST' }), 'Справочник загружен'); await refreshStats(); loadCatalogPreview(); }
  catch(e) { box.innerHTML = `<div class="card"><span class="badge bad">${esc(e.message)}</span></div>`; }
});
$('catalogForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const file = $('catalogFile').files[0];
  const box = $('catalogResult');
  box.style.display = 'block';
  if (!file) { box.innerHTML = '<div class="card"><span class="badge warn">выбери файл</span></div>'; return; }
  const fd = new FormData(); fd.append('file', file);
  box.innerHTML = '<div class="muted">Импортирую справочник...</div>';
  try { box.innerHTML = catalogSummary(await api('/api/catalog/upload', { method:'POST', body: fd }), 'Справочник импортирован'); await refreshStats(); loadCatalogPreview(); }
  catch(e) { box.innerHTML = `<div class="card"><span class="badge bad">${esc(e.message)}</span></div>`; }
});

$('refreshStatsBtn')?.addEventListener('click', refreshStats);
setupDrop();
refreshStats();
activateTab('upload');
