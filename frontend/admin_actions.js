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
