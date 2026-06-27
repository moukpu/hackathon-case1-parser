// UI polish layer: file picker, drag-drop and cleaner live job table.
(function () {
  const byId = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
  const money = (v) => v == null ? '—' : Number(v).toLocaleString('ru-RU') + ' ₸';

  function priceYear(filename) {
    const match = String(filename || '').match(/\b(20\d{2})\b/);
    return match ? match[1] : '—';
  }

  function statusBadge(status) {
    if (status === 'done') return '<span class="text-emerald-600 font-bold">done</span>';
    if (status === 'needs_review') return '<span class="text-emerald-600 font-bold">done</span><span class="ml-2 text-xs text-amber-600 font-bold">has review</span>';
    if (status === 'processing') return '<span class="text-indigo-600 font-bold">processing...</span>';
    if (status === 'pending') return '<span class="text-slate-500 font-bold">pending</span>';
    if (status === 'error') return '<span class="text-red-600 font-bold">error</span>';
    return `<span class="text-slate-500 font-bold">${esc(status || '—')}</span>`;
  }

  function itemStatus(item) {
    if (item.needs_review) return '<span class="text-amber-600 font-bold">review</span>';
    if (Number(item.price) > 0 && Number(item.price) < 1000) return '<span class="text-amber-600 font-bold">low price?</span>';
    return '<span class="text-emerald-600 font-bold">ok</span>';
  }

  function progressText(job) {
    return `${job.processed_files || 0}/${job.total_files || 0} файлов · ${job.items_found || 0} услуг · ${job.needs_review || 0} review`;
  }

  function uniquePreviewItems(items) {
    const seen = new Set();
    const out = [];
    for (const item of items || []) {
      const key = `${item.clinic_name}|${item.standardized_name || item.original_name}|${item.price}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= 200) break;
    }
    return out;
  }

  function setupFilePicker() {
    const input = byId('priceFiles');
    const hint = byId('filePickHint');
    const drop = document.querySelector('label[for="priceFiles"]');
    if (!input || !hint || !drop) return;

    const refreshHint = () => {
      const files = Array.from(input.files || []);
      hint.textContent = files.length ? files.map(f => f.name).join(' · ') : 'Нажми сюда или перетащи ZIP/PDF/DOCX/XLSX/XLS';
    };

    input.addEventListener('change', refreshHint);
    ['dragenter', 'dragover'].forEach(evt => drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.add('ring-4', 'ring-indigo-100');
    }));
    ['dragleave', 'drop'].forEach(evt => drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.remove('ring-4', 'ring-indigo-100');
    }));
    drop.addEventListener('drop', (e) => {
      input.files = e.dataTransfer.files;
      input.dispatchEvent(new Event('change'));
    });
  }

  window.renderJob = function renderJob(job) {
    const docs = job.documents || [];
    const docRows = docs.map(doc => `<tr class="border-t border-slate-100 align-top"><td class="px-4 py-3 font-medium">${esc(doc.clinic_name || '—')}</td><td class="px-4 py-3 font-bold text-slate-700">${esc(priceYear(doc.file_name))}</td><td class="px-4 py-3 max-w-xl break-all">${esc(doc.file_name || '—')}</td><td class="px-4 py-3">${statusBadge(doc.status)}</td><td class="px-4 py-3">${doc.items ?? 0}</td><td class="px-4 py-3 text-amber-600 font-bold">${doc.review_items ?? 0}</td><td class="px-4 py-3 text-red-600 text-xs">${esc(doc.error || '')}</td></tr>`).join('');
    const previewItems = uniquePreviewItems(job.data || []);
    const rows = previewItems.map(item => `<tr class="border-t border-slate-100 ${Number(item.price) > 0 && Number(item.price) < 1000 ? 'bg-amber-50/50' : ''}"><td class="px-4 py-3 font-medium">${esc(item.clinic_name || '—')}</td><td class="px-4 py-3 font-medium">${esc(item.standardized_name || item.original_name)}</td><td class="px-4 py-3">${money(item.price)}</td><td class="px-4 py-3">${esc(item.category || '—')}</td><td class="px-4 py-3">${esc(item.confidence)}%</td><td class="px-4 py-3">${itemStatus(item)}</td></tr>`).join('');
    const partners = (job.partners_detected || []).join(', ');
    const activeHint = ['queued', 'processing'].includes(job.status) ? '<div class="mb-4 p-4 rounded-2xl bg-indigo-50 border border-indigo-100 text-indigo-800"><b>Парсинг запущен.</b> Статус обновляется автоматически.</div>' : '';
    const emptyHint = job.items_found === 0 && !['queued', 'processing'].includes(job.status) ? '<div class="mb-4 p-4 rounded-2xl bg-amber-50 border border-amber-100 text-amber-800"><b>0 услуг.</b> Проверь ошибку файла или качество текста.</div>' : '';

    byId('uploadResult').innerHTML = `${activeHint}${emptyHint}
      <div class="grid md:grid-cols-4 gap-4 mb-4">
        <div class="bg-white border border-slate-100 rounded-2xl p-4"><b>Job:</b><br>${statusBadge(job.status)}</div>
        <div class="bg-white border border-slate-100 rounded-2xl p-4"><b>Прогресс:</b><br>${esc(progressText(job))}</div>
        <div class="bg-white border border-slate-100 rounded-2xl p-4"><b>Клиники:</b><br><span class="text-xs">${esc(partners || '—')}</span></div>
        <div class="bg-white border border-slate-100 rounded-2xl p-4"><b>ID:</b><br><span class="text-xs break-all">${esc(job.job_id || '—')}</span></div>
      </div>
      <div class="mb-5 overflow-auto bg-white rounded-2xl border border-slate-100"><div class="px-4 py-3 font-bold">Файлы внутри ZIP</div><table class="w-full text-sm"><thead><tr class="text-left text-slate-500"><th class="px-4 py-3">Клиника</th><th class="px-4 py-3">Год</th><th class="px-4 py-3">Файл</th><th class="px-4 py-3">Статус</th><th class="px-4 py-3">Услуг</th><th class="px-4 py-3">Ревью</th><th class="px-4 py-3">Ошибка</th></tr></thead><tbody>${docRows || '<tr><td class="p-4 text-slate-500" colspan="7">Нет файлов</td></tr>'}</tbody></table></div>
      <div class="overflow-auto bg-white rounded-2xl border border-slate-100"><div class="px-4 py-3 font-bold">Первые 200 уникальных позиций</div><table class="w-full text-sm"><thead><tr class="text-left text-slate-500"><th class="px-4 py-3">Клиника</th><th class="px-4 py-3">Услуга</th><th class="px-4 py-3">Цена</th><th class="px-4 py-3">Категория</th><th class="px-4 py-3">Match</th><th class="px-4 py-3">Статус</th></tr></thead><tbody>${rows || '<tr><td class="p-4 text-slate-500" colspan="6">Позиции пока не извлечены</td></tr>'}</tbody></table></div>`;
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupFilePicker);
  else setupFilePicker();
})();
