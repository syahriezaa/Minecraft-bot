/**
 * @file app.js
 * @description Controller utama dashboard — WebSocket connection manager, DOM updater, browser action triggers, dan Click-to-Move.
 */

(function () {
  'use strict';

  // ── State ───────────────────────────────────────────────
  let ws = null;
  let isConnected = false;
  let reconnectTimer = null;
  const RECONNECT_DELAY = 3000;

  // ── DOM Elements ────────────────────────────────────────
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const posX = document.getElementById('pos-x');
  const posY = document.getElementById('pos-y');
  const posZ = document.getElementById('pos-z');
  const botXp = document.getElementById('bot-xp');
  const botMode = document.getElementById('bot-mode');
  const botVelocity = document.getElementById('bot-velocity');
  const totalRuns = document.getElementById('total-runs');
  const totalSuccess = document.getElementById('total-success');
  const totalFailed = document.getElementById('total-failed');
  const avgDuration = document.getElementById('avg-duration');
  const terminalLogs = document.getElementById('terminal-logs');
  const resultsBody = document.getElementById('results-body');
  const progressContainer = document.getElementById('progress-container');
  const progressBar = document.getElementById('progress-bar');
  const progressText = document.getElementById('progress-text');

  // ── WebSocket Connection ────────────────────────────────
  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
      isConnected = true;
      statusDot.classList.add('connected');
      statusText.textContent = 'Terhubung (Port 8080)';
      addTerminalLog('[ Sistem ] WebSocket terhubung ke server pengendali.', 'system');
    };

    ws.onclose = () => {
      isConnected = false;
      statusDot.classList.remove('connected');
      statusText.textContent = 'Terputus';
      addTerminalLog('[ Sistem ] WebSocket terputus. Mencoba sambung ulang...', 'error');
      scheduleReconnect();
    };

    ws.onerror = () => {
      addTerminalLog('[ Sistem ] Kesalahan koneksi WebSocket.', 'error');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (e) {}
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
  }

  // ── Message Handler ─────────────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {
      case 'CONNECTED':
        if (msg.data?.botStatus) updateBotStatus(msg.data.botStatus);
        if (msg.data?.benchmarks) msg.data.benchmarks.forEach(addBenchmarkResult);
        break;
      case 'TICK_UPDATE':
        updateBotStatus(msg.data);
        break;
      case 'BENCHMARK_STATUS':
        handleBenchmarkStatus(msg.data);
        break;
      case 'AI_ACTION_EVENT':
        handleAIEvent(msg.data);
        break;
      case 'TELEMETRY_LOG':
        addTerminalLog(`[ Telemetri ] ${JSON.stringify(msg.data)}`, 'system');
        break;
      case 'SWARM_COORDINATES_UPDATE':
        renderSwarmBots(msg.data);
        break;
    }
  }

  // ── Swarm Bots Real-Time Coordinates Renderer ────────────
  const swarmContainer = document.getElementById('swarm-bots-container');

  function renderSwarmBots(bots) {
    if (!swarmContainer || !Array.isArray(bots)) return;
    swarmContainer.innerHTML = '';

    const badge = document.getElementById('swarm-live-badge');
    if (badge) badge.textContent = `${bots.length} BOT AKTIF`;

    if (bots.length === 0) {
      swarmContainer.innerHTML = '<div class="fleet-empty">Tidak ada bot yang berjalan. Mulai armada tani atau penjaga di bawah.</div>';
      return;
    }

    bots.forEach(bot => {
      const card = document.createElement('div');
      card.className = 'bot-coord-card';
      const s = bot.status || '';
      const statusBadgeClass = ['ATTACK', 'APPROACH', 'RETREAT'].includes(s) ? 'badge-nav'
        : ['HARVEST', 'PLANT', 'DEPOSIT', 'FEED', 'REPAIR'].includes(s) ? 'badge-sort'
        : 'badge-idle';
      
      card.innerHTML = `
        <div class="bot-header">
          <span class="bot-name">${bot.name}</span>
          <span class="bot-role">${bot.role}</span>
        </div>
        <div class="bot-coords">
          <span>X: <strong>${bot.x.toFixed(1)}</strong></span>
          <span>Y: <strong>${bot.y.toFixed(1)}</strong></span>
          <span>Z: <strong>${bot.z.toFixed(1)}</strong></span>
        </div>
        <div class="bot-sub">
          Jarak ke Base: <strong>${bot.distToBase || '?'}m</strong> | 
          Status: <span class="badge-status ${statusBadgeClass}">${bot.status}</span>
        </div>
      `;
      swarmContainer.appendChild(card);
    });
  }

  // Initial fetch koordinat bot saat pertama kali buka
  fetch('/api/swarm/coordinates')
    .then(r => r.json())
    .then(res => {
      if (res.data?.bots) renderSwarmBots(res.data.bots);
    })
    .catch(() => {});

  // ── Bot Status Updater ──────────────────────────────────
  function updateBotStatus(data) {
    if (data.position) {
      posX.textContent = (data.position.x || 0).toFixed(1);
      posY.textContent = (data.position.y || 64).toFixed(1);
      posZ.textContent = (data.position.z || 0).toFixed(1);
    }
    if (data.xp !== undefined || data.level !== undefined) {
      botXp.textContent = `${data.xp || 0} XP (Lv.${data.level || 0})`;
    }
    if (data.mode) botMode.textContent = data.mode;
    if (data.velocity !== undefined) botVelocity.textContent = (data.velocity || 0).toFixed(2);

    if (window.visualizer2d && data.position) {
      window.visualizer2d.addPoint(data.position.x, data.position.z);
    }
  }

  // ── Benchmark Status Handler ────────────────────────────
  function handleBenchmarkStatus(data) {
    if (data.status === 'RUNNING') {
      progressContainer.style.display = 'block';
      progressText.textContent = data.message || `Level ${data.level} berjalan...`;
      progressBar.style.width = '30%';
      addTerminalLog(`[ Benchmark ] ${data.message || 'Level ' + data.level + ' dimulai...'}`, 'warning');
    } else if (data.status === 'SUCCESS' || data.status === 'FAILED') {
      progressBar.style.width = '100%';
      progressText.textContent = `Level ${data.level}: ${data.status}`;
      setTimeout(() => { progressContainer.style.display = 'none'; }, 2000);
      addBenchmarkResult(data);
      addTerminalLog(`[ Benchmark ] Level ${data.level}: ${data.status} (Delta: ${data.coordinateDelta || '?'}m)`, data.status === 'SUCCESS' ? 'system' : 'error');
    }
  }

  // ── AI Event Handler ────────────────────────────────────
  function handleAIEvent(data) {
    addTerminalLog(`[ AI Action ] ${data.step || data.task || JSON.stringify(data)}`, 'system');
    if (window.aiTerminal) {
      window.aiTerminal.addMessage('ai', data.step || data.message || JSON.stringify(data));
    }
  }

  // ── Terminal Log ────────────────────────────────────────
  function addTerminalLog(text, type = '') {
    const line = document.createElement('div');
    line.className = 'terminal-line ' + type;
    line.textContent = `[${new Date().toLocaleTimeString('id-ID')}] ` + text;
    terminalLogs.appendChild(line);
    terminalLogs.scrollTop = terminalLogs.scrollHeight;

    while (terminalLogs.children.length > 200) {
      terminalLogs.removeChild(terminalLogs.firstChild);
    }
  }

  // ── Benchmark Results Table ─────────────────────────────
  let benchmarkCount = 0;
  let successCount = 0;
  let failedCount = 0;
  let totalDuration = 0;

  function addBenchmarkResult(result) {
    const emptyRow = resultsBody.querySelector('.empty-row');
    if (emptyRow) emptyRow.remove();

    benchmarkCount++;
    if (result.success || result.status === 'SUCCESS') successCount++;
    else failedCount++;
    totalDuration += result.duration_ms || 0;

    totalRuns.textContent = benchmarkCount;
    totalSuccess.textContent = successCount;
    totalFailed.textContent = failedCount;
    avgDuration.textContent = Math.round(totalDuration / benchmarkCount) + 'ms';

    const tr = document.createElement('tr');
    const statusClass = (result.success || result.status === 'SUCCESS') ? 'success' : 'failed';
    tr.innerHTML = `
      <td>${result.levelName || 'Level ' + result.level}</td>
      <td><span class="status-badge ${statusClass}">${result.status || (result.success ? 'SUCCESS' : 'FAILED')}</span></td>
      <td>${result.duration_ms ? (result.duration_ms / 1000).toFixed(1) + 's' : '-'}</td>
      <td>${result.coordinateDelta !== undefined ? result.coordinateDelta + 'm' : '-'}</td>
      <td>${result.stuckRecoveryCount || 0}</td>
      <td>${result.timestamp ? new Date(result.timestamp).toLocaleTimeString('id-ID') : '-'}</td>
    `;
    resultsBody.prepend(tr);
  }

  // ── Direct Browser Action Button Triggers ────────────────
  function sendCommand(action, params = {}) {
    addTerminalLog(`[ Browser Control ] Mengirim perintah: '${action}'...`, 'warning');
    fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...params })
    }).then(r => r.json()).then(data => {
      addTerminalLog(`[ Respon Server ] ${data.data?.message || 'Aksi dieksekusi'}`, 'system');
    }).catch(e => {
      addTerminalLog(`[ Error ] Gagal mengirim perintah: ${e.message}`, 'error');
    });
  }

  document.getElementById('btn-action-farm')?.addEventListener('click', () => sendCommand('FARM_ZOMBIE'));
  document.getElementById('btn-action-sort')?.addEventListener('click', () => sendCommand('SORT_CHESTS'));
  document.getElementById('btn-action-trash')?.addEventListener('click', () => sendCommand('INCINERATE_TRASH'));
  document.getElementById('btn-action-walk')?.addEventListener('click', () => sendCommand('AUTO_WALK'));
  document.getElementById('btn-action-stop')?.addEventListener('click', () => sendCommand('EMERGENCY_STOP'));
  
  document.getElementById('btn-action-fleet')?.addEventListener('click', () => {
    addTerminalLog('[ Browser Control ] Meluncurkan Armada Multi-Instance 3 Bot...', 'warning');
    fetch('/api/fleet/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botCount: 3, durationSeconds: 10 })
    }).then(r => r.json()).then(data => {
      addTerminalLog('[ Respon Server ] Armada Multi-Instance aktif!', 'system');
    }).catch(e => addTerminalLog(`[ Error ] ${e.message}`, 'error'));
  });

  document.getElementById('btn-action-live-swarm')?.addEventListener('click', () => {
    addTerminalLog('[ Browser Control ] Meluncurkan Swarm Bot ke live server atoms-girl.tun.ply.gg:25565...', 'warning');
    fetch('/api/swarm/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botNames: ['Bot_Slayer_1', 'Bot_Sorter_2'], server: 'atoms-girl.tun.ply.gg:25565' })
    }).then(r => r.json()).then(data => {
      addTerminalLog(`[ Respon Server ] ${data.data?.message || 'Swarm berhasil diluncurkan ke live server!'}`, 'system');
    }).catch(e => addTerminalLog(`[ Error ] ${e.message}`, 'error'));
  });

  // ── Kontrol armada generik (dipakai pekerja tani & penjaga) ──
  function createFleetController({ apiPrefix, label, listElId, countElId, startBtnId, stopAllBtnId, defaultName, namePrefix, emptyText, statsRenderer }) {
    function apiStart(botName) {
      return fetch(`/api/${apiPrefix}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botName })
      }).then(r => r.json());
    }
    function apiStop(botName) {
      return fetch(`/api/${apiPrefix}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(botName ? { botName } : {})
      }).then(r => r.json());
    }
    function render(workers) {
      const list = document.getElementById(listElId);
      if (!list) return;
      if (!workers || workers.length === 0) {
        list.innerHTML = `<div class="fleet-empty">${emptyText}</div>`;
        return;
      }
      list.innerHTML = workers.map(w => `
        <div class="fleet-row">
          <span class="fleet-row-name">${w.botName}</span>
          <span class="fleet-row-stats">${statsRenderer(w.metrics || {})}</span>
          <button class="btn btn-fleet-stop-one" data-stop-bot="${w.botName}">Hentikan</button>
        </div>`).join('');
      list.querySelectorAll('[data-stop-bot]').forEach(btn => {
        btn.addEventListener('click', () => {
          const name = btn.dataset.stopBot;
          addTerminalLog(`[ Browser Control ] Menghentikan ${label} '${name}'...`, 'warning');
          apiStop(name).then(data => addTerminalLog(`[ Respon Server ] ${data.data?.message || data.error?.message}`, 'system'));
        });
      });
    }
    function poll() {
      fetch(`/api/${apiPrefix}/status`).then(r => r.json()).then(data => render(data.data?.workers)).catch(() => {});
    }

    document.getElementById(startBtnId)?.addEventListener('click', async () => {
      const count = Math.max(1, Math.min(10, Number(document.getElementById(countElId)?.value) || 1));
      addTerminalLog(`[ Browser Control ] Memulai armada ${count} ${label}...`, 'warning');
      for (let i = 1; i <= count; i++) {
        const name = count === 1 ? defaultName : `${namePrefix}${i}`;
        const data = await apiStart(name);
        addTerminalLog(`[ Respon Server ] ${data.data?.message || data.error?.message}`, 'system');
      }
      poll();
    });

    document.getElementById(stopAllBtnId)?.addEventListener('click', () => {
      addTerminalLog(`[ Browser Control ] Menghentikan seluruh armada ${label}...`, 'warning');
      apiStop(null).then(data => {
        addTerminalLog(`[ Respon Server ] ${data.data?.message || data.error?.message}`, 'system');
        poll();
      });
    });

    poll();
    setInterval(poll, 5000);
  }

  createFleetController({
    apiPrefix: 'farmer',
    label: 'pekerja tani',
    listElId: 'farmer-fleet-list',
    countElId: 'farmer-fleet-count',
    startBtnId: 'btn-farmer-fleet-start',
    stopAllBtnId: 'btn-farmer-fleet-stop-all',
    defaultName: 'FarmerWorker',
    namePrefix: 'Farmer',
    emptyText: 'Tidak ada pekerja tani yang berjalan.',
    statsRenderer: (m) => {
      const farm = m.farm || {};
      return `panen <b>${farm.harvested || 0}</b> · tanam <b>${farm.planted || 0}</b> · simpan <b>${farm.deposited || 0}</b>`;
    }
  });

  createFleetController({
    apiPrefix: 'guard',
    label: 'penjaga',
    listElId: 'guard-fleet-list',
    countElId: 'guard-fleet-count',
    startBtnId: 'btn-guard-fleet-start',
    stopAllBtnId: 'btn-guard-fleet-stop-all',
    defaultName: 'GuardWorker',
    namePrefix: 'Guard',
    emptyText: 'Tidak ada penjaga yang berjalan.',
    statsRenderer: (m) => {
      const combat = m.combat || {};
      const repair = m.repair || {};
      return `serang <b>${combat.attacks || 0}</b> · perbaikan <b>${repair.repaired || 0}</b> · besi diambil <b>${repair.gathered || 0}</b>`;
    }
  });

  createFleetController({
    apiPrefix: 'rancher',
    label: 'peternak',
    listElId: 'rancher-fleet-list',
    countElId: 'rancher-fleet-count',
    startBtnId: 'btn-rancher-fleet-start',
    stopAllBtnId: 'btn-rancher-fleet-stop-all',
    defaultName: 'RancherWorker',
    namePrefix: 'Rancher',
    emptyText: 'Tidak ada peternak yang berjalan.',
    statsRenderer: (m) => {
      const animals = m.animals || {};
      return `beri makan <b>${animals.fed || 0}</b> · panen surplus <b>${animals.culled || 0}</b>`;
    }
  });

  createFleetController({
    apiPrefix: 'storage',
    label: 'kuartermaster',
    listElId: 'storage-fleet-list',
    countElId: 'storage-fleet-count',
    startBtnId: 'btn-storage-fleet-start',
    stopAllBtnId: 'btn-storage-fleet-stop-all',
    defaultName: 'StorageWorker',
    namePrefix: 'Storage',
    emptyText: 'Tidak ada kuartermaster yang berjalan.',
    statsRenderer: (m) => {
      const storage = m.storage || {};
      return `kumpul <b>${storage.collected || 0}</b> chest (${storage.itemsCollected || 0} item) · antar <b>${storage.delivered || 0}</b> · periksa <b>${storage.inspected || 0}</b> chest`;
    }
  });

  // ── Benchmark Button Handlers ───────────────────────────
  document.querySelectorAll('.btn-level').forEach(btn => {
    btn.addEventListener('click', () => {
      const level = btn.dataset.level;
      fetch('/api/benchmark/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: Number(level) })
      }).then(r => r.json()).then(data => {
        addTerminalLog(`[ Perintah ] Memulai benchmark Level ${level}...`, 'warning');
      }).catch(e => addTerminalLog(`[ Error ] Gagal memulai benchmark: ${e.message}`, 'error'));
    });
  });

  document.getElementById('btn-all-levels')?.addEventListener('click', () => {
    fetch('/api/benchmark/all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }).then(r => r.json()).then(data => {
      addTerminalLog('[ Perintah ] Memulai benchmark Level 1 → 4...', 'warning');
    }).catch(e => addTerminalLog(`[ Error ] Gagal memulai benchmark: ${e.message}`, 'error'));
  });

  // ── Click-to-Move on Canvas Map ─────────────────────────
  window.addEventListener('canvas_click_target', (e) => {
    const { x, z } = e.detail;
    addTerminalLog(`[ Click-to-Move ] Koordinat target: (${x.toFixed(1)}, ${z.toFixed(1)})`, 'warning');
    sendCommand('NAVIGATE_TO', { target: { x, y: 64, z } });
  });

  // ── Initialize ──────────────────────────────────────────
  connect();
})();
