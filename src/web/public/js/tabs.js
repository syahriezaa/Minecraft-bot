// Navigasi tab dashboard - permintaan nyata pemilik: "ui nya berantakan tata lagi menjadi lebih
// rapi". Terpisah dari app.js supaya tidak menyentuh logika WebSocket/render yang sudah ada -
// cuma switch class .active antara .tab-btn dan .tab-view yang cocok data-tab-target/data-tab-view.
(function () {
  const buttons = document.querySelectorAll('.tab-btn');
  const views = document.querySelectorAll('.tab-view');

  // Tempel #tab-nav persis di bawah #app-header - dihitung dari tinggi header SESUNGGUHNYA (bukan
  // angka px tebakan di CSS) supaya tetap pas walau tinggi header berubah (mis. font system beda).
  const header = document.getElementById('app-header');
  const tabNav = document.getElementById('tab-nav');
  if (header && tabNav) {
    const stickTabNav = () => { tabNav.style.top = `${header.offsetHeight}px`; };
    stickTabNav();
    window.addEventListener('resize', stickTabNav);
  }

  function activate(target) {
    buttons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tabTarget === target));
    views.forEach((view) => view.classList.toggle('active', view.dataset.tabView === target));
  }

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => activate(btn.dataset.tabTarget));
  });
})();
