// Small client-side filters for the review queue.
// Backend still returns /api/unmatched as before; this hides visible cards for demo speed.
(function () {
  const $ = (id) => document.getElementById(id);

  function parseMoney(text) {
    const match = String(text || '').match(/([0-9\s]+)\s*₸/);
    return match ? Number(match[1].replace(/\s+/g, '')) : null;
  }

  function parseConfidence(text) {
    const match = String(text || '').match(/confidence\s+([0-9.]+)%/i);
    return match ? Number(match[1]) : null;
  }

  function applyReviewFilters() {
    const box = $('reviewResult');
    if (!box) return;

    const clinic = ($('reviewClinicFilter')?.value || '').trim().toLowerCase();
    const minPrice = Number($('reviewMinPrice')?.value || '');
    const maxPrice = Number($('reviewMaxPrice')?.value || '');
    const maxConfidence = Number($('reviewMaxConfidence')?.value || '');
    const lowOnly = Boolean($('reviewLowOnly')?.checked);

    const cards = Array.from(box.querySelectorAll('.bg-white\/80.rounded-2xl.border'));
    let visible = 0;

    for (const card of cards) {
      const text = card.textContent || '';
      const lower = text.toLowerCase();
      const price = parseMoney(text);
      const confidence = parseConfidence(text);

      let ok = true;
      if (clinic && !lower.includes(clinic)) ok = false;
      if (price != null && Number.isFinite(minPrice) && minPrice > 0 && price < minPrice) ok = false;
      if (price != null && Number.isFinite(maxPrice) && maxPrice > 0 && price > maxPrice) ok = false;
      if (confidence != null && Number.isFinite(maxConfidence) && maxConfidence > 0 && confidence > maxConfidence) ok = false;
      if (lowOnly && !(price != null && price > 0 && price < 1000)) ok = false;

      card.style.display = ok ? '' : 'none';
      if (ok) visible += 1;
    }

    const summary = $('reviewFilterSummary');
    if (summary && cards.length) {
      summary.textContent = `Показано ${visible} из ${cards.length}. Фильтры работают по загруженным первым 500 review-позициям.`;
    }
  }

  function setup() {
    ['reviewClinicFilter', 'reviewMinPrice', 'reviewMaxPrice', 'reviewMaxConfidence', 'reviewLowOnly']
      .forEach((id) => $(id)?.addEventListener('input', applyReviewFilters));

    const result = $('reviewResult');
    if (result) {
      new MutationObserver(() => applyReviewFilters()).observe(result, { childList: true, subtree: false });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();
