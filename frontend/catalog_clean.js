function catalogCleanNumber(text, key) {
  const match = String(text || '').match(new RegExp('"' + key + '"\\s*:\\s*(\\d+)'));
  return match ? Number(match[1]) : 0;
}

function cleanCatalogResultBox() {
  const box = document.getElementById('catalogResult');
  if (!box) return;
  const pre = box.querySelector('pre');
  if (!pre) return;
  const text = pre.textContent || '';
  if (!text.includes('services') && !text.includes('created')) return;

  const services = catalogCleanNumber(text, 'services').toLocaleString('ru-RU');
  const changed = (catalogCleanNumber(text, 'created') + catalogCleanNumber(text, 'updated')).toLocaleString('ru-RU');
  const skipped = text.includes('skipped_bootstrap') && text.includes('true');
  const title = skipped ? 'Справочник уже готов' : 'Справочник обновлён';
  const details = skipped ? `${services} услуг в базе.` : `${services} услуг в базе. Обновлено строк: ${changed}.`;
  box.innerHTML = `<div class="card"><span class="badge ok">готово</span><div style="margin-top:10px"><b>${title}</b></div><div class="hint">${details}</div></div>`;
}

function initCatalogResultCleaner() {
  const box = document.getElementById('catalogResult');
  if (!box || box.dataset.cleanerReady) return;
  box.dataset.cleanerReady = '1';
  new MutationObserver(cleanCatalogResultBox).observe(box, { childList: true, subtree: true, characterData: true });
  cleanCatalogResultBox();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCatalogResultCleaner);
else initCatalogResultCleaner();
