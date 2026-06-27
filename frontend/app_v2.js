const $ = (id) => document.getElementById(id);
let currentJobTimer = null;
let selectedReviewItemId = null;
let allPartners = [];
let selectedPartnerId = null;
let lastReviewItems = [];

const pageMeta = {
  upload: ['Прайсы', 'Загрузка архивов и контроль обработки.'],
  partners: ['Партнёры', 'Клиники из загруженных прайсов.'],
  search: ['Поиск', 'Поиск цен по позициям партнёров.'],
  review: ['Ревью', 'Проблемные позиции и ручной match.'],
  stats: ['Статистика', 'Состояние базы.'],
  catalog: ['Справочник', 'Автозагрузка и ручной импорт.'],
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

function activateTab(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('tab-active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.hidden = p.id !== name);
  if ($('pageTitle')) $('pageTitle').textContent = pageMeta[name]?.[0] || name;
  if ($('pageNote')) $('pageNote').textContent = pageMeta[name]?.[1] || '';
  if (name === 'stats') refreshStats();
  if (name === 'partners') loadPartners();
  if (name === 'review') loadUnmatched();
}
document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => activateTab(btn.dataset.tab)));

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
    if (saved) {
      el.scrollTop = saved.top || 0;
      el.scrollLeft = saved.left || 0;
    }
  });
}

async function refreshStats() {
  try {
    const s = await api('/api/stats');
    const cards = [['Партнёры', s.partners], ['Справочник', s.services], ['Документы', s.documents], ['Позиции', s.price_items], ['На ревью', s.needs_review], ['Auto-match', (s.auto_normalization_percent ?? 0) + '%']];
    $('kpi').innerHTML = cards.map(([label, value]) => `<div class="metric"><div class="metric-label">${esc(label)}</div><div class="metric-value">${esc(value ?? 0)}</div></div>`).join('');
  } catch(e) { $('kpi').innerHTML = `<div class="card"><span class="badge bad">${esc(e.message)}</span></div>`; }
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
    catalog.addEventListener('change', () => {
      catalogHint.textContent = catalog.files?.[0]?.name || 'Файл не выбран';
    });
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
  root.innerHTML = `<div class="grid-3 job-metrics"><div class="metric"><div class="metric-label">Статус</div><div style="margin-top:8px">${badge(job.status)}</div></div><div class="metric"><div class="metric-label">Файлы</div><div class="metric-value">${job.processed_files || 0}/${job.total_files || 0}</div></div><div class="metric"><div class="metric-label">Позиции / ревью</div><div class="metric-value">${job.items_found || 0} / ${job.needs_review || 0}</div></div></div>${table(['Клиника','Год','Файл','Статус','Услуг','Ревью','Ошибка'], docRows, 'Нет файлов', 'docs-table')}<div class="section-gap"></div>${table(['Клиника','Услуга','Цена','Категория','Match','Статус'], itemRows, 'Позиции пока не извлечены', 'items-table')}`;
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
function reviewPassesFilter(item) {
  const q = ($('reviewClinicFilter')?.value || '').trim().toLowerCase();
  const maxConf = Number($('reviewMaxConfidence')?.value || 0);
  const lowOnly = Boolean($('reviewLowOnly')?.checked);
  const haystack = `${item.clinic_name || ''} ${item.standardized_name || ''} ${item.original_name || ''} ${item.note || ''}`.toLowerCase();
  if (q && !haystack.includes(q)) return false;
  if (maxConf > 0 && Number(item.confidence || 0) > maxConf) return false;
  if (lowOnly && !(Number(item.price) > 0 && Number(item.price) < 1000)) return false;
  return true;
}
function renderReview() {
  const filtered = (lastReviewItems || []).filter(reviewPassesFilter);
  const rows = filtered.map(i => `<tr><td><input type="radio" name="reviewItem" value="${esc(i.item_id)}"></td><td><b>${esc(i.clinic_name || '—')}</b></td><td>${esc(i.standardized_name || i.original_name)}</td><td>${money(i.price)}</td><td>${esc(i.confidence)}%</td><td>${dash(i.note)}</td></tr>`).join('');
  $('reviewResult').innerHTML = `<div class="hint" style="margin-bottom:10px">Показано ${filtered.length} из ${lastReviewItems.length}. Выбери строку, найди услугу справочника и нажми “Применить match”.</div>${table(['','Клиника','Услуга','Цена','Match','Причина'], rows, 'Очередь пустая', 'review-table')}`;
  document.querySelectorAll('input[name="reviewItem"]').forEach(r => r.addEventListener('change', e => selectedReviewItemId = e.target.value));
}
['reviewClinicFilter','reviewMaxConfidence','reviewLowOnly'].forEach(id => $(id)?.addEventListener('input', renderReview));

$('reviewServiceBtn')?.addEventListener('click', async () => {
  const q = $('reviewServiceSearch').value.trim();
  if (!q) return;
  const services = await api('/api/services?q=' + encodeURIComponent(q));
  $('reviewServiceSelect').innerHTML = services.map(s => `<option value="${esc(s.service_id)}">${esc(s.service_name)} · ${esc(s.category || '')}</option>`).join('');
});
async function applyReviewMatch() {
  if (!selectedReviewItemId || !$('reviewServiceSelect').value) return alert('Выбери позицию и услугу');
  await api('/api/match', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ item_id: selectedReviewItemId, service_id: $('reviewServiceSelect').value }) });
  selectedReviewItemId = null;
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
$('bootstrapBtn')?.addEventListener('click', async () => {
  const box = $('catalogResult');
  box.style.display = 'block';
  box.innerHTML = '<div class="muted">Проверяю справочник...</div>';
  try { box.innerHTML = catalogSummary(await api('/api/catalog/bootstrap', { method: 'POST' }), 'Справочник загружен'); refreshStats(); }
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
  try { box.innerHTML = catalogSummary(await api('/api/catalog/upload', { method:'POST', body: fd }), 'Справочник импортирован'); refreshStats(); }
  catch(e) { box.innerHTML = `<div class="card"><span class="badge bad">${esc(e.message)}</span></div>`; }
});

$('refreshStatsBtn')?.addEventListener('click', refreshStats);
setupDrop();
refreshStats();
activateTab('upload');
