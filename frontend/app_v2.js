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
function percent(v) { return v === null || v === undefined || v === '' ? '—' : `${Number(v).toFixed(Number(v) % 1 ? 1 : 0)}%`; }

function humanStatus(status) {
  return {
    pending: 'ожидает',
    queued: 'в очереди',
    processing: 'обработка',
    done: 'готово',
    needs_review: 'нужно проверить',
    error: 'ошибка',
    finished_with_errors: 'завершено с ошибками',
    interrupted: 'обработка прервана',
    cancelled: 'отменено',
    unknown: 'неизвестно',
  }[status] || String(status || 'неизвестно').replaceAll('_', ' ');
}

function humanReason(value) {
  const text = String(value || '').toLowerCase();
  if (!text || text === 'null' || text === 'undefined') return 'нужно проверить';
  if (text.includes('подозрительно') || text.includes('низкая цена') || text.includes('low_price')) return 'подозрительно низкая цена';
  if (text.includes('fuzzy_low_confidence') || text.includes('low_confidence')) return 'низкая уверенность';
  if (text.includes('unmatched') || text.includes('no_match') || text.includes('no_catalog') || text.includes('no_choices')) return 'нет совпадения';
  if (text.includes('needs_review')) return 'нужно проверить';
  if (text === 'manual') return 'проверено вручную';
  if (text === 'exact') return 'точное совпадение';
  if (text === 'fuzzy') return 'похожее совпадение';
  return String(value).replaceAll('_', ' ');
}

function humanError(value) {
  const text = String(value || '').trim();
  if (!text) return '—';
  return humanReason(text).replace('обработка прервана', 'обработка была прервана');
}

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (res.status === 401 && typeof window.showAuthModal === 'function') {
    window.showAuthModal();
  }
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
      <div class="panel-head"><div><h2 class="h1">Ревью</h2><p class="hint">Сомнительные строки: нет совпадения, низкая уверенность или странная цена.</p></div><button id="loadReviewBtn" class="btn btn-soft">Обновить</button></div>
      <div class="review-guide"><div class="review-step"><b>1. Выбери строку</b><span class="hint">Кликни по позиции в таблице.</span></div><div class="review-step"><b>2. Выбери кандидата</b><span class="hint">Система покажет лучшие варианты.</span></div><div class="review-step"><b>3. Примени совпадение</b><span class="hint">Позиция уйдёт из ревью.</span></div></div>
      <input id="reviewClinicFilter" class="input" placeholder="Фильтр по клинике, услуге или причине" style="margin-bottom:12px" />
      <input id="reviewMaxConfidence" type="hidden" value="" style="display:none" /><input id="reviewLowOnly" type="checkbox" style="display:none" />
      <div id="reviewSelected" class="review-selected hint">Позиция не выбрана.</div>
      <div class="review-match"><input id="reviewServiceSearch" class="input" placeholder="Услуга из справочника" /><button id="reviewServiceBtn" class="btn">Найти в справочнике</button></div>
      <div class="review-apply"><select id="reviewServiceSelect" class="input"></select><button id="applyReviewMatchBtn" class="btn btn-primary">Применить совпадение</button></div>
      <div id="reviewResult"></div>`;
  }

  const catalogPanel = $('catalog')?.querySelector('.panel');
  if (catalogPanel && !$('catalogPreviewList')) {
    catalogPanel.insertAdjacentHTML('beforeend', `
      <section class="catalog-preview">
        <div class="catalog-preview-head"><div><h3 class="h1">Загруженный справочник</h3><p id="catalogPreviewSummary" class="hint">Показываю справочник из базы.</p></div><input id="catalogSearchInput" class="input" placeholder="Найти в справочнике" /><button id="refreshCatalogPreviewBtn" class="btn btn-soft">Обновить</button></div>
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

function initTabs() {
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => activateTab(btn.dataset.tab)));
}

function setFileHint(input, hintId) {
  const hint = $(hintId);
  const files = [...(input?.files || [])];
  if (hint) hint.textContent = files.length ? files.map(f => f.name).join(', ') : hint.dataset.default || hint.textContent;
}

function statusBadge(status) {
  const cls = status === 'done' ? 'ok' : ['error', 'finished_with_errors', 'interrupted'].includes(status) ? 'bad' : 'warn';
  return `<span class="badge ${cls}">${esc(humanStatus(status))}</span>`;
}

function renderJob(job, keepScroll = true) {
  const box = $('uploadResult');
  if (!box) return;
  const scrollTop = keepScroll ? box.scrollTop : 0;
  box.style.display = 'block';
  const files = job.documents || [];
  const items = job.data || [];
  const progress = job.total_files ? Math.round((job.processed_files || 0) / job.total_files * 100) : 0;
  box.innerHTML = `
    <div class="panel-head"><div><h2 class="h1">Статус обработки</h2><p class="hint">ID обработки: ${esc(job.job_id)}</p></div>${statusBadge(job.status)}</div>
    <div class="grid-3 job-metrics">
      <div class="metric"><div class="metric-label">Файлы</div><div class="metric-value">${job.processed_files || 0}/${job.total_files || 0}</div></div>
      <div class="metric"><div class="metric-label">Позиции</div><div class="metric-value">${job.items_found || 0}</div></div>
      <div class="metric"><div class="metric-label">Проверка</div><div class="metric-value">${job.needs_review || 0}</div></div>
    </div>
    <div class="hint" style="margin-bottom:10px">Прогресс: ${progress}%</div>
    <div class="table-wrap docs-table"><table class="table"><thead><tr><th>Файл</th><th>Клиника</th><th>Статус</th><th>Услуг</th><th>Проверка</th><th>Комментарий</th></tr></thead><tbody>${files.map(f => `<tr><td>${esc(f.file_name)}</td><td>${esc(f.clinic_name)}</td><td>${statusBadge(f.status)}</td><td>${f.items || 0}</td><td>${f.review_items || 0}</td><td>${esc(humanError(f.error))}</td></tr>`).join('')}</tbody></table></div>
    ${items.length ? `<div class="section-gap"></div><h3 class="h1">Первые извлечённые позиции</h3><div class="table-wrap items-table"><table class="table"><thead><tr><th>Клиника</th><th>Услуга</th><th>Цена</th><th>Совпадение</th><th>Проверка</th></tr></thead><tbody>${items.map(i => `<tr><td>${esc(i.clinic_name)}</td><td>${esc(i.standardized_name || i.original_name)}</td><td>${money(i.price_resident_kzt)}</td><td>${percent(i.confidence)}</td><td>${i.needs_review ? '<span class="badge warn">нужно проверить</span>' : '<span class="badge ok">ок</span>'}</td></tr>`).join('')}</tbody></table></div>` : ''}
  `;
  if (keepScroll) box.scrollTop = scrollTop;
}

async function pollJob(jobId) {
  if (currentJobTimer) clearTimeout(currentJobTimer);
  try {
    const job = await api(`/api/jobs/${jobId}`);
    renderJob(job);
    if (['queued','processing'].includes(job.status)) currentJobTimer = setTimeout(() => pollJob(jobId), 1200);
    else {
      refreshStats(); loadPartners(); loadUnmatched();
    }
  } catch (e) {
    $('uploadResult').innerHTML += `<div class="card"><span class="badge bad">ошибка</span><div class="hint">${esc(humanError(e.message))}</div></div>`;
  }
}

async function handleUpload(e) {
  e.preventDefault();
  const files = $('priceFiles')?.files;
  if (!files || !files.length) return alert('Выбери файл или ZIP');
  const fd = new FormData();
  [...files].forEach(f => fd.append('files', f));
  fd.append('clinic_name', $('clinicName')?.value || 'Анонимный тест');
  if ($('effectiveDate')?.value) fd.append('effective_date', $('effectiveDate').value);
  $('uploadResult').style.display = 'block';
  $('uploadResult').innerHTML = `<div class="hint">Создаю очередь обработки...</div>`;
  try {
    const job = await api('/api/upload-async', { method:'POST', body:fd });
    renderJob(job, false);
    pollJob(job.job_id);
  } catch (err) {
    $('uploadResult').innerHTML = `<div class="card"><span class="badge bad">ошибка</span><div class="hint">${esc(humanError(err.message))}</div></div>`;
  }
}

async function refreshStats() {
  try {
    const s = await api('/api/stats'); lastStats = s;
    $('kpi').innerHTML = `
      <div class="metric"><div class="metric-label">Партнёры</div><div class="metric-value">${s.partners}</div></div>
      <div class="metric"><div class="metric-label">Позиции</div><div class="metric-value">${s.price_items}</div></div>
      <div class="metric"><div class="metric-label">Совпадение</div><div class="metric-value">${s.auto_normalization_percent}%</div></div>
      <div class="metric"><div class="metric-label">Справочник</div><div class="metric-value">${s.services}</div></div>
      <div class="metric"><div class="metric-label">Документы</div><div class="metric-value">${s.documents}</div></div>
      <div class="metric"><div class="metric-label">Проверка</div><div class="metric-value">${s.needs_review}</div></div>`;
  } catch (e) { if ($('kpi')) $('kpi').innerHTML = `<div class="card">${esc(humanError(e.message))}</div>`; }
}

async function bootstrapCatalog() {
  const target = $('catalogResult'); target.style.display = 'block'; target.innerHTML = '<div class="hint">Проверяю справочник...</div>';
  try {
    const data = await api('/api/catalog/bootstrap', { method:'POST' });
    target.innerHTML = `<div class="card"><span class="badge ok">готово</span><div style="margin-top:10px"><b>Справочник уже готов</b></div><div class="hint">${data.services || data.inserted || data.count || 0} услуг в базе.</div></div>`;
    loadCatalogPreview();
  }
  catch(e){ target.innerHTML = `<div class="card"><span class="badge bad">ошибка</span><div class="hint">${esc(humanError(e.message))}</div></div>`; }
}

async function uploadCatalog(e) {
  e.preventDefault();
  if (!$('catalogFile')?.files?.length) return alert('Выбери файл справочника');
  const fd = new FormData(); fd.append('file', $('catalogFile').files[0]);
  const target = $('catalogResult'); target.style.display = 'block'; target.innerHTML = '<div class="hint">Импортирую...</div>';
  try {
    const data = await api('/api/catalog/upload', { method:'POST', body:fd });
    target.innerHTML = `<div class="card"><span class="badge ok">готово</span><div style="margin-top:10px"><b>Справочник загружен</b></div><div class="hint">${data.services || data.inserted || data.count || 0} услуг в базе.</div></div>`;
    refreshStats(); loadCatalogPreview();
  }
  catch(e){ target.innerHTML = `<div class="card"><span class="badge bad">ошибка</span><div class="hint">${esc(humanError(e.message))}</div></div>`; }
}

async function loadPartners() {
  const list = $('partnersList'); if (!list) return;
  list.innerHTML = '<div class="hint" style="padding:16px">Загрузка...</div>';
  try { allPartners = await api('/api/partners?is_active=true'); renderPartners(); }
  catch(e){ list.innerHTML = `<div class="hint" style="padding:16px">${esc(humanError(e.message))}</div>`; }
}
function renderPartners() {
  const q = $('partnerFilter')?.value || '';
  const partners = allPartners.filter(p => ciMatch(q, p.name, p.city, p.bin));
  $('partnersList').innerHTML = partners.map(p => `<button class="partner-btn ${p.partner_id===selectedPartnerId?'active':''}" data-partner-id="${esc(p.partner_id)}"><b>${esc(p.name)}</b><div class="mini">${esc(p.city || 'город не указан')} · ${esc(p.bin || 'БИН —')}</div></button>`).join('') || '<div class="hint" style="padding:16px">Партнёры не найдены.</div>';
  document.querySelectorAll('.partner-btn').forEach(btn => btn.addEventListener('click', () => selectPartner(btn.dataset.partnerId)));
}
function ciMatch(q,...vals){ q=String(q||'').toLowerCase().replace('ё','е'); return !q || vals.some(v=>String(v||'').toLowerCase().replace('ё','е').includes(q)); }
async function selectPartner(id) {
  selectedPartnerId = id; renderPartners();
  const box = $('partnerDetails'); box.innerHTML = '<div class="hint">Загрузка услуг...</div>';
  try {
    const items = await api(`/api/partners/${id}/services`);
    const partner = allPartners.find(p => p.partner_id === id);
    box.innerHTML = `<div class="partner-detail-head"><h2 class="h1">${esc(partner?.name || 'Клиника')}</h2><p class="hint">${items.length} позиций</p></div><div class="table-wrap"><table class="table"><thead><tr><th>Услуга</th><th>Цена</th><th>Дата</th><th>Совпадение</th><th>Проверка</th></tr></thead><tbody>${items.map(i => `<tr><td>${esc(i.standardized_name || i.original_name)}</td><td>${money(i.price_resident_kzt)}</td><td>${dash(i.effective_date)}</td><td>${percent(i.confidence)}</td><td>${i.needs_review ? '<span class="badge warn">нужно проверить</span>' : '<span class="badge ok">ок</span>'}</td></tr>`).join('')}</tbody></table></div>`;
  } catch(e){ box.innerHTML = `<div class="hint">${esc(humanError(e.message))}</div>`; }
}

async function doSearch() {
  const q = $('searchInput').value.trim(); if (!q) return;
  const box = $('searchResult'); box.innerHTML = '<div class="hint">Ищу...</div>';
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    box.innerHTML = `<div class="grid-2"><div class="card"><b>Услуги в справочнике</b><div class="hint">${data.services.length} совпадений</div></div><div class="card"><b>Позиции прайсов</b><div class="hint">${data.prices.length} цен</div></div></div><div class="section-gap"></div><div class="table-wrap"><table class="table"><thead><tr><th>Клиника</th><th>Услуга</th><th>Цена</th><th>Дата</th><th>Совпадение</th></tr></thead><tbody>${data.prices.map(i => `<tr><td>${esc(i.clinic_name)}</td><td>${esc(i.standardized_name || i.original_name)}</td><td>${money(i.price_resident_kzt)}</td><td>${dash(i.effective_date)}</td><td>${percent(i.confidence)}</td></tr>`).join('')}</tbody></table></div>`;
  } catch(e){ box.innerHTML = `<div class="card">${esc(humanError(e.message))}</div>`; }
}

async function loadUnmatched() {
  const box = $('reviewResult'); if (!box) return;
  box.innerHTML = '<div class="hint">Загрузка ревью...</div>';
  try { lastReviewItems = await api('/api/unmatched'); renderReviewList(); }
  catch(e){ box.innerHTML = `<div class="card">${esc(humanError(e.message))}</div>`; }
}
function renderReviewList() {
  const q = $('reviewClinicFilter')?.value || '';
  const rows = lastReviewItems.filter(i => ciMatch(q, i.clinic_name, i.original_name, i.standardized_name, i.note, i.match_method));
  $('reviewResult').innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>Клиника</th><th>Исходная строка</th><th>Цена</th><th>Совпадение</th><th>Причина</th></tr></thead><tbody>${rows.map(i => `<tr class="review-row ${i.item_id===selectedReviewItemId?'selected':''}" data-item-id="${esc(i.item_id)}"><td>${esc(i.clinic_name)}</td><td>${esc(i.original_name)}</td><td>${money(i.price_resident_kzt)}</td><td>${percent(i.confidence)}</td><td>${esc(humanReason(i.note || i.match_method))}</td></tr>`).join('')}</tbody></table></div>`;
  document.querySelectorAll('.review-row').forEach(row => row.addEventListener('click', () => selectReviewItem(row.dataset.itemId)));
}
function selectReviewItem(id) {
  selectedReviewItemId = id; const item = lastReviewItems.find(i => i.item_id === id);
  if ($('reviewSelected')) $('reviewSelected').innerHTML = item ? `Выбрано: <b>${esc(item.original_name)}</b> · ${money(item.price_resident_kzt)} · ${esc(item.clinic_name)}` : 'Позиция не выбрана.';
  if (item && $('reviewServiceSearch')) $('reviewServiceSearch').value = item.original_name;
  renderReviewList(); searchReviewServices();
}
async function searchReviewServices() {
  const q = $('reviewServiceSearch')?.value?.trim(); if (!q) return;
  const select = $('reviewServiceSelect'); select.innerHTML = '<option>Ищу...</option>';
  try { const data = await api(`/api/services?q=${encodeURIComponent(q)}`); select.innerHTML = data.map(s => `<option value="${esc(s.service_id)}">${esc(s.service_name)}${s.category ? ' · ' + esc(s.category) : ''}</option>`).join('') || '<option value="">Нет совпадений</option>'; }
  catch(e){ select.innerHTML = `<option>${esc(humanError(e.message))}</option>`; }
}
async function applyReviewMatch() {
  if (!selectedReviewItemId) return alert('Сначала выбери строку ревью');
  const serviceId = $('reviewServiceSelect')?.value; if (!serviceId) return alert('Выбери услугу');
  try { await api('/api/match', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({item_id:selectedReviewItemId, service_id:serviceId}) }); selectedReviewItemId=null; await loadUnmatched(); refreshStats(); }
  catch(e){ alert(humanError(e.message)); }
}

async function loadCatalogPreview() {
  const box = $('catalogPreviewList'); if (!box) return;
  const q = $('catalogSearchInput')?.value.trim() || '';
  box.innerHTML = '<div class="hint">Загрузка справочника...</div>';
  try { const data = await api('/api/services' + (q ? `?q=${encodeURIComponent(q)}` : '')); $('catalogPreviewSummary').textContent = `Показано ${data.length} услуг. Поиск работает по названию, коду и категории.`; box.innerHTML = `<div class="table-wrap catalog-services-table"><table class="table"><thead><tr><th>Код</th><th>Название</th><th>Категория</th><th>Тарификатор</th></tr></thead><tbody>${data.map(s => `<tr><td>${dash(s.source_code)}</td><td>${esc(s.service_name)}</td><td>${dash(s.category)}</td><td>${dash(s.tarificatr_code)}</td></tr>`).join('')}</tbody></table></div>`; }
  catch(e){ box.innerHTML = `<div class="card">${esc(humanError(e.message))}</div>`; }
}

function init() {
  applyRuntimeUiTweaks(); initTabs(); refreshStats();
  $('priceForm')?.addEventListener('submit', handleUpload);
  $('priceFiles')?.addEventListener('change', e => setFileHint(e.target, 'priceFileHint'));
  $('catalogFile')?.addEventListener('change', e => setFileHint(e.target, 'catalogFileHint'));
  $('bootstrapBtn')?.addEventListener('click', bootstrapCatalog);
  $('catalogForm')?.addEventListener('submit', uploadCatalog);
  $('refreshStatsBtn')?.addEventListener('click', refreshStats);
  $('refreshPartnersBtn')?.addEventListener('click', loadPartners);
  $('partnerFilter')?.addEventListener('input', renderPartners);
  $('searchBtn')?.addEventListener('click', doSearch);
  $('searchInput')?.addEventListener('keydown', e => { if (e.key==='Enter') doSearch(); });
  $('loadReviewBtn')?.addEventListener('click', loadUnmatched);
  $('reviewClinicFilter')?.addEventListener('input', renderReviewList);
  $('reviewServiceBtn')?.addEventListener('click', searchReviewServices);
  $('reviewServiceSearch')?.addEventListener('keydown', e => { if (e.key==='Enter') searchReviewServices(); });
  $('applyReviewMatchBtn')?.addEventListener('click', applyReviewMatch);
  $('refreshCatalogPreviewBtn')?.addEventListener('click', loadCatalogPreview);
  $('catalogSearchInput')?.addEventListener('input', () => { clearTimeout(catalogSearchTimer); catalogSearchTimer = setTimeout(loadCatalogPreview, 250); });
}

document.addEventListener('DOMContentLoaded', init);
