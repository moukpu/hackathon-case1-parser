(function loadAuthUi() {
  if (document.getElementById('authUiScript')) return;
  const script = document.createElement('script');
  script.id = 'authUiScript';
  script.src = '/frontend/auth_ui.js';
  document.head.appendChild(script);
})();

const clearBtn = document.getElementById('clearDbBtn');
const clearResult = document.getElementById('clearDbResult');
let clearResultHideTimer = null;

function currentUploadLooksActive() {
  const uploadResult = document.getElementById('uploadResult');
  if (!uploadResult || uploadResult.style.display === 'none') return false;
  const text = uploadResult.textContent.toLowerCase();
  return text.includes('обработка') || text.includes('ожидает') || text.includes('создаю очередь');
}

function capturePageScroll() {
  return { x: window.scrollX || 0, y: window.scrollY || 0 };
}

function restorePageScroll(position) {
  if (!position) return;
  requestAnimationFrame(() => window.scrollTo(position.x, position.y));
}

function showClearResult(html, { autoHide = false } = {}) {
  if (!clearResult) return;
  clearTimeout(clearResultHideTimer);
  clearResult.innerHTML = html;
  if (autoHide) {
    clearResultHideTimer = setTimeout(() => {
      clearResult.innerHTML = '';
    }, 6500);
  }
}

async function readResponseSafely(res) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { detail: text }; }
}

function uiEsc(value) {
  return String(value ?? '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
}

function formatHistoryDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 16);
  return d.toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
}

function uiStatusLabel(status, label) {
  if (label && !String(label).includes('_')) return label;
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
  }[status] || String(label || status || 'неизвестно').replaceAll('_', ' ');
}

clearBtn?.addEventListener('click', async () => {
  if (currentUploadLooksActive()) {
    showClearResult('<div class="card"><span class="badge warn">подожди</span><div class="hint" style="margin-top:10px">Нельзя чистить базу, пока идёт обработка файлов. Дождись статуса “готово”.</div></div>');
    return;
  }

  const ok = confirm('Очистить загруженные прайсы, документы, партнёров и историю обработок? Справочник услуг останется.');
  if (!ok) return;

  clearBtn.disabled = true;
  showClearResult('<div class="hint">Очищаю прайсы...</div>');

  try {
    const res = await fetch('/api/admin/clear-prices', { method: 'POST' });
    const data = await readResponseSafely(res);
    if (!res.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : 'Не удалось очистить прайсы';
      throw new Error(detail || `HTTP ${res.status}`);
    }

    showClearResult(
      `<div class="card"><span class="badge ok">готово</span><div style="margin-top:10px"><b>Прайсы очищены</b></div><div class="hint">Удалено позиций: ${data.deleted_price_items || 0}, документов: ${data.deleted_documents || 0}, партнёров: ${data.deleted_partners || 0}. Справочник сохранён: ${data.services || 0} услуг.</div></div>`,
      { autoHide: true },
    );

    localStorage.removeItem('lastJobId');
    if (typeof refreshStats === 'function') refreshStats();
    if (typeof loadUploadHistory === 'function') loadUploadHistory();
    const uploadResult = document.getElementById('uploadResult');
    if (uploadResult) {
      uploadResult.style.display = 'none';
      uploadResult.innerHTML = '';
    }
  } catch (e) {
    showClearResult(`<div class="card"><span class="badge bad">ошибка</span><div class="hint" style="margin-top:10px">${uiEsc(e.message || e)}</div></div>`);
  } finally {
    clearBtn.disabled = false;
  }
});

function ensureExportStyles() {
  if (document.getElementById('exportUiStyles')) return;
  const style = document.createElement('style');
  style.id = 'exportUiStyles';
  style.textContent = `
    .export-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:flex-end}
    .export-actions .btn{height:36px;padding:0 14px}
    .export-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 16px;padding:12px 14px;background:#f4f1ed;border:1px solid #e5e0d8;border-radius:8px}
    .history-panel{margin-top:24px}.history-files{font-size:13px;color:var(--secondary);margin-top:6px}.history-actions{display:flex;gap:8px;flex-wrap:wrap}.history-row-main{font-weight:600}.history-muted{color:var(--secondary);font-size:13px}
    @media(max-width:768px){.export-row{align-items:flex-start;flex-direction:column}.export-actions,.history-actions{justify-content:flex-start}}
  `;
  document.head.appendChild(style);
}

async function downloadExport(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const data = await readResponseSafely(res);
      const detail = typeof data.detail === 'string' ? data.detail : 'Экспорт пока недоступен для этой обработки';
      alert(detail);
      return;
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const filename = match ? match[1] : 'export';
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = filename;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
  } catch (e) {
    alert(String(e.message || e));
  }
}

function createExportActions(buttons) {
  const wrap = document.createElement('div');
  wrap.className = 'export-actions';
  buttons.forEach(({ label, onClick }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-soft';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    wrap.appendChild(btn);
  });
  return wrap;
}

function ensureSearchExportButtons() {
  const head = document.querySelector('#search .panel-head');
  if (!head || head.dataset.exportReady) return;
  head.dataset.exportReady = '1';
  head.appendChild(createExportActions([
    { label: 'CSV', onClick: () => {
      const q = document.getElementById('searchInput')?.value.trim();
      if (!q) return alert('Сначала введи запрос поиска');
      downloadExport('/api/export/search.csv?q=' + encodeURIComponent(q));
    }},
    { label: 'XLSX', onClick: () => {
      const q = document.getElementById('searchInput')?.value.trim();
      if (!q) return alert('Сначала введи запрос поиска');
      downloadExport('/api/export/search.xlsx?q=' + encodeURIComponent(q));
    }},
  ]));
}

function ensureReviewExportButtons() {
  const head = document.querySelector('#review .panel-head');
  if (!head || head.dataset.exportReady) return;
  head.dataset.exportReady = '1';
  head.appendChild(createExportActions([
    { label: 'CSV', onClick: () => downloadExport('/api/export/review.csv') },
    { label: 'XLSX', onClick: () => downloadExport('/api/export/review.xlsx') },
  ]));
}

function getActivePartnerId() {
  return document.querySelector('[data-partner-id].active')?.dataset.partnerId || null;
}

function ensurePartnerExportButtons() {
  const head = document.querySelector('#partnerDetails .partner-detail-head');
  if (!head || head.dataset.exportReady) return;
  head.dataset.exportReady = '1';
  head.appendChild(createExportActions([
    { label: 'CSV', onClick: () => {
      const partnerId = getActivePartnerId();
      if (!partnerId) return alert('Сначала выбери клинику');
      downloadExport('/api/export/partners/' + encodeURIComponent(partnerId) + '/services.csv');
    }},
    { label: 'XLSX', onClick: () => {
      const partnerId = getActivePartnerId();
      if (!partnerId) return alert('Сначала выбери клинику');
      downloadExport('/api/export/partners/' + encodeURIComponent(partnerId) + '/services.xlsx');
    }},
  ]));
}

function injectJobExportButtons(jobId, job) {
  const root = document.getElementById('uploadResult');
  const metrics = root?.querySelector('.job-metrics');
  if (!root || !metrics || !jobId) return;
  const old = root.querySelector('.job-export-row');
  if (old) old.remove();
  const row = document.createElement('div');
  row.className = 'export-row job-export-row';
  const ready = !['queued', 'processing'].includes(job?.status || '');
  row.innerHTML = `<div><b>Экспорт обработки</b><div class="hint">${ready ? 'Скачать результат текущей обработки.' : 'Будет доступен после завершения.'}</div></div>`;
  if (ready) {
    row.appendChild(createExportActions([
      { label: 'CSV', onClick: () => downloadExport('/api/export/jobs/' + encodeURIComponent(jobId) + '.csv') },
      { label: 'XLSX', onClick: () => downloadExport('/api/export/jobs/' + encodeURIComponent(jobId) + '.xlsx') },
    ]));
  }
  metrics.insertAdjacentElement('afterend', row);
}

function wrapRenderJobForExport() {
  if (typeof renderJob !== 'function' || window.__renderJobExportWrapped) return;
  const originalRenderJob = renderJob;
  renderJob = function(job, keepScroll = true) {
    const pageScroll = keepScroll ? capturePageScroll() : null;
    const result = originalRenderJob.call(this, job, keepScroll);
    if (job?.job_id) localStorage.setItem('lastJobId', job.job_id);
    injectJobExportButtons(job?.job_id, job);
    restorePageScroll(pageScroll);
    if (job && !['queued', 'processing'].includes(job.status || '') && typeof loadUploadHistory === 'function') {
      loadUploadHistory();
    }
    return result;
  };
  window.__renderJobExportWrapped = true;
}

async function restoreLatestJob() {
  if (typeof api !== 'function' || typeof renderJob !== 'function') return;
  const uploadResult = document.getElementById('uploadResult');
  if (uploadResult?.textContent?.trim()) return;
  try {
    const activeJobs = await api('/api/jobs?status=active&limit=1');
    const activeJob = Array.isArray(activeJobs) ? activeJobs[0] : null;
    if (activeJob?.job_id) {
      renderJob(activeJob, false);
      if (typeof pollJob === 'function') pollJob(activeJob.job_id);
      return;
    }
  } catch (_) {}

  const lastJobId = localStorage.getItem('lastJobId');
  if (!lastJobId) return;
  try {
    const job = await api('/api/jobs/' + encodeURIComponent(lastJobId));
    if (!job?.job_id || job.total_files === 0) {
      localStorage.removeItem('lastJobId');
      return;
    }
    renderJob(job, false);
    if (['queued', 'processing'].includes(job.status) && typeof pollJob === 'function') pollJob(job.job_id);
  } catch (_) {
    localStorage.removeItem('lastJobId');
  }
}

function historyBadge(status, label) {
  const cls = status === 'done' ? 'ok' : (status === 'error' || status === 'finished_with_errors' || status === 'interrupted') ? 'bad' : 'warn';
  return `<span class="badge ${cls}">${uiEsc(uiStatusLabel(status, label))}</span>`;
}

function ensureUploadHistoryPanel() {
  const upload = document.getElementById('upload');
  if (!upload || document.getElementById('uploadHistoryPanel')) return;
  upload.insertAdjacentHTML('beforeend', `
    <section id="uploadHistoryPanel" class="panel history-panel">
      <div class="panel-head"><div><h2 class="h1">История загрузок</h2><p class="hint">Прошлые обработки текущего аккаунта.</p></div><button id="refreshHistoryBtn" class="btn btn-soft">Обновить</button></div>
      <div id="uploadHistoryList"><div class="hint">Загрузка истории...</div></div>
    </section>
  `);
  document.getElementById('refreshHistoryBtn')?.addEventListener('click', loadUploadHistory);
}

async function loadUploadHistory() {
  const box = document.getElementById('uploadHistoryList');
  if (!box) return;
  const pageScroll = capturePageScroll();
  box.innerHTML = '<div class="hint">Загрузка истории...</div>';
  try {
    const rows = await api('/api/upload-history');
    if (!Array.isArray(rows) || !rows.length) {
      box.innerHTML = '<div class="hint">История пока пустая. Загрузи первый прайс.</div>';
      return;
    }
    box.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>Дата</th><th>Клиника</th><th>Файлы</th><th>Услуг</th><th>Проверка</th><th>Статус</th><th>Экспорт</th></tr></thead><tbody>${rows.map(row => {
      const files = (row.files || []).slice(0, 3).map(f => uiEsc(f.file_name)).join('<br/>');
      const more = (row.files || []).length > 3 ? `<div class="history-muted">+${(row.files || []).length - 3} ещё</div>` : '';
      const actions = row.exportable && row.job_id ? `<div class="history-actions"><button class="btn btn-soft" data-export-job="${uiEsc(row.job_id)}" data-format="csv">CSV</button><button class="btn btn-soft" data-export-job="${uiEsc(row.job_id)}" data-format="xlsx">XLSX</button></div>` : '<span class="history-muted">старый импорт</span>';
      return `<tr><td>${formatHistoryDate(row.created_at)}</td><td><div class="history-row-main">${uiEsc(row.clinic_name || '—')}</div></td><td>${files || '—'}${more}</td><td>${row.items_found || 0}</td><td>${row.needs_review || 0}</td><td>${historyBadge(row.status, row.display_status)}</td><td>${actions}</td></tr>`;
    }).join('')}</tbody></table></div>`;
    box.querySelectorAll('[data-export-job]').forEach(btn => btn.addEventListener('click', () => {
      downloadExport('/api/export/jobs/' + encodeURIComponent(btn.dataset.exportJob) + '.' + btn.dataset.format);
    }));
  } catch (e) {
    box.innerHTML = `<div class="card"><span class="badge bad">ошибка</span><div class="hint" style="margin-top:10px">${uiEsc(e.message || e)}</div></div>`;
  } finally {
    restorePageScroll(pageScroll);
  }
}

function initExportUi() {
  ensureExportStyles();
  ensureSearchExportButtons();
  ensureReviewExportButtons();
  ensurePartnerExportButtons();
  ensureUploadHistoryPanel();
  wrapRenderJobForExport();
  restoreLatestJob();
  loadUploadHistory();

  const partnerDetails = document.getElementById('partnerDetails');
  if (partnerDetails && !partnerDetails.dataset.exportObserved) {
    partnerDetails.dataset.exportObserved = '1';
    new MutationObserver(ensurePartnerExportButtons).observe(partnerDetails, { childList: true, subtree: true });
  }
}

initExportUi();
