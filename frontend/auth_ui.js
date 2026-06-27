function authEsc(value) {
  return String(value ?? '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
}

function ensureAuthStyles() {
  if (document.getElementById('authUiStyles')) return;
  const style = document.createElement('style');
  style.id = 'authUiStyles';
  style.textContent = `
    .auth-overlay{position:fixed;inset:0;background:rgba(251,249,246,.94);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px}
    .auth-card{width:min(420px,100%);background:var(--surface-lowest);border:1px solid #e5e0d8;border-radius:12px;padding:24px;box-shadow:0 20px 70px rgba(0,0,0,.12)}
    .auth-title{font-size:28px;line-height:34px;font-weight:700;letter-spacing:-.02em;margin-bottom:6px}
    .auth-tabs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0}.auth-tab{height:38px;border:1px solid #e5e0d8;background:#f4f1ed;border-radius:6px;font-weight:600;cursor:pointer}.auth-tab.active{background:var(--primary-container);color:white;border-color:var(--primary-container)}
    .auth-form{display:grid;gap:10px}.auth-error{display:none;background:var(--error-soft);color:var(--error);border-radius:6px;padding:10px;margin-top:12px}.auth-user{display:flex;align-items:center;gap:10px}.auth-user-email{font-size:13px;color:var(--secondary)}#logoutBtn{height:36px;padding:0 14px}
    .sso-btn{width:100%;height:42px;margin:18px 0 10px;background:#fff;color:#1f1f1f;border:1px solid #dadce0}.auth-sep{display:flex;align-items:center;gap:10px;color:var(--secondary);font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin:8px 0}.auth-sep:before,.auth-sep:after{content:'';height:1px;background:#e5e0d8;flex:1}
  `;
  document.head.appendChild(style);
}

function authPayload() {
  return {
    email: document.getElementById('authEmail')?.value.trim() || '',
    password: document.getElementById('authPassword')?.value || '',
    name: document.getElementById('authName')?.value.trim() || '',
  };
}

async function authRequest(mode) {
  const err = document.getElementById('authError');
  if (err) { err.style.display = 'none'; err.textContent = ''; }
  const res = await fetch('/api/auth/' + mode, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(authPayload()),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || 'Ошибка входа');
  location.reload();
}

function showAuthModal() {
  ensureAuthStyles();
  if (document.getElementById('authOverlay')) return;
  let mode = 'login';
  const overlay = document.createElement('div');
  overlay.id = 'authOverlay';
  overlay.className = 'auth-overlay';
  overlay.innerHTML = `
    <div class="auth-card">
      <div class="auth-title">Вход</div>
      <div class="hint">Данные прайсов, справочник и ревью хранятся внутри аккаунта.</div>
      <button id="ssoLoginBtn" class="btn sso-btn" type="button">Войти через Google</button>
      <div class="auth-sep">или</div>
      <div class="auth-tabs"><button id="authLoginTab" class="auth-tab active">Вход</button><button id="authRegisterTab" class="auth-tab">Регистрация</button></div>
      <form id="authForm" class="auth-form">
        <input id="authName" class="input" placeholder="Имя / команда" style="display:none" />
        <input id="authEmail" class="input" type="email" placeholder="Email" autocomplete="email" required />
        <input id="authPassword" class="input" type="password" placeholder="Пароль" autocomplete="current-password" required />
        <button id="authSubmit" class="btn btn-primary" type="submit">Войти</button>
      </form>
      <div id="authError" class="auth-error"></div>
    </div>`;
  document.body.appendChild(overlay);

  const setMode = (nextMode) => {
    mode = nextMode;
    const isRegister = mode === 'register';
    document.querySelector('.auth-title').textContent = isRegister ? 'Регистрация' : 'Вход';
    document.getElementById('authName').style.display = isRegister ? 'block' : 'none';
    document.getElementById('authSubmit').textContent = isRegister ? 'Создать аккаунт' : 'Войти';
    document.getElementById('authLoginTab').classList.toggle('active', !isRegister);
    document.getElementById('authRegisterTab').classList.toggle('active', isRegister);
  };

  document.getElementById('ssoLoginBtn').addEventListener('click', () => { window.location.href = '/api/auth/' + 'google/start'; });
  document.getElementById('authLoginTab').addEventListener('click', () => setMode('login'));
  document.getElementById('authRegisterTab').addEventListener('click', () => setMode('register'));
  document.getElementById('authForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { await authRequest(mode); }
    catch (error) {
      const err = document.getElementById('authError');
      err.textContent = String(error.message || error);
      err.style.display = 'block';
    }
  });
}

function renderAuthUser(user) {
  ensureAuthStyles();
  const header = document.querySelector('.header');
  if (!header || document.getElementById('authUserBox')) return;
  const box = document.createElement('div');
  box.id = 'authUserBox';
  box.className = 'auth-user';
  box.innerHTML = `<div><b>${authEsc(user.name || 'Аккаунт')}</b><div class="auth-user-email">${authEsc(user.email)}</div></div><button id="logoutBtn" class="btn btn-soft">Выйти</button>`;
  header.appendChild(box);
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    localStorage.removeItem('lastJobId');
    location.reload();
  });
}

async function initAuthUi() {
  ensureAuthStyles();
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error('not-authenticated');
    const data = await res.json();
    renderAuthUser(data.user || {});
  } catch (_) {
    showAuthModal();
  }
}

window.showAuthModal = showAuthModal;
initAuthUi();
