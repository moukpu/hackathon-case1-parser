function reviewUiEsc(value) {
  return String(value ?? '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
}

function reviewReasonLabel(item) {
  if (item?.review_reason_label) return item.review_reason_label;
  const note = String(item?.note || '').toLowerCase();
  const method = String(item?.match_method || '').toLowerCase();
  if (note.includes('низкая цена') || note.includes('подозрительно')) return 'подозрительно низкая цена';
  if (!item?.service_id || ['unmatched', 'no_match', 'no_catalog', 'no_choices'].includes(method)) return 'нет совпадения';
  if (method.includes('low') || Number(item?.confidence || 0) < 72) return 'низкая уверенность';
  return 'нужно проверить';
}

function reviewMatchesReason(item, reason) {
  if (!reason || reason === 'all') return true;
  if (item?.review_reason) return item.review_reason === reason;
  const label = reviewReasonLabel(item);
  if (reason === 'low_price') return label.includes('низкая цена');
  if (reason === 'no_match') return label.includes('нет совпадения');
  if (reason === 'low_confidence') return label.includes('низкая уверенность');
  return true;
}

function hideLegacyReviewManualControls() {
  document.querySelector('.review-match')?.remove();
  document.querySelector('.review-apply')?.remove();
  const searchRow = document.getElementById('reviewServiceSearch')?.closest('.search-row');
  const applyRow = document.getElementById('reviewServiceSelect')?.closest('.search-row');
  searchRow?.remove();
  applyRow?.remove();
}

function clearReviewSelection(message = 'Позиция не выбрана.') {
  selectedReviewItemId = null;
  const selected = document.getElementById('reviewSelected');
  if (selected) selected.innerHTML = message;
  const candidates = document.getElementById('reviewCandidates');
  if (candidates) candidates.innerHTML = '<b>Кандидаты появятся после выбора строки</b><div class="hint">Система предложит топ-5 услуг из справочника.</div>';
}

async function applyReviewService(serviceId) {
  if (!selectedReviewItemId) return alert('Сначала выбери строку ревью');
  if (!serviceId) return alert('Выбери услугу');
  try {
    await api('/api/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: selectedReviewItemId, service_id: serviceId }),
    });
    clearReviewSelection('<span class="badge ok">готово</span><div class="hint" style="margin-top:8px">Match применён. Строка ушла из ревью.</div>');
    if (typeof loadUnmatched === 'function') await loadUnmatched();
    if (typeof refreshStats === 'function') refreshStats();
  } catch (e) {
    alert(e.message || e);
  }
}

function ensureReviewCandidateBox() {
  const selected = document.getElementById('reviewSelected');
  if (!selected || document.getElementById('reviewCandidates')) return;
  selected.insertAdjacentHTML('afterend', '<div id="reviewCandidates" class="review-candidates card"><b>Кандидаты появятся после выбора строки</b><div class="hint">Система предложит топ-5 услуг из справочника.</div></div>');
}

function renderReviewFilterButtons() {
  const input = document.getElementById('reviewClinicFilter');
  if (!input || document.getElementById('reviewReasonFilters')) return;
  input.insertAdjacentHTML('beforebegin', `
    <div id="reviewReasonFilters" class="review-filter-row">
      <button class="btn btn-soft active" type="button" data-review-reason="all">Все</button>
      <button class="btn btn-soft" type="button" data-review-reason="low_price">Низкая цена</button>
      <button class="btn btn-soft" type="button" data-review-reason="no_match">Нет match</button>
      <button class="btn btn-soft" type="button" data-review-reason="low_confidence">Низкая уверенность</button>
    </div>
  `);
  document.querySelectorAll('[data-review-reason]').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('[data-review-reason]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    clearReviewSelection();
    if (typeof renderReviewList === 'function') renderReviewList();
  }));
}

function activeReviewReason() {
  return document.querySelector('[data-review-reason].active')?.dataset.reviewReason || 'all';
}

async function loadReviewCandidates(itemId) {
  const box = document.getElementById('reviewCandidates');
  if (!box || !itemId || typeof api !== 'function') return;
  box.innerHTML = '<div class="hint">Ищу топ-5 кандидатов...</div>';
  try {
    const data = await api('/api/review/items/' + encodeURIComponent(itemId) + '/candidates');
    const candidates = data.candidates || [];
    if (!candidates.length) {
      box.innerHTML = '<b>Кандидаты не найдены</b><div class="hint">Нет уверенных вариантов в справочнике.</div>';
      return;
    }
    box.innerHTML = `<div class="review-candidates-head"><b>Топ-5 кандидатов</b><span class="hint">Выбери лучший match</span></div><div class="review-candidate-list">${candidates.map(c => `
      <div class="review-candidate">
        <div><b>${reviewUiEsc(c.service_name)}</b><div class="hint">${reviewUiEsc(c.category || 'категория не указана')} · ${c.score || 0}%</div></div>
        <button class="btn btn-primary" type="button" data-apply-candidate="${reviewUiEsc(c.service_id)}">Применить</button>
      </div>
    `).join('')}</div>`;
    box.querySelectorAll('[data-apply-candidate]').forEach(btn => btn.addEventListener('click', () => applyReviewService(btn.dataset.applyCandidate)));
  } catch (e) {
    box.innerHTML = `<span class="badge bad">ошибка</span><div class="hint" style="margin-top:8px">${reviewUiEsc(e.message || e)}</div>`;
  }
}

function patchReviewUi() {
  if (window.__reviewImprovementsReady) return;
  if (typeof loadUnmatched !== 'function' || typeof renderReviewList !== 'function' || typeof selectReviewItem !== 'function') return;

  const originalLoadUnmatched = loadUnmatched;

  loadUnmatched = async function() {
    hideLegacyReviewManualControls();
    const box = document.getElementById('reviewResult');
    if (box) box.innerHTML = '<div class="hint">Загрузка ревью...</div>';
    try {
      lastReviewItems = await api('/api/review/items');
      if (selectedReviewItemId && !(lastReviewItems || []).some(i => i.item_id === selectedReviewItemId)) {
        clearReviewSelection();
      }
      renderReviewList();
    } catch (_) {
      return originalLoadUnmatched();
    }
  };

  renderReviewList = function() {
    hideLegacyReviewManualControls();
    renderReviewFilterButtons();
    ensureReviewCandidateBox();
    const q = document.getElementById('reviewClinicFilter')?.value || '';
    const reason = activeReviewReason();
    const rows = (lastReviewItems || []).filter(i => reviewMatchesReason(i, reason) && ciMatch(q, i.clinic_name, i.original_name, i.standardized_name, i.note, i.review_reason_label));
    if (selectedReviewItemId && !rows.some(i => i.item_id === selectedReviewItemId)) {
      clearReviewSelection();
    }
    const target = document.getElementById('reviewResult');
    if (!target) return;
    target.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>Клиника</th><th>Исходная строка</th><th>Цена</th><th>Match</th><th>Причина</th></tr></thead><tbody>${rows.map(i => `<tr class="review-row ${i.item_id===selectedReviewItemId?'selected':''}" data-item-id="${reviewUiEsc(i.item_id)}"><td>${reviewUiEsc(i.clinic_name)}</td><td>${reviewUiEsc(i.original_name)}</td><td>${money(i.price_resident_kzt)}</td><td>${i.confidence ?? 0}%</td><td>${reviewUiEsc(reviewReasonLabel(i))}</td></tr>`).join('')}</tbody></table></div>`;
    target.querySelectorAll('.review-row').forEach(row => row.addEventListener('click', () => selectReviewItem(row.dataset.itemId)));
  };

  selectReviewItem = function(id) {
    hideLegacyReviewManualControls();
    selectedReviewItemId = id;
    const item = (lastReviewItems || []).find(i => i.item_id === id);
    const selected = document.getElementById('reviewSelected');
    if (selected) selected.innerHTML = item ? `Выбрано: <b>${reviewUiEsc(item.original_name)}</b> · ${money(item.price_resident_kzt)} · ${reviewUiEsc(item.clinic_name)} · ${reviewUiEsc(reviewReasonLabel(item))}` : 'Позиция не выбрана.';
    renderReviewList();
    loadReviewCandidates(id);
  };

  window.__reviewImprovementsReady = true;
}

function ensureReviewImprovementsStyles() {
  if (document.getElementById('reviewImprovementsStyles')) return;
  const style = document.createElement('style');
  style.id = 'reviewImprovementsStyles';
  style.textContent = `
    .review-match,.review-apply,#reviewServiceSearch,#reviewServiceBtn,#reviewServiceSelect,#applyReviewMatchBtn{display:none!important}
    .review-filter-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}.review-filter-row .btn{height:34px;padding:0 12px}.review-filter-row .btn.active{background:var(--primary-container);color:var(--on-primary)}
    .review-candidates{margin-bottom:12px}.review-candidates-head{display:flex;justify-content:space-between;gap:12px;margin-bottom:10px}.review-candidate-list{display:grid;gap:8px}.review-candidate{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;border:1px solid #e5e0d8;border-radius:6px;padding:10px;background:#f9f8f6}.review-candidate .btn{height:34px;padding:0 12px}
    @media(max-width:768px){.review-candidate{grid-template-columns:1fr}.review-candidates-head{display:block}}
  `;
  document.head.appendChild(style);
}

function initReviewImprovements() {
  ensureReviewImprovementsStyles();
  hideLegacyReviewManualControls();
  patchReviewUi();
  renderReviewFilterButtons();
  ensureReviewCandidateBox();
}

document.addEventListener('DOMContentLoaded', () => setTimeout(initReviewImprovements, 0));
