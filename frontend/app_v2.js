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
  review: ['Ревью', 'Очередь ручной проверки.'],
  stats: ['Статистика', 'Состояние базы.'],
  catalog: ['Справочник', 'Импорт и автозагрузка справочника услуг.'],
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
}
function money(v) { return v == null ? '—' : Number(v).toLocaleString('ru-RU') + ' ₸'; }
function yearFrom(v) { const m = String(v || '').match(/\b(20\d{2})\b/); return m ? m[1] : '—'; }

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
  if (status === 'done') return '<span class="badge ok">готово</span>';
  if (status === 'needs_review') return '<span class="badge warn">ревью</span>';
  if (status === 'processing') return '<span class="badge warn">обработка</span>';
  if (status === 'pending') return '<span class="badge">ожидает</span>';
  if (status === 'error') return '<span class="badge bad">ошибка</span>';
  return `<span class="badge">${esc(status || '—')}</span>`;
}
function itemStatus(item) { return item.needs_review ? '<span class="badge warn">ревью</span>' : '<span class="badge ok">ok</span>'; }
function table(headers, rows, empty = 'Ничего') {
  return `<div class="table-wrap"><table class="table"><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="muted">${esc(empty)}</td></tr>`}</tbody></table></div>`;
}

async function refreshStats() {
  try {
    const s = await api('/api/stats');
    const cards = [['Партнёры', s.partners], ['Справочник', s.services], ['Документы', s.documents], ['Позиции', s.price_items], ['На ревью', s.needs_review], ['Auto-match', (s.auto_normalization_percent ?? 0) + '%']];
    $('kpi').innerHTML = cards.map(([label, value]) => `<div class="metric"><div class="metric-label">${esc(label)}</div><div class="metric-value">${esc(value ?? 0)}</div></div>`).join('');
  } catch(e) { $('kpi').innerHTML = `<div class="card bad">${esc(e.message)}</div>`; }
}

function setupDrop() {
  const input = $('priceFiles'), hint = $('filePickHint'), drop = $('dropZone');
  if (!input || !hint || !drop) return;
  const refreshHint = () => {
    const files = Array.from(input.files || []);
    hint.textContent = files.length ? files.map(f => f.name).join(' · ') : 'ZIP, PDF, DOCX, XLSX, XLS';
  };
  input.addEventListener('change', refreshHint);
  ['dragenter','dragover'].forEach(evt => drop.addEventListener(evt, e => { e.preventDefault(); drop.style.borderColor = '#4f46e5'; }));
  ['dragleave','drop'].forEach(evt => drop.addEventListener(evt, e => { e.preventDefault(); drop.style.borderColor = '#b7bdd0'; }));
  drop.addEventListener('drop', e => { input.files = e.dataTransfer.files; input.dispatchEvent(new Event('change')); });
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
    renderJob(job);
    pollJob(job.job_id);
  } catch(e) { $('uploadResult').innerHTML = `<div class="bad">${esc(e.message)}</div>`; }
});

async function pollJob(jobId) {
  currentJobTimer = setInterval(async () => {
    try {
      const job = await api('/api/jobs/' + encodeURIComponent(jobId));
      renderJob(job);
      if (['done','finished_with_errors','error'].includes(job.status)) {
        clearInterval(currentJobTimer);
        loadPartners();
        refreshStats();
      }
    } catch(e) {
      clearInterval(currentJobTimer);
      $('uploadResult').insertAdjacentHTML('afterbegin', `<div class="bad">${esc(e.message)}</div>`);
    }
  }, 2000);
}

function renderJob(job) {
  $('uploadResult').style.display = 'block';
  const docs = job.documents || [];
  const docRows = docs.map(doc => `<tr><td><b>${esc(doc.clinic_name || '—')}</b></td><td>${esc(yearFrom(doc.file_name))}</td><td>${esc(doc.file_name || '—')}</td><td>${badge(doc.status)}</td><td>${doc.items ?? 0}</td><td><b>${doc.review_items ?? 0}</b></td><td class="bad">${esc(doc.error || '')}</td></tr>`).join('');
  const items = [], seen = new Set();
  for (const item of job.data || []) {
    const key = `${item.clinic_name}|${item.standardized_name || item.original_name}|${item.price}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= 200) break;
  }
  const itemRows = items.map(item => `<tr><td><b>${esc(item.clinic_name || '—')}</b></td><td>${esc(item.standardized_name || item.original_name)}</td><td>${money(item.price)}</td><td>${esc(item.category || '—')}</td><td>${esc(item.confidence)}%</td><td>${itemStatus(item)}</td></tr>`).join('');
  $('uploadResult').innerHTML = `<div class="grid-3" style="margin-bottom:12px"><div class="metric"><div class="metric-label">Статус</div><div style="margin-top:8px">${badge(job.status)}</div></div><div class="metric"><div class="metric-label">Файлы</div><div class="metric-value">${job.processed_files || 0}/${job.total_files || 0}</div></div><div class="metric"><div class="metric-label">Позиции / ревью</div><div class="metric-value">${job.items_found || 0} / ${job.needs_review || 0}</div></div></div>${table(['Клиника','Год','Файл','Статус','Услуг','Ревью','Ошибка'], docRows, 'Нет файлов')}<div class="section-gap"></div>${table(['Клиника','Услуга','Цена','Категория','Match','Статус'], itemRows, 'Позиции пока не извлечены')}`;
}

async function loadPartners() {
  try { allPartners = await api('/api/partners'); renderPartners(); }
  catch(e) { $('partnersList').innerHTML = `<div class="bad">${esc(e.message)}</div>`; }
}
function renderPartners() {
  const filter = ($('partnerFilter')?.value || '').toLowerCase();
  const partners = (allPartners || []).filter(p => String(p.name || '').toLowerCase().includes(filter));
  $('partnersList').innerHTML = partners.map(p => `<button class="partner-btn ${p.partner_id === selectedPartnerId ? 'active' : ''}" data-partner-id="${esc(p.partner_id)}"><b>${esc(p.name)}</b><div class="mini">${p.is_active === false ? 'неактивен' : 'активен'}</div></button>`).join('') || '<div class="muted">Пока нет клиник.</div>';
  document.querySelectorAll('[data-partner-id]').forEach(btn => btn.addEventListener('click', () => selectPartner(btn.dataset.partnerId)));
}
async function selectPartner(partnerId) {
  selectedPartnerId = partnerId;
  renderPartners();
  const partner = allPartners.find(p => p.partner_id === partnerId);
  $('partnerDetails').innerHTML = '<div class="muted">Загружаю услуги...</div>';
  try {
    const items = await api('/api/partners/' + encodeURIComponent(partnerId) + '/services');
    const rows = items.map(i => `<tr><td>${esc(i.standardized_name || i.original_name)}</td><td>${money(i.price)}</td><td>${esc(i.category || '—')}</td><td>${esc(i.confidence)}%</td><td>${itemStatus(i)}</td><td>${esc(i.effective_date || '—')}</td></tr>`).join('');
    $('partnerDetails').innerHTML = `<div class="panel-head" style="margin-bottom:10px"><div><div class="h1" style="font-size:20px">${esc(partner?.name || 'Клиника')}</div><div class="hint">${items.length} позиций</div></div></div>${table(['Услуга','Цена','Категория','Match','Статус','Дата'], rows, 'У этой клиники пока нет услуг')}`;
  } catch(e) { $('partnerDetails').innerHTML = `<div class="bad">${esc(e.message)}</div>`; }
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
    $('searchResult').innerHTML = table(['Клиника','Услуга','Цена','Категория','Match','Статус'], rows, 'Ничего не найдено');
  } catch(e) { $('searchResult').innerHTML = `<div class="bad">${esc(e.message)}</div>`; }
}

$('loadReviewBtn')?.addEventListener('click', loadUnmatched);
async function loadUnmatched() {
  $('reviewResult').innerHTML = '<div class="muted">Загружаю...</div>';
  try { lastReviewItems = await api('/api/unmatched'); renderReview(); }
  catch(e) { $('reviewResult').innerHTML = `<div class="bad">${esc(e.message)}</div>`; }
}
function reviewPassesFilter(item) {
  const clinic = ($('reviewClinicFilter')?.value || '').trim().toLowerCase();
  const maxConf = Number($('reviewMaxConfidence')?.value || 0);
  const lowOnly = Boolean($('reviewLowOnly')?.checked);
  if (clinic && !String(item.clinic_name || '').toLowerCase().includes(clinic)) return false;
  if (maxConf > 0 && Number(item.confidence || 0) > maxConf) return false;
  if (lowOnly && !(Number(item.price) > 0 && Number(item.price) < 1000)) return false;
  return true;
}
function renderReview() {
  const filtered = (lastReviewItems || []).filter(reviewPassesFilter);
  const rows = filtered.map(i => `<tr><td><input type="radio" name="reviewItem" value="${esc(i.item_id)}"></td><td><b>${esc(i.clinic_name || '—')}</b></td><td>${esc(i.standardized_name || i.original_name)}</td><td>${money(i.price)}</td><td>${esc(i.confidence)}%</td><td>${esc(i.note || '')}</td></tr>`).join('');
  $('reviewResult').innerHTML = `<div class="hint" style="margin-bottom:10px">Показано ${filtered.length} из ${lastReviewItems.length}</div>${table(['','Клиника','Услуга','Цена','Match','Причина'], rows, 'Очередь пустая')}`;
  document.querySelectorAll('input[name="reviewItem"]').forEach(r => r.addEventListener('change', e => selectedReviewItemId = e.target.value));
}
['reviewClinicFilter','reviewMaxConfidence','reviewLowOnly'].forEach(id => $(id)?.addEventListener('input', renderReview));

$('reviewServiceBtn')?.addEventListener('click', async () => {
  const q = $('reviewServiceSearch').value.trim();
  if (!q) return;
  const services = await api('/api/services?q=' + encodeURIComponent(q));
  $('reviewServiceSelect').innerHTML = services.map(s => `<option value="${esc(s.service_id)}">${esc(s.service_name)} · ${esc(s.category || '')}</option>`).join('');
});
$('reviewServiceSelect')?.addEventListener('dblclick', async () => {
  if (!selectedReviewItemId || !$('reviewServiceSelect').value) return alert('Выбери позицию и услугу');
  await api('/api/match', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ item_id: selectedReviewItemId, service_id: $('reviewServiceSelect').value }) });
  selectedReviewItemId = null;
  await loadUnmatched();
});

$('bootstrapBtn')?.addEventListener('click', async () => {
  const box = $('catalogResult');
  box.style.display = 'block';
  try { box.textContent = JSON.stringify(await api('/api/catalog/bootstrap', { method: 'POST' }), null, 2); refreshStats(); }
  catch(e) { box.textContent = e.message; }
});
$('catalogForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const file = $('catalogFile').files[0];
  if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  const box = $('catalogResult'); box.style.display = 'block';
  try { box.textContent = JSON.stringify(await api('/api/catalog/upload', { method:'POST', body: fd }), null, 2); refreshStats(); }
  catch(e) { box.textContent = e.message; }
});

$('refreshStatsBtn')?.addEventListener('click', refreshStats);
setupDrop();
refreshStats();
activateTab('upload');
