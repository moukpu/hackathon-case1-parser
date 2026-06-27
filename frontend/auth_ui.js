function authEsc(value) {
  return String(value ?? '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
}

function ensureAuthStyles() {
  if (document.getElementById('authUiStyles')) return;
  const style = document.createElement('style');
  style.id = 'authUiStyles';
  style.textContent = '.auth-overlay{position:fixed;inset:0;background:rgba(251,249,246,.94);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px}.auth-card{width:min(420px,100%);background:#fff;border:1px solid #e5e0d8;border-radius:12px;padding:24px;box-shadow:0 20px 70px rgba(0,0,0,.12)}.auth-title{font-size:28px;line-height:34px;font-weight:700;margin-bottom:6px}.auth-tabs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0}.auth-tab{height:38px;border:1px solid #e5e0d8;background:#f4f1ed;border-radius:6px;font-weight:600;cursor:pointer}.auth-tab.active{background:var(--primary-container);color:#fff}.auth-form{display:grid;gap:10px}.auth-error{display:none;background:var(--error-soft);color:var(--error);border-radius:6px;padding:10px;margin-top:12px}.auth-user{display:flex;align-items:center;gap:10px}.auth-user-email{font-size:13px;color:var(--secondary)}.sso-btn{width:100%;height:42px;margin:18px 0 10px;background:#fff;color:#1f1f1f;border:1px solid #dadce0}';
  document.head.appendChild(style);
}

function showAuthModal() {
  ensureAuthStyles();
  if (document.getElementById('authOverlay')) return;
  let mode = 'login';
  const overlay = document.createElement('div');
  overlay.id = 'authOverlay';
  overlay.className = 'auth-overlay';
  overlay.innerHTML = `<div class="auth-card"><div class="auth-title">Вход</div><div class="hint">Данные хранятся внутри аккаунта.</div><button id="ssoLoginBtn" class="btn sso-btn" type="button">Войти через Google</button><div class="auth-tabs"><button id="authLoginTab" class="auth-tab active">Вход</button><button id="authRegisterTab" class="auth-tab">Регистрация</button></div><form id="authForm" class="auth-form"><input id="authName" class="input" placeholder="Имя / команда" style="display:none" /><input id="authEmail" class="input" type="email" placeholder="Email" required /><input id="authPassword" class="input" type="password" placeholder="Пароль" required /><button id="authSubmit" class="btn btn-primary" type="submit">Войти</button></form><div id="authError" class="auth-error"></div></div>`;
  document.body.appendChild(overlay);

  function setMode(next) {
    mode = next;
    const reg = mode === 'register';
    document.querySelector('.auth-title').textContent = reg ? 'Регистрация' : 'Вход';
    document.getElementById('authName').style.display = reg ? 'block' : 'none';
    document.getElementById('authSubmit').textContent = reg ? 'Создать аккаунт' : 'Войти';
    document.getElementById('authLoginTab').classList.toggle('active', !reg);
    document.getElementById('authRegisterTab').classList.toggle('active', reg);
  }

  document.getElementById('ssoLoginBtn').onclick = () => { window.location.href = '/api/auth/google/start'; };
  document.getElementById('authLoginTab').onclick = () => setMode('login');
  document.getElementById('authRegisterTab').onclick = () => setMode('register');
  document.getElementById('authForm').onsubmit = async e => {
    e.preventDefault();
    const err = document.getElementById('authError');
    err.style.display = 'none';
    try {
      const res = await fetch('/api/auth/' + mode, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email:authEmail.value.trim(), password:authPassword.value, name:authName.value.trim() }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || 'Ошибка входа');
      location.reload();
    } catch (error) {
      err.textContent = String(error.message || error);
      err.style.display = 'block';
    }
  };
}

function renderAuthUser(user) {
  const header = document.querySelector('.header');
  if (!header || document.getElementById('authUserBox')) return;
  const box = document.createElement('div');
  box.id = 'authUserBox';
  box.className = 'auth-user';
  box.innerHTML = `<div><b>${authEsc(user.name || 'Аккаунт')}</b><div class="auth-user-email">${authEsc(user.email)}</div></div><button id="logoutBtn" class="btn btn-soft">Выйти</button>`;
  header.appendChild(box);
  document.getElementById('logoutBtn').onclick = async () => { await fetch('/api/auth/logout', { method:'POST' }); localStorage.removeItem('lastJobId'); location.reload(); };
}

function loadCatalogCleanScript() {
  if (document.getElementById('catalogCleanScript')) return;
  const script = document.createElement('script');
  script.id = 'catalogCleanScript';
  script.src = '/frontend/catalog_clean.js';
  document.head.appendChild(script);
}

async function initAuthUi() {
  ensureAuthStyles();
  loadCatalogCleanScript();
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error('noauth');
    const data = await res.json();
    renderAuthUser(data.user || {});
  } catch (_) {
    showAuthModal();
  }
}

window.showAuthModal = showAuthModal;
initAuthUi();
