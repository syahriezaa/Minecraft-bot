/**
 * @file decisionInspector.js
 * @description Halaman live "Decision Inspector" - menerima DECISION_TICK lewat WebSocket yang sama
 * dipakai dashboard utama, dan menampilkan tiap tick fisika navigasi (blok yang dicek, keputusan
 * yang diambil) sebagai tabel + peta jejak 2D, live saat bot benar-benar berjalan.
 */

(function () {
  'use strict';

  const DECISION_COLORS = {
    COARSE_PATH: '#4FA8D8',
    FRONTIER_PUSH: '#B08FE0',
    ESCAPE: '#EF5350',
    STUCK_PROBE: '#FF9800',
    HOSTILE_RETREAT: '#F06090',
    FREEFALL_WAIT: '#9999B0',
    NORMAL_FOLLOW: '#4CAF50',
    GUESS_FALLBACK: '#B08FE0'
  };
  const DECISION_LABELS = {
    COARSE_PATH: 'coarse path',
    FRONTIER_PUSH: 'frontier push',
    ESCAPE: 'escape',
    STUCK_PROBE: 'stuck probe',
    HOSTILE_RETREAT: 'hostile retreat',
    FREEFALL_WAIT: 'freefall wait',
    NORMAL_FOLLOW: 'normal follow',
    GUESS_FALLBACK: 'guess fallback'
  };
  const MAX_ROWS = 5000; // batasi memori browser - tetap simpan cukup banyak untuk sesi panjang

  let ROWS = [];
  let selectedIndex = -1;
  let followLive = true; // auto-scroll & auto-select tick terbaru selama true
  let ws = null;
  let reconnectTimer = null;

  const tbody = document.getElementById('tbody');
  const tablewrap = document.getElementById('tablewrap');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const walkStatus = document.getElementById('walk-status');

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);
    ws.onopen = () => { statusDot.classList.add('connected'); statusText.textContent = 'Terhubung'; };
    ws.onclose = () => { statusDot.classList.remove('connected'); statusText.textContent = 'Terputus'; scheduleReconnect(); };
    ws.onerror = () => {};
    ws.onmessage = (event) => {
      try { handleMessage(JSON.parse(event.data)); } catch (e) {}
    };
  }
  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  }

  function handleMessage(msg) {
    if (msg.type === 'DECISION_TICK') {
      addRow(msg.data);
    } else if (msg.type === 'AI_ACTION_EVENT' && msg.data?.task === 'WALK_TO_BASE') {
      walkStatus.textContent = msg.data.step || msg.data.status || '';
      if (msg.data.status === 'COMPLETED' || msg.data.status === 'STOPPED') {
        walkStatus.textContent = `${msg.data.step} (selesai)`;
      }
    }
  }

  function addRow(record) {
    ROWS.push(record);
    if (ROWS.length > MAX_ROWS) ROWS.shift();
    appendTableRow(record, ROWS.length - 1);
    buildStats();
    buildLegend();
    if (followLive) selectTick(ROWS.length - 1);
  }

  function buildStats() {
    if (ROWS.length === 0) return;
    const first = ROWS[0], last = ROWS[ROWS.length - 1];
    const progress = first.dist - last.dist;
    const stats = [
      ['Tick', ROWS.length],
      ['Jarak awal', first.dist.toFixed(1)],
      ['Jarak sekarang', last.dist.toFixed(1)],
      ['Progres', (progress >= 0 ? '+' : '') + progress.toFixed(1)],
      ['Simpul graf', last.graphNodes],
      ['Waypoint', last.waypoint || '-']
    ];
    document.getElementById('statbar').innerHTML = stats.map(([label, value]) =>
      `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div></div>`
    ).join('');
  }

  function buildLegend() {
    const counts = {};
    for (const r of ROWS) counts[r.decision] = (counts[r.decision] || 0) + 1;
    document.getElementById('legend').innerHTML = Object.keys(DECISION_LABELS).filter((k) => counts[k]).map((key) => `
      <span class="legend-pill">
        <span class="dot" style="background:${DECISION_COLORS[key]}"></span>
        ${DECISION_LABELS[key]} <span class="count">${counts[key]}</span>
      </span>
    `).join('');
  }

  // Skor reward/punishment kolom (rewardMap.js, persisten sepanjang sesi) - positif = kolom terbukti
  // menghasilkan progres, negatif = kolom terbukti gagal berulang kali (indikasi bot berputar-putar
  // di area yang sama), 0/undefined = belum punya riwayat.
  function rewardClass(score) {
    if (!score) return 'small-muted';
    return score > 0 ? 'flag-ok' : 'flag-bad';
  }
  function formatReward(score) {
    if (!score) return '0';
    return score > 0 ? `+${score}` : `${score}`;
  }

  function appendTableRow(r, idx) {
    const tr = document.createElement('tr');
    tr.dataset.idx = idx;
    const color = DECISION_COLORS[r.decision] || '#9999B0';
    tr.innerHTML = `
      <td>${r.tick}</td>
      <td>${r.pos.x.toFixed(1)}, ${r.pos.y.toFixed(1)}, ${r.pos.z.toFixed(1)}</td>
      <td>${r.dist.toFixed(1)}</td>
      <td><span class="decision-pill" style="background:${color}">${DECISION_LABELS[r.decision] || r.decision}</span></td>
      <td class="${r.aheadSafe ? 'flag-ok' : 'flag-bad'}">${r.aheadSafe ? '✓' : '✗'}</td>
      <td class="${r.noCliffAhead !== false ? 'flag-ok' : 'flag-bad'}">${r.noCliffAhead === false ? '✗' : '✓'}</td>
      <td class="${r.onGround ? 'flag-ok' : 'small-muted'}">${r.onGround ? 'ground' : 'air'}</td>
      <td class="small-muted">${r.waypoint || '-'}</td>
      <td class="small-muted">${r.graphNodes}</td>
      <td class="${rewardClass(r.rewardScore)}">${formatReward(r.rewardScore)}</td>
    `;
    tr.addEventListener('click', () => { followLive = false; selectTick(parseInt(tr.dataset.idx, 10)); });
    tbody.appendChild(tr);
    while (tbody.children.length > MAX_ROWS) tbody.removeChild(tbody.firstChild);
  }

  function selectTick(idx) {
    if (idx < 0 || idx >= ROWS.length) return;
    selectedIndex = idx;
    document.querySelectorAll('#tbody tr').forEach((tr) => tr.classList.toggle('selected', parseInt(tr.dataset.idx, 10) === idx));
    if (followLive) tablewrap.scrollTop = tablewrap.scrollHeight;
    renderDetail(ROWS[idx]);
    drawMap();
  }

  function renderDetail(r) {
    const flags = [
      ['aheadSafe', r.aheadSafe],
      ['withinDescentBudget', r.withinDescentBudget],
      ['noCliffAhead', r.noCliffAhead],
      ['adaRencana', !r.noRealPlan],
      ['onGround', r.onGround]
    ];
    document.getElementById('flagsrow').innerHTML = flags.map(([label, ok]) =>
      `<span class="flagchip ${ok ? 'ok' : 'bad'}">${label}: ${ok ? 'true' : 'false'}</span>`
    ).join('') + `<span class="flagchip">wallFollowSign: ${r.wallFollowSign}</span>
     <span class="flagchip">blockedTicks: ${r.blockedTicks}</span>
     <span class="flagchip">hostiles: ${r.hostiles}</span>
     <span class="flagchip ${r.rewardScore > 0 ? 'ok' : (r.rewardScore < 0 ? 'bad' : '')}">rewardScore: ${r.rewardScore ?? 0}</span>`;

    const grid = document.getElementById('blockgrid');
    if (!r.blocksChecked || r.blocksChecked.length === 0) {
      grid.innerHTML = `<div class="blockcard"><div class="bc-label">tidak ada pengecekan blok tick ini</div></div>`;
    } else {
      grid.innerHTML = r.blocksChecked.map((b) => `
        <div class="blockcard ${b.passable ? 'pass' : 'fail'}">
          <div class="bc-label">${b.label}</div>
          <div class="bc-coord">(${b.x}, ${b.y ?? '?'}, ${b.z})</div>
          <div class="bc-reason">${b.reason || ''}</div>
        </div>
      `).join('');
    }
  }

  function drawMap() {
    const canvas = document.getElementById('mapcanvas');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 240 * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const w = rect.width, h = 240;
    ctx.fillStyle = '#1C1C28';
    ctx.fillRect(0, 0, w, h);

    const upTo = ROWS.slice(0, selectedIndex + 1);
    const window_ = upTo.slice(-400);
    if (window_.length < 2) return;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const r of window_) {
      minX = Math.min(minX, r.pos.x); maxX = Math.max(maxX, r.pos.x);
      minZ = Math.min(minZ, r.pos.z); maxZ = Math.max(maxZ, r.pos.z);
    }
    const pad = 20;
    const spanX = Math.max(maxX - minX, 1), spanZ = Math.max(maxZ - minZ, 1);
    const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanZ);
    const toPx = (x, z) => [
      pad + (x - minX) * scale + (w - pad * 2 - spanX * scale) / 2,
      pad + (z - minZ) * scale + (h - pad * 2 - spanZ * scale) / 2
    ];

    ctx.lineWidth = 1.5;
    for (let i = 1; i < window_.length; i++) {
      const [x1, y1] = toPx(window_[i - 1].pos.x, window_[i - 1].pos.z);
      const [x2, y2] = toPx(window_[i].pos.x, window_[i].pos.z);
      ctx.strokeStyle = DECISION_COLORS[window_[i].decision] || '#888';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    const cur = window_[window_.length - 1];
    const [cx, cy] = toPx(cur.pos.x, cur.pos.z);
    ctx.fillStyle = '#6C63FF';
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();

    if (cur.blocksChecked) {
      for (const b of cur.blocksChecked) {
        const [bx, by] = toPx(b.x + 0.5, b.z + 0.5);
        ctx.fillStyle = b.passable ? '#4CAF50' : '#EF5350';
        ctx.fillRect(bx - 3, by - 3, 6, 6);
      }
    }
  }

  // ── Kontrol Mulai/Hentikan Navigasi ────────────────────────
  document.getElementById('btn-walk-start').addEventListener('click', () => {
    const goal = {
      x: Number(document.getElementById('goal-x').value),
      y: Number(document.getElementById('goal-y').value),
      z: Number(document.getElementById('goal-z').value)
    };
    ROWS = [];
    tbody.innerHTML = '';
    followLive = true;
    walkStatus.textContent = 'Memulai...';
    fetch('/api/walk/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal })
    }).then((r) => r.json()).then((data) => {
      walkStatus.textContent = data.data?.message || 'Berjalan';
    }).catch((e) => { walkStatus.textContent = 'Gagal: ' + e.message; });
  });

  document.getElementById('btn-walk-stop').addEventListener('click', () => {
    fetch('/api/walk/stop', { method: 'POST' })
      .then((r) => r.json())
      .then((data) => { walkStatus.textContent = data.data?.message || 'Dihentikan'; })
      .catch((e) => { walkStatus.textContent = 'Gagal: ' + e.message; });
  });

  tablewrap.addEventListener('scroll', () => {
    // kalau user scroll manual menjauh dari bawah, lepas mode "ikuti live"
    const atBottom = tablewrap.scrollTop + tablewrap.clientHeight >= tablewrap.scrollHeight - 20;
    followLive = atBottom;
  });

  window.addEventListener('resize', () => { if (ROWS.length) drawMap(); });

  connect();
})();
