function partnersUiFix() {
  if (document.getElementById('partnersUiFixStyle')) return;
  const style = document.createElement('style');
  style.id = 'partnersUiFixStyle';
  style.textContent = '.partner-btn .mini{display:none!important}.partner-btn{padding:14px 16px!important}';
  document.head.appendChild(style);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', partnersUiFix);
} else {
  partnersUiFix();
}
