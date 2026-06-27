async function readJsonSafe(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch (_) { return { detail: text }; }
}

function setClearResult(html) {
  const box = document.getElementById('clearDbResult');
  if (box) box.innerHTML = html;
}

async function forceClearPrices() {
  const btn = document.getElementById('clearDbBtn');
  if (!confirm('Отменить зависшие обработки и очистить загруженные прайсы? Справочник останется.')) return;
  if (btn) btn.disabled = true;
  setClearResult('<div class="hint">Отменяю зависшие обработки и очищаю прайсы...</div>');
  try {
    await fetch('/api/admin/cancel-jobs', { method: 'POST' });
    const res = await fetch('/api/admin/clear-prices', { method: 'POST' });
    const data = await readJsonSafe(res);
    if (!res.ok || data.error) throw new Error(data.error || data.detail || 'Ошибка очистки');
    localStorage.removeItem('lastJobId');
    const uploadResult = document.getElementById('uploadResult');
    if (uploadResult) {
      uploadResult.style.display = 'none';
      uploadResult.innerHTML = '';
    }
    setClearResult(`<div class="card"><span class="badge ok">готово</span><div style="margin-top:10px"><b>Прайсы очищены</b></div><div class="hint">Отменено обработок: ${data.cancelled_jobs || 0}. Удалено позиций: ${data.deleted_price_items || 0}. Справочник сохранён: ${data.services || 0} услуг.</div></div>`);
    if (typeof refreshStats === 'function') refreshStats();
  } catch (e) {
    setClearResult(`<div class="card"><span class="badge bad">ошибка</span><div class="hint" style="margin-top:10px">${String(e.message || e)}</div></div>`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function installClearOverride() {
  const btn = document.getElementById('clearDbBtn');
  if (!btn || btn.dataset.forceClearReady) return;
  btn.dataset.forceClearReady = '1';
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    forceClearPrices();
  }, true);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installClearOverride);
else installClearOverride();
