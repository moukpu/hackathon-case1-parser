const clearBtn = document.getElementById('clearDbBtn');
const clearResult = document.getElementById('clearDbResult');

clearBtn?.addEventListener('click', async () => {
  const ok = confirm('Очистить загруженные прайсы, документы, партнёров и jobs? Справочник услуг останется.');
  if (!ok) return;

  clearBtn.disabled = true;
  if (clearResult) {
    clearResult.innerHTML = '<div class="hint">Очищаю прайсы...</div>';
  }

  try {
    const res = await fetch('/api/admin/clear-prices', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data);
      throw new Error(detail);
    }

    if (clearResult) {
      clearResult.innerHTML = `<div class="card"><span class="badge ok">готово</span><div style="margin-top:10px"><b>Прайсы очищены</b></div><div class="hint">Удалено позиций: ${data.deleted_price_items || 0}, документов: ${data.deleted_documents || 0}, партнёров: ${data.deleted_partners || 0}. Справочник сохранён: ${data.services || 0} услуг.</div></div>`;
    }

    if (typeof refreshStats === 'function') refreshStats();
    if (document.getElementById('uploadResult')) {
      document.getElementById('uploadResult').style.display = 'none';
      document.getElementById('uploadResult').innerHTML = '';
    }
  } catch (e) {
    if (clearResult) {
      clearResult.innerHTML = `<div class="card"><span class="badge bad">ошибка</span><div class="hint" style="margin-top:10px">${String(e.message || e)}</div></div>`;
    }
  } finally {
    clearBtn.disabled = false;
  }
});
