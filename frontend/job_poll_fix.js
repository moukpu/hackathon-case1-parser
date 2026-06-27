function showInterruptedJob(jobId, message) {
  const box = document.getElementById('uploadResult');
  if (!box) return;
  box.style.display = 'block';
  box.innerHTML = `<div class="card"><span class="badge warn">прервано</span><div style="margin-top:10px"><b>Обработка не продолжилась</b></div><div class="hint">${message || 'Сервер перезапустился во время обработки. Загрузи архив заново.'}</div><div class="hint" style="margin-top:8px">Job: ${String(jobId || '').replace(/[&<>"]/g, '')}</div></div>`;
}

function installJobPollFix() {
  if (window.__jobPollFixInstalled || typeof window.pollJob !== 'function') return;
  window.__jobPollFixInstalled = true;
  const originalPollJob = window.pollJob;
  window.pollJob = async function(jobId) {
    try {
      return await originalPollJob(jobId);
    } catch (e) {
      showInterruptedJob(jobId, String(e && e.message || e));
    }
  };

  const originalApi = window.api;
  if (typeof originalApi === 'function' && !window.__apiJobFixInstalled) {
    window.__apiJobFixInstalled = true;
    window.api = async function(url, options) {
      try {
        return await originalApi(url, options);
      } catch (e) {
        if (String(url || '').includes('/api/jobs/')) {
          showInterruptedJob(String(url).split('/').pop(), 'Сервер перезапустился во время обработки. Загрузи архив заново.');
        }
        throw e;
      }
    };
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(installJobPollFix, 0));
else setTimeout(installJobPollFix, 0);
