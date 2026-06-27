function catalogSettingsEsc(value) {
  return String(value ?? '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
}

function catalogSettingsDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 16);
  return d.toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
}

function ensureCatalogSettingsPanel() {
  const catalogPanel = document.getElementById('catalog')?.querySelector('.panel');
  if (!catalogPanel || document.getElementById('catalogSettingsBox')) return;
  const form = document.getElementById('catalogForm');
  const html = `
    <section id="catalogSettingsBox" class="catalog-settings card">
      <div class="catalog-settings-head">
        <div><b>Настройки справочника</b><div class="hint">Текущий справочник аккаунта.</div></div>
        <button id="refreshCatalogSettingsBtn" type="button" class="btn btn-soft">Обновить</button>
      </div>
      <div id="catalogSettingsContent" class="hint">Загрузка...</div>
    </section>
  `;
  if (form) form.insertAdjacentHTML('beforebegin', html);
  else catalogPanel.insertAdjacentHTML('afterbegin', html);
  document.getElementById('refreshCatalogSettingsBtn')?.addEventListener('click', loadCatalogSettings);
}

async function loadCatalogSettings() {
  const box = document.getElementById('catalogSettingsContent');
  if (!box || typeof api !== 'function') return;
  box.innerHTML = 'Загрузка...';
  try {
    const data = await api('/api/catalog/settings');
    const current = data.current_catalog || {};
    const source = data.active_source || {};
    const fileName = current.file_name || source.file_name || 'встроенный справочник';
    const sourceLabel = source.is_user_catalog ? 'файл аккаунта' : source.is_bundled ? 'встроенный файл' : 'системный источник';
    box.innerHTML = `
      <div class="grid-3 catalog-settings-grid">
        <div class="metric"><div class="metric-label">Услуг в базе</div><div class="metric-value">${data.services_count || 0}</div></div>
        <div class="metric"><div class="metric-label">Файл</div><div class="hint" style="margin-top:10px"><b>${catalogSettingsEsc(fileName)}</b><br>${catalogSettingsEsc(sourceLabel)}</div></div>
        <div class="metric"><div class="metric-label">Обновлён</div><div class="hint" style="margin-top:10px"><b>${catalogSettingsDate(current.updated_at)}</b><br>${current.rows != null ? catalogSettingsEsc(current.rows) + ' строк в файле' : 'файл не загружен вручную'}</div></div>
      </div>
    `;
  } catch (e) {
    box.innerHTML = `<span class="badge bad">ошибка</span><div class="hint" style="margin-top:8px">${catalogSettingsEsc(e.message || e)}</div>`;
  }
}

function ensureCatalogSettingsStyles() {
  if (document.getElementById('catalogSettingsStyles')) return;
  const style = document.createElement('style');
  style.id = 'catalogSettingsStyles';
  style.textContent = `
    .catalog-settings{margin-bottom:16px;background:#f9f8f6}.catalog-settings-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.catalog-settings-head .btn{height:34px;padding:0 12px}.catalog-settings-grid .metric-value{font-size:28px;line-height:34px}
    @media(max-width:768px){.catalog-settings-head{align-items:flex-start;flex-direction:column}}
  `;
  document.head.appendChild(style);
}

function initCatalogSettings() {
  ensureCatalogSettingsStyles();
  ensureCatalogSettingsPanel();
  loadCatalogSettings();
}

document.addEventListener('DOMContentLoaded', () => setTimeout(initCatalogSettings, 0));
