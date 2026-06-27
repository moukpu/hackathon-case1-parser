const $ = (id) => document.getElementById(id);
let selectedReviewItemId = null;
let currentJobTimer = null;

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
}

function money(v) {
  return v == null ? '—' : Number(v).toLocaleString('ru-RU') + ' ₸';
}

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data.raw || res.statusText));
  return data;
}

function showJson(el, data) {
  el.classList.remove('hidden');
  el.textContent = JSON.stringify(data, null, 2);
}

async function refreshStats() {
  try {
    const s = await api('/api/stats');
    const cards = [
      ['Партнёры', s.partners], ['Справочник', s.services], ['Документы', s.documents], ['Позиции', s.price_items], ['На ревью', s.needs_review]
    ];
    $('kpi').innerHTML = cards.map(([label, value]) => `<div class="glass rounded-3xl p-5 shadow-sm"><div class="text-xs font-bold uppercase tracking-wide text-slate-400">${label}</div><div class="text-3xl font-extrabold text-slate-950 mt-1">${value ?? 0}</div></div>`).join('');
  } catch (e) {
    $('kpi').innerHTML = `<div class="col-span-full bg-red-50 border border-red-100 text-red-700 rounded-2xl p-4">Stats error: ${esc(e.message)}</div>`;
  }
}

async function refreshAll() { await refreshStats(); }

function activateTab(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('tab-active'));
  document.querySelector(`[data-tab="${name}"]`)?.classList.add('tab-active');
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  $(name).classList.remove('hidden');
  if (name === 'review') loadUnmatched();
}

document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => activateTab(btn.dataset.tab)));
$('refreshBtn').addEventListener('click', refreshAll);

$('bootstrapBtn').addEventListener('click', async () => {
  $('bootstrapBtn').disabled = true;
  try {
    const data = await api('/api/catalog/bootstrap', { method: 'POST' });
    showJson($('catalogResult'), data);
    await refreshStats();
  } catch (e) { showJson($('catalogResult'), { error: e.message }); }
  finally { $('bootstrapBtn').disabled = false; }
});

$('catalogForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('catalogFile').files[0];
  const fd = new FormData();
  fd.append('file', file);
  try {
    const data = await api('/api/catalog/upload', { method: 'POST', body: fd });
    showJson($('catalogResult'), data);
    await refreshStats();
  } catch (e) { showJson($('catalogResult'), { error: e.message }); }
});

$('priceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (currentJobTimer) clearInterval(currentJobTimer);
  const box = $('uploadResult');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="p-5 rounded-2xl bg-white/80 border border-slate-100 font-bold">Загружаю архив и создаю очередь файлов...</div>';
  const fd = new FormData();
  fd.append('clinic_name', $('clinicName').value || 'Demo Clinic');
  if ($('effectiveDate').value) fd.append('effective_date', $('effectiveDate').value);
  Array.from($('priceFiles').files).forEach(f => fd.append('files', f));
  try {
    const job = await api('/api/upload-async', { method: 'POST', body: fd });
    renderJob(job);
    pollJob(job.job_id);
  } catch (e) {
    box.innerHTML = `<div class="p-5 rounded-2xl bg-red-50 border border-red-100 text-red-700">${esc(e.message)}</div>`;
  }
});

async function pollJob(jobId) {
  currentJobTimer = setInterval(async () => {
    try {
      const job = await api('/api/jobs/' + encodeURIComponent(jobId));
      renderJob(job);
      await refreshStats();
      if (['done', 'finished_with_errors', 'error'].includes(job.status)) clearInterval(currentJobTimer);
    } catch (e) {
      clearInterval(currentJobTimer);
      $('uploadResult').insertAdjacentHTML('afterbegin', `<div class="mb-4 p-4 rounded-2xl bg-red-50 border border-red-100 text-red-700">Polling error: ${esc(e.message)}</div>`);
    }
  }, 2000);
}

function statusBadge(status) {
  if (status === 'done') return '<span class="text-emerald-600 font-bold">done</span>';
  if (status === 'needs_review') return '<span class="text-amber-600 font-bold">review</span>';
  if (status === 'processing') return '<span class="text-indigo-600 font-bold">processing...</span>';
  if (status === 'pending') return '<span class="text-slate-500 font-bold">pending</span>';
  if (status === 'error') return '<span class="text-red-600 font-bold">error</span>';
  return `<span class="text-slate-500 font-bold">${esc(status || '—')}</span>`;
}

function progressText(job) {
  return `${job.processed_files || 0}/${job.total_files || 0} файлов · ${job.items_found || 0} услуг · ${job.needs_review || 0} на ревью`;
}

function renderJob(job) {
  const docs = job.documents || [];
  const docRows = docs.map(doc => `<tr class="border-t border-slate-100 align-top"><td class="px-4 py-3 font-medium">${esc(doc.clinic_name || '—')}</td><td class="px-4 py-3 max-w-xl break-all">${esc(doc.file_name || '—')}</td><td class="px-4 py-3">${statusBadge(doc.status)}</td><td class="px-4 py-3">${doc.items ?? 0}</td><td class="px-4 py-3 text-red-600 text-xs">${esc(doc.error || '')}</td></tr>`).join('');
  const rows = (job.data || []).slice(0, 200).map(item => `<tr class="border-t border-slate-100"><td class="px-4 py-3 font-medium">${esc(item.standardized_name || item.original_name)}</td><td class="px-4 py-3">${money(item.price)}</td><td class="px-4 py-3">${esc(item.category || '—')}</td><td class="px-4 py-3">${esc(item.confidence)}%</td><td class="px-4 py-3">${item.needs_review ? '<span class="text-amber-600 font-bold">review</span>' : '<span class="text-emerald-600 font-bold">ok</span>'}</td></tr>`).join('');
  const partners = (job.partners_detected || []).join(', ');
  const activeHint = ['queued', 'processing'].includes(job.status) ? '<div class="mb-4 p-4 rounded-2xl bg-indigo-50 border border-indigo-100 text-indigo-800"><b>Идёт обработка.</b> Таблица ниже обновляется автоматически каждые 2 секунды.</div>' : '';
  const emptyHint = job.items_found === 0 && !['queued', 'processing'].includes(job.status) ? '<div class="mb-4 p-4 rounded-2xl bg-amber-50 border border-amber-100 text-amber-800"><b>Найдено 0 услуг.</b> Смотри таблицу файлов: там видно, где скан, ошибка чтения или AI не вернул позиции.</div>' : '';

  $('uploadResult').innerHTML = `${activeHint}${emptyHint}
    <div class="grid md:grid-cols-4 gap-4 mb-4">
      <div class="bg-white/80 border border-slate-100 rounded-2xl p-4"><b>Статус job:</b><br>${statusBadge(job.status)}</div>
      <div class="bg-white/80 border border-slate-100 rounded-2xl p-4"><b>Прогресс:</b><br>${esc(progressText(job))}</div>
      <div class="bg-white/80 border border-slate-100 rounded-2xl p-4"><b>Job ID:</b><br><span class="text-xs break-all">${esc(job.job_id || '—')}</span></div>
      <div class="bg-white/80 border border-slate-100 rounded-2xl p-4"><b>Клиники:</b><br><span class="text-xs">${esc(partners || '—')}</span></div>
    </div>
    <div class="mb-5 overflow-auto bg-white/80 rounded-2xl border border-slate-100"><div class="px-4 py-3 font-bold">Live-статус файлов внутри ZIP</div><table class="w-full text-sm"><thead><tr class="text-left text-slate-500"><th class="px-4 py-3">Клиника</th><th class="px-4 py-3">Файл</th><th class="px-4 py-3">Статус</th><th class="px-4 py-3">Услуг</th><th class="px-4 py-3">Ошибка</th></tr></thead><tbody>${docRows || '<tr><td class="p-4 text-slate-500" colspan="5">Нет файлов</td></tr>'}</tbody></table></div>
    <div class="overflow-auto bg-white/80 rounded-2xl border border-slate-100"><div class="px-4 py-3 font-bold">Извлечённые позиции, первые 200</div><table class="w-full text-sm"><thead><tr class="text-left text-slate-500"><th class="px-4 py-3">Услуга</th><th class="px-4 py-3">Цена</th><th class="px-4 py-3">Категория</th><th class="px-4 py-3">Match</th><th class="px-4 py-3">Статус</th></tr></thead><tbody>${rows || '<tr><td class="p-4 text-slate-500" colspan="5">Позиции пока не извлечены</td></tr>'}</tbody></table></div>`;
}

$('searchBtn').addEventListener('click', doSearch);
$('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
async function doSearch() {
  const q = $('searchInput').value.trim();
  if (!q) return;
  $('searchResult').innerHTML = '<div class="p-4 bg-white/80 rounded-2xl">Ищу...</div>';
  try {
    const data = await api('/api/search?q=' + encodeURIComponent(q));
    const services = (data.services || []).map(s => `<li class="p-3 border-b border-slate-100"><b>${esc(s.service_name)}</b><br><span class="text-slate-500">${esc(s.category || '')} · ${esc(s.source_code || '')}</span></li>`).join('');
    const prices = (data.prices || []).map(p => `<tr class="border-t border-slate-100"><td class="px-4 py-3">${esc(p.clinic_name)}</td><td class="px-4 py-3">${esc(p.standardized_name)}</td><td class="px-4 py-3">${money(p.price)}</td><td class="px-4 py-3">${esc(p.confidence)}%</td></tr>`).join('');
    $('searchResult').innerHTML = `<div class="grid md:grid-cols-2 gap-5"><div class="bg-white/80 rounded-2xl border border-slate-100 overflow-hidden"><div class="p-4 font-bold">Услуги справочника</div><ul>${services || '<li class="p-4 text-slate-500">Ничего</li>'}</ul></div><div class="bg-white/80 rounded-2xl border border-slate-100 overflow-auto"><div class="p-4 font-bold">Цены партнёров</div><table class="w-full text-sm"><tbody>${prices || '<tr><td class="p-4 text-slate-500">Ничего</td></tr>'}</tbody></table></div></div>`;
  } catch(e) { $('searchResult').innerHTML = `<div class="p-4 bg-red-50 text-red-700 rounded-2xl">${esc(e.message)}</div>`; }
}

$('loadReviewBtn').addEventListener('click', loadUnmatched);
async function loadUnmatched() {
  $('reviewResult').innerHTML = '<div class="p-4 bg-white/80 rounded-2xl">Загрузка...</div>';
  try {
    const items = await api('/api/unmatched');
    if (!items.length) { $('reviewResult').innerHTML = '<div class="p-4 bg-emerald-50 text-emerald-700 rounded-2xl">Очередь пустая ✅</div>'; return; }
    $('reviewResult').innerHTML = items.map(item => `<div class="bg-white/80 rounded-2xl border border-slate-100 p-4 mb-3"><div class="flex flex-col md:flex-row md:justify-between gap-3"><div><div class="font-extrabold">${esc(item.original_name)}</div><div class="text-sm text-slate-500">${esc(item.clinic_name)} · ${money(item.price)} · confidence ${esc(item.confidence)}% · ${esc(item.match_method)}</div><div class="text-xs text-amber-700 mt-1">${esc(item.note || '')}</div></div><button data-item="${item.item_id}" class="select-review px-4 py-2 rounded-xl bg-indigo-600 text-white font-bold">Выбрать</button></div></div>`).join('');
    document.querySelectorAll('.select-review').forEach(btn => btn.addEventListener('click', () => { selectedReviewItemId = btn.dataset.item; alert('Позиция выбрана. Найди услугу справочника сверху и подтверди match.'); }));
  } catch(e) { $('reviewResult').innerHTML = `<div class="p-4 bg-red-50 text-red-700 rounded-2xl">${esc(e.message)}</div>`; }
}

$('reviewServiceBtn').addEventListener('click', async () => {
  const q = $('reviewServiceSearch').value.trim();
  if (!q) return;
  const data = await api('/api/services?q=' + encodeURIComponent(q));
  $('reviewServiceSelect').innerHTML = '<option value="">Выбери услугу...</option>' + data.map(s => `<option value="${s.service_id}">${esc(s.service_name)} · ${esc(s.category || '')}</option>`).join('');
});

$('reviewServiceSelect').addEventListener('change', async () => {
  if (!selectedReviewItemId || !$('reviewServiceSelect').value) return;
  try {
    await api('/api/match', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ item_id:selectedReviewItemId, service_id:$('reviewServiceSelect').value }) });
    selectedReviewItemId = null;
    await loadUnmatched();
    await refreshStats();
  } catch(e) { alert(e.message); }
});

refreshAll();
