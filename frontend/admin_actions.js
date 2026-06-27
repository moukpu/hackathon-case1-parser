(function loadAuthUi() {
  if (document.getElementById('authUiScript')) return;
  const script = document.createElement('script');
  script.id = 'authUiScript';
  script.src = '/frontend/auth_ui.js';
  document.head.appendChild(script);
})();

const clearBtn = document.getElementById('clearDbBtn');
const clearResult = document.getElementById('clearDbResult');

function currentUploadLooksActive() {
  const uploadResult = document.getElementById('uploadResult');
  if (!uploadResult || uploadResult.style.display === 'none') return false;
  const text = uploadResult.textContent.toLowerCase();
  return text.includes('обработка') || text.includes('ожидает') || text.includes('создаю очередь');
}

async function readResponseSafely(res) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { detail: text }; }
}

clearBtn?.addEventListener('click', async () => {
  if (currentUploadLooksActive()) {
    if (clearResult) {
      clearResult.innerHTML = '<div class="card"><span class="badge warn">подожди</span><div class="hint" style="margin-top:10px">Нельзя чистить базу, пока идёт обработка файлов. Дождись статуса “готово”.</div></div>';
    }
    return;
  }

  const ok = confirm('Очистить загруженные прайсы, документы, партнёров и jobs? Справочник услуг останется.');
  if (!ok) return;

  clearBtn.disabled = true;
  if (clearResult) {
    clearResult.innerHTML = '<div class="hint">Очищаю прайсы...</div>';
  }

  try {
    const res = await fetch('/api/admin/clear-prices', { method: 'POST' });
    const data = await readResponseSafely(res);
    if (!res.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data);
      throw new Error(detail || `HTTP ${res.status}`);
    }

    if (clearResult) {
      clearResult.innerHTML = `<div class="card"><span class="badge ok">готово</span><div style="margin-top:10px"><b>Прайсы очищены</b></div><div class="hint">Удалено позиций: ${data.deleted_price_items || 0}, документов: ${data.deleted_documents || 0}, партнёров: ${data.deleted_partners || 0}. Справочник сохранён: ${data.services || 0} услуг.</div></div>`;
    }

    localStorage.removeItem('lastJobId');
    if (typeof refreshStats === 'function') refreshStats();
    const uploadResult = document.getElementById('uploadResult');
    if (uploadResult) {
      uploadResult.style.display = 'none';
      uploadResult.innerHTML = '';
    }
  } catch (e) {
    if (clearResult) {
      clearResult.innerHTML = `<div class="card"><span class="badge bad">ошибка</span><div class="hint" style="margin-top:10px">${String(e.message || e)}</div></div>`;
    }
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
    @media(max-width:768px){.export-row{align-items:flex-start;flex-direction:column}.export-actions{justify-content:flex-start}}
  `;
  document.head.appendChild(style);
}

function downloadExport(url) {
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
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

function injectJobExportButtons(jobId) {
  const root = document.getElementById('uploadResult');
  const metrics = root?.querySelector('.job-metrics');
  if (!root || !metrics || !jobId) return;
  const old = root.querySelector('.job-export-row');
  if (old) old.remove();
  const row = document.createElement('div');
  row.className = 'export-row job-export-row';
  row.innerHTML = '<div><b>Экспорт job</b><div class="hint">Скачивание текущего результата обработки.</div></div>';
  row.appendChild(createExportActions([
    { label: 'CSV', onClick: () => downloadExport('/api/export/jobs/' + encodeURIComponent(jobId) + '.csv') },
    { label: 'XLSX', onClick: () => downloadExport('/api/export/jobs/' + encodeURIComponent(jobId) + '.xlsx') },
  ]));
  metrics.insertAdjacentElement('afterend', row);
}

function wrapRenderJobForExport() {
  if (typeof renderJob !== 'function' || window.__renderJobExportWrapped) return;
  const originalRenderJob = renderJob;
  renderJob = function(job, keepScroll = true) {
    const result = originalRenderJob.call(this, job, keepScroll);
    if (job?.job_id) localStorage.setItem('lastJobId', job.job_id);
    injectJobExportButtons(job?.job_id);
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
    renderJob(job, false);
    if (['queued', 'processing'].includes(job.status) && typeof pollJob === 'function') pollJob(job.job_id);
  } catch (_) {
    localStorage.removeItem('lastJobId');
  }
}

function initExportUi() {
  ensureExportStyles();
  ensureSearchExportButtons();
  ensureReviewExportButtons();
  ensurePartnerExportButtons();
  wrapRenderJobForExport();
  restoreLatestJob();

  const partnerDetails = document.getElementById('partnerDetails');
  if (partnerDetails && !partnerDetails.dataset.exportObserved) {
    partnerDetails.dataset.exportObserved = '1';
    new MutationObserver(ensurePartnerExportButtons).observe(partnerDetails, { childList: true, subtree: true });
  }
}

initExportUi();
