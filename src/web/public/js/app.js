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
      statusText.textContent = `Terhubung (Port ${location.port || (location.protocol === 'https:' ? '443' : '80')})`;
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
        if (msg.data?.storageConstruction) renderStorageConstruction(msg.data.storageConstruction);
        if (msg.data?.storageMaterials) renderStorageMaterials(msg.data.storageMaterials);
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
      case 'STORAGE_COMPLIANCE_UPDATE':
        renderComplianceLog(msg.data?.events || []);
        break;
      case 'STORAGE_CHEST_MAP_UPDATE':
        storageChests = msg.data?.chests || [];
        renderStorageWorkspace();
        break;
      case 'LANDMARK_FOUND':
        // Landmark baru ditemukan bot explorer - dorong ulang seluruh daftar (bukan cuma tempel
        // satu baris) supaya badge jumlah dan urutan tetap konsisten dengan sumber kebenaran di
        // server, sama pola seperti STORAGE_CHEST_MAP_UPDATE.
        fetch('/api/landmarks').then(r => r.json()).then(res => { if (res.data?.landmarks) renderLandmarks(res.data.landmarks); }).catch(() => {});
        break;
      case 'STORAGE_ASSIGNMENTS_UPDATE':
        // Dorong LANGSUNG lewat WS begitu engine belajar rumah baru untuk suatu item - permintaan
        // nyata pemilik: "use ws to update memory ui to memory is dynamic not just in every
        // restart" - panel "Memori Sortir Worker" genuinely live, bukan nebeng event lain atau
        // cuma ter-update pas restart/reload halaman.
        storageAssignments = msg.data?.assignments || {};
        renderAssignments(storageAssignments);
        break;
      case 'STORAGE_CONSTRUCTION_UPDATE':
        refreshStorageConstruction();
        if (msg.data?.message) addTerminalLog(`[ Pembangunan ] ${msg.data.message}`, msg.data.level === 'error' ? 'error' : 'system');
        break;
      case 'STORAGE_MATERIALS_UPDATE':
        refreshStorageMaterials();
        break;
      case 'MINING_FLEET_UPDATE':
        refreshMiningFleet();
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
      
      const inv = Array.isArray(bot.inventory) ? bot.inventory : [];
      const invHtml = inv.length === 0
        ? '<span class="bot-inventory-empty">Tas kosong</span>'
        : inv.map(i => `<span class="bot-inventory-item">${i.name}<span class="bot-inventory-count">x${i.count}</span></span>`).join('');

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
        <div class="bot-inventory">
          <div class="bot-inventory-label">Isi Tas (${inv.length})</div>
          <div class="bot-inventory-list">${invHtml}</div>
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

  // ── Kepatuhan Kategori Gudang - chest yang ketahuan belum sesuai aturan ──
  const complianceTableBody = document.getElementById('compliance-table-body');
  const complianceCountBadge = document.getElementById('compliance-count-badge');

  function renderComplianceLog(events) {
    if (!complianceTableBody || !Array.isArray(events)) return;
    if (complianceCountBadge) complianceCountBadge.textContent = `${events.length} TERCATAT`;

    if (events.length === 0) {
      complianceTableBody.innerHTML = '<tr class="empty-row"><td colspan="5">Belum ada barang salah tempat yang tercatat.</td></tr>';
      return;
    }

    complianceTableBody.innerHTML = events.map(ev => {
      const time = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString('id-ID') : '-';
      const from = ev.position ? `(${ev.position.x},${ev.position.y},${ev.position.z})` : '-';
      const to = ev.correctPosition ? `(${ev.correctPosition.x},${ev.correctPosition.y},${ev.correctPosition.z})` : '-';
      return `
        <tr>
          <td>${time}</td>
          <td>${ev.botName || '-'}</td>
          <td><span class="compliance-item-name">${ev.count || 1}x ${ev.item || '?'}</span></td>
          <td>${from}</td>
          <td><span class="compliance-arrow">&rarr;</span>${to}</td>
        </tr>
      `;
    }).join('');
  }

  fetch('/api/storage/compliance')
    .then(r => r.json())
    .then(res => {
      if (res.data?.events) renderComplianceLog(res.data.events);
    })
    .catch(() => {});

  // ── Peta Isi Gudang - isi APA ADANYA tiap chest + panah rencana pemindahan ──
  // Disusun sebagai grid baris x kolom mengikuti tata letak fisik ruang gudang sungguhan
  // (baris = ketinggian Y lalu sisi X, kolom = Z sepanjang dinding) plus nama kategori manusiawi
  // per chest - permintaan nyata pemilik: "di ui tampilan peti nya rapikan urut baris dan kolom
  // nya dan berikan nama kategorinya".
  const chestMapContainer = document.getElementById('storage-chest-map');
  const chestMapCountBadge = document.getElementById('chest-map-count-badge');
  const storageSearch = document.getElementById('storage-search');
  const storageStatusFilter = document.getElementById('storage-status-filter');
  const storageFreshness = document.getElementById('storage-freshness');
  const storageSummaryChests = document.getElementById('storage-summary-chests');
  const storageSummaryItems = document.getElementById('storage-summary-items');
  const storageSummaryClean = document.getElementById('storage-summary-clean');
  const storageSummaryMisplaced = document.getElementById('storage-summary-misplaced');
  const storageIssueTabCount = document.getElementById('storage-issue-tab-count');
  const storageChestTabCount = document.getElementById('storage-chest-tab-count');
  const storageSectionButtons = [...document.querySelectorAll('[data-storage-target]')];
  const storageSectionPanels = [...document.querySelectorAll('[data-storage-panel]')];
  const storageModel = window.StorageViewModel;
  let chestCategories = {};
  let storageChests = [];
  let storageAssignments = {};
  let misplacedVisibleLimit = 20;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('id-ID').format(value || 0);
  }

  function storageQuery() {
    return storageSearch?.value.trim().toLowerCase() || '';
  }

  function activateStorageSection(target) {
    storageSectionButtons.forEach(button => {
      const active = button.dataset.storageTarget === target;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    storageSectionPanels.forEach(panel => { panel.hidden = panel.dataset.storagePanel !== target; });
  }

  storageSectionButtons.forEach(button => {
    button.addEventListener('click', () => activateStorageSection(button.dataset.storageTarget));
  });

  fetch('/api/storage/categories')
    .then(r => r.json())
    .then(res => {
      chestCategories = res.data?.categories || {};
      renderStorageWorkspace();
    })
    .catch(() => {});

  function posLabel(p) {
    return p ? `(${p.x},${p.y},${p.z})` : '-';
  }

  function categoryFor(p) {
    if (!p) return null;
    return chestCategories[`${p.x},${p.y},${p.z}`] || null;
  }

  function renderChestMap(chests) {
    if (!chestMapContainer || !Array.isArray(chests)) return;
    const filteredChests = storageModel.filterChests(
      chests, chestCategories, storageQuery(), storageStatusFilter?.value || 'all'
    );
    if (chestMapCountBadge) chestMapCountBadge.textContent = `${filteredChests.length} DARI ${chests.length} PETI`;

    if (filteredChests.length === 0) {
      chestMapContainer.innerHTML = chests.length === 0
        ? '<p class="empty-row">Belum ada peti yang diperiksa. Jalankan kuartermaster untuk mulai memetakan gudang.</p>'
        : '<p class="empty-row">Tidak ada peti yang cocok dengan pencarian atau filter ini.</p>';
      return;
    }

    // Kelompokkan jadi "baris rak": satu baris per kombinasi Y (ketinggian) + X (sisi depan/
    // belakang lorong) - persis struktur fisik ruang gudang. Di dalam tiap baris, kartu diurutkan
    // sepanjang Z (kolom) supaya tata letaknya konsisten dan mencerminkan urutan sungguhan di
    // dunia, bukan urutan acak setiap ada snapshot baru masuk.
    const aisles = new Map();
    for (const chest of filteredChests) {
      const aisleKey = `${chest.position.y}|${chest.position.x}`;
      if (!aisles.has(aisleKey)) aisles.set(aisleKey, { y: chest.position.y, x: chest.position.x, chests: [] });
      aisles.get(aisleKey).chests.push(chest);
    }
    const sortedAisles = [...aisles.values()].sort((a, b) => a.y - b.y || b.x - a.x);

    chestMapContainer.innerHTML = sortedAisles.map(aisle => {
      const cards = [...aisle.chests].sort((a, b) => a.position.z - b.position.z).map(chest => {
        const items = storageModel.aggregateItems(chest.items);
        const misplacedNames = new Set((chest.misplaced || []).map(m => m.name));
        const misplacedByName = new Map((chest.misplaced || []).map(m => [m.name, m]));

        const rows = items.length === 0
          ? '<div class="chest-map-empty">(kosong)</div>'
          : items.map(it => {
              const isMisplaced = misplacedByName.has(it.name);
              const target = isMisplaced ? misplacedByName.get(it.name).targetPosition : null;
              return `
                <div class="chest-map-item-row${isMisplaced ? ' chest-map-item-misplaced' : ''}">
                  <span class="chest-map-item-name">${escapeHtml(it.name)}</span>
                  <span class="chest-map-item-count">${formatNumber(it.count)}</span>
                  ${isMisplaced ? `<span class="chest-map-arrow" title="Akan dipindah ke ${posLabel(target)}">&rarr; ${posLabel(target)}</span>` : ''}
                </div>
              `;
            }).join('');

        const misplacedCount = misplacedNames.size;
        const time = chest.timestamp ? new Date(chest.timestamp).toLocaleTimeString('id-ID') : '-';
        const category = categoryFor(chest.position);

        return `
          <div class="chest-map-card${misplacedCount > 0 ? ' chest-map-card-dirty' : ''}">
            <div class="chest-map-card-header">
              <span class="chest-map-category">${escapeHtml(category || 'Tanpa kategori')}</span>
              ${misplacedCount > 0
                ? `<span class="chest-map-badge chest-map-badge-dirty">${misplacedCount} SALAH TEMPAT</span>`
                : '<span class="chest-map-badge chest-map-badge-clean">BERSIH</span>'}
            </div>
            <span class="chest-map-pos">${posLabel(chest.position)}</span>
            <div class="chest-map-items">${rows}</div>
            <div class="chest-map-updated">Diperiksa: ${time}</div>
          </div>
        `;
      }).join('');

      return `
        <div class="chest-map-aisle">
          <div class="chest-map-aisle-label">Y=${aisle.y} &middot; X=${aisle.x}</div>
          <div class="chest-map-aisle-row">${cards}</div>
        </div>
      `;
    }).join('');
  }

  fetch('/api/storage/chests')
    .then(r => r.json())
    .then(res => {
      if (res.data?.chests) {
        storageChests = res.data.chests;
        renderStorageWorkspace();
      }
    })
    .catch(() => {});

  // ── Item Salah Tempat Saat Ini - rangkuman TERKINI (bukan log historis), dikumpulkan dari
  // seluruh chest yang sudah dipetakan - permintaan nyata pemilik: "tampilkan item yang tidak
  // tepat dan item yang akan di pindah dan di pindah kemana" ──
  const misplacedNowBody = document.getElementById('misplaced-now-table-body');
  const misplacedNowCountBadge = document.getElementById('misplaced-now-count-badge');
  const misplacedNowFooter = document.getElementById('misplaced-now-footer');
  const misplacedNowMeta = document.getElementById('misplaced-now-meta');
  const misplacedNowMore = document.getElementById('misplaced-now-more');

  function renderMisplacedNow(chests) {
    if (!misplacedNowBody || !Array.isArray(chests)) return;
    const filteredChests = storageModel.filterChests(chests, chestCategories, storageQuery(), 'dirty');
    let rows = storageModel.aggregateMisplaced(filteredChests);
    const query = storageQuery();
    if (query) {
      rows = rows.filter(row => `${row.name} ${posLabel(row.from)} ${posLabel(row.to)}`.toLowerCase().includes(query));
    }
    const totalUnits = rows.reduce((total, row) => total + row.count, 0);
    if (misplacedNowCountBadge) misplacedNowCountBadge.textContent = `${formatNumber(totalUnits)} BARANG`;

    if (rows.length === 0) {
      misplacedNowBody.innerHTML = `<tr class="empty-row"><td colspan="5">${chests.length ? 'Tidak ada item salah tempat yang cocok dengan pencarian.' : 'Belum ada item salah tempat yang terdeteksi saat ini.'}</td></tr>`;
      if (misplacedNowFooter) misplacedNowFooter.hidden = true;
      return;
    }

    const visibleRows = rows.slice(0, misplacedVisibleLimit);
    misplacedNowBody.innerHTML = visibleRows.map(r => `
      <tr>
        <td><span class="compliance-item-name">${escapeHtml(r.name)}</span></td>
        <td>${formatNumber(r.count)}</td>
        <td>${r.stacks}</td>
        <td>${posLabel(r.from)}</td>
        <td><span class="compliance-arrow">&rarr;</span>${posLabel(r.to)}</td>
      </tr>
    `).join('');
    if (misplacedNowFooter) misplacedNowFooter.hidden = rows.length <= 20;
    if (misplacedNowMeta) misplacedNowMeta.textContent = `Menampilkan ${visibleRows.length} dari ${rows.length} kelompok pemindahan`;
    if (misplacedNowMore) misplacedNowMore.hidden = visibleRows.length >= rows.length;
  }

  misplacedNowMore?.addEventListener('click', () => {
    misplacedVisibleLimit += 20;
    renderMisplacedNow(storageChests);
  });

  // ── Memori Sortir Worker - persis engine.getChestAssignments(), tanpa olahan ──
  const assignmentsContainer = document.getElementById('storage-assignments-map');
  const assignmentsCountBadge = document.getElementById('assignments-count-badge');

  function renderAssignments(assignments) {
    if (!assignmentsContainer || !assignments || typeof assignments !== 'object') return;
    const query = storageQuery();
    const entries = Object.entries(assignments).filter(([itemName, chestKey]) => (
      !query || `${itemName} ${chestKey}`.toLowerCase().includes(query)
    )); // [itemName, "x,y,z"][] - nilai tetap persis dari engine
    if (assignmentsCountBadge) assignmentsCountBadge.textContent = `${entries.length} JENIS ITEM`;

    if (entries.length === 0) {
      assignmentsContainer.innerHTML = '<p class="empty-row">Belum ada memori sortir yang dimuat - jalankan kuartermaster untuk melihat isinya.</p>';
      return;
    }

    // Kelompokkan per chest tujuan untuk keterbacaan - nilai yang ditampilkan (nama item, posisi
    // chest) TETAP persis string yang sama dari engine.getChestAssignments(), cuma dikelompokkan.
    const byChest = new Map();
    entries.forEach(([itemName, chestKey]) => {
      if (!byChest.has(chestKey)) byChest.set(chestKey, []);
      byChest.get(chestKey).push(itemName);
    });

    const sortedChests = [...byChest.keys()].sort();

    assignmentsContainer.innerHTML = sortedChests.map(chestKey => {
      const items = byChest.get(chestKey).sort();
      const rows = items.map(name => `<div class="chest-map-item-row"><span class="chest-map-item-name">${escapeHtml(name)}</span></div>`).join('');
      return `
        <div class="chest-map-card">
          <div class="chest-map-card-header">
            <span class="chest-map-pos">(${escapeHtml(chestKey)})</span>
            <span class="chest-map-badge chest-map-badge-clean">${items.length} JENIS</span>
          </div>
          <div class="chest-map-items">${rows}</div>
        </div>
      `;
    }).join('');
  }

  fetch('/api/storage/assignments')
    .then(r => r.json())
    .then(res => {
      if (res.data?.assignments) {
        storageAssignments = res.data.assignments;
        renderAssignments(storageAssignments);
      }
    })
    .catch(() => {});

  function renderStorageWorkspace() {
    const summary = storageModel.summarizeStorage(storageChests);
    if (storageSummaryChests) storageSummaryChests.textContent = formatNumber(summary.chests);
    if (storageSummaryItems) storageSummaryItems.textContent = formatNumber(summary.itemUnits);
    if (storageSummaryClean) storageSummaryClean.textContent = formatNumber(summary.cleanChests);
    if (storageSummaryMisplaced) storageSummaryMisplaced.textContent = formatNumber(summary.misplacedUnits);
    if (storageIssueTabCount) storageIssueTabCount.textContent = formatNumber(summary.misplacedUnits);
    if (storageChestTabCount) storageChestTabCount.textContent = formatNumber(summary.chests);

    const latestTimestamp = storageChests.reduce((latest, chest) => Math.max(latest, Number(chest.timestamp) || 0), 0);
    if (storageFreshness) {
      const stale = latestTimestamp > 0 && Date.now() - latestTimestamp > 5 * 60 * 1000;
      storageFreshness.classList.toggle('stale', stale);
      storageFreshness.textContent = latestTimestamp
        ? `${stale ? 'Data lama · ' : ''}Pemetaan terakhir ${new Date(latestTimestamp).toLocaleString('id-ID', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}`
        : 'Menunggu pemetaan';
    }
    renderChestMap(storageChests);
    renderMisplacedNow(storageChests);
    renderAssignments(storageAssignments);
  }

  storageSearch?.addEventListener('input', () => {
    misplacedVisibleLimit = 20;
    renderStorageWorkspace();
  });
  storageStatusFilter?.addEventListener('change', () => {
    activateStorageSection('chests');
    renderStorageWorkspace();
  });

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
    // Minecraft menyimpan posisi terakhir berdasarkan username. Username tetap seperti
    // WoodGatherer1 dapat membuat sesi baru login kembali di dalam gua atau di bawah air,
    // lalu worker berhenti sebelum sempat bekerja. Satu tag sesi membedakan armada baru,
    // sedangkan index membedakan bot dalam armada; potong ke 16 karakter sesuai batas server.
    const sessionBotName = (index, tag) => `${namePrefix}${tag}${index}`.slice(0, 16);

    function apiStart(botName, fleetIndex, fleetSize) {
      return fetch(`/api/${apiPrefix}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botName, fleetIndex, fleetSize })
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
      const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
      const liveStatus = status => {
        if (!status) return '<span class="worker-live-status is-unknown">STATUS BELUM TERSEDIA</span>';
        const position = status.position
          ? ` @ ${Number(status.position.x).toFixed(1)},${Number(status.position.y).toFixed(1)},${Number(status.position.z).toFixed(1)}`
          : '';
        return `<span class="worker-live-status">${escapeHtml(status.status || 'UNKNOWN')}${escapeHtml(position)}</span>`;
      };
      list.innerHTML = workers.map(w => `
        <div class="fleet-row">
          <span class="fleet-row-name">${escapeHtml(w.botName)}</span>
          ${liveStatus(w.status)}
          <span class="fleet-row-stats">${statsRenderer(w.metrics || {})}</span>
          <button class="btn btn-fleet-stop-one" data-stop-bot="${escapeHtml(w.botName)}">Hentikan</button>
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
      const sessionTag = Date.now().toString(36).slice(-3);
      addTerminalLog(`[ Browser Control ] Memulai armada ${count} ${label}...`, 'warning');
      for (let i = 1; i <= count; i++) {
        const name = sessionBotName(i, sessionTag);
        const data = await apiStart(name, i - 1, count);
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

  // Lifecycle pembangunan terintegrasi dengan coordinator server; tidak lagi meluncurkan
  // runner storage dari terminal secara terpisah dari dashboard.
  const constructionStatus = document.getElementById('storage-construction-status');
  const constructionWorkers = document.getElementById('storage-construction-workers');
  const constructionLastLog = document.getElementById('storage-construction-last-log');

  const constructionPhaseLabels = {
    IDLE: 'Siap',
    STARTING: 'Memulai',
    WAITING_FOR_SERVER: 'Menunggu server Minecraft',
    BUILDING_AND_LANDSCAPING: 'Membangun + meratakan lahan',
    PARTIAL_ATTENTION: 'Sebagian berjalan; perlu perhatian',
    STOPPING: 'Menghentikan',
    STOPPED: 'Berhenti',
    ERROR: 'Perlu perhatian',
    NEEDS_ATTENTION: 'Perlu perhatian'
  };
  const workerStatusLabels = {
    QUEUED: 'Menunggu giliran',
    STARTING: 'Memulai',
    RUNNING: 'Berjalan',
    STOPPING: 'Menghentikan',
    STOPPED: 'Berhenti',
    EXITED: 'Selesai',
    RESTARTING: 'Mulai ulang',
    ERROR: 'Error',
    PREPARE: 'Persiapan',
    BUILD: 'Membangun',
    RESTOCK: 'Mengambil material',
    WAITING_MATERIAL: 'Menunggu persediaan',
    WAITING_FOR_FLOOR: 'Menunggu lantai',
    COMPLETE: 'Selesai',
    BLOCKED: 'Terblokir'
  };
  const constructionRoleLabels = {
    builder: 'Builder',
    chestInstaller: 'Pemasang peti',
    landscaper: 'Landscaping + support audit'
  };

  function renderStorageConstruction(data) {
    if (!data) return;
    const phase = data.phase || (data.active ? 'RUNNING' : 'IDLE');
    if (constructionStatus) {
      constructionStatus.textContent = constructionPhaseLabels[phase] || phase.replaceAll('_', ' ');
      constructionStatus.dataset.state = data.active ? 'active' : phase.toLowerCase();
    }
    if (constructionWorkers) {
      const workers = Object.values(data.children || {});
      constructionWorkers.innerHTML = workers.length
        ? workers.map(worker => {
          const role = worker.role || 'Worker';
          const status = worker.status || 'UNKNOWN';
          const statusClass = status.toLowerCase();
          return `<div class="fleet-row construction-worker-row">
            <div class="construction-worker-main">
              <span class="fleet-row-name">${role}</span>
              <span class="construction-worker-role">${constructionRoleLabels[role] || 'Construction worker'}</span>
            </div>
            <span class="fleet-row-stats construction-worker-status ${statusClass}">${workerStatusLabels[status] || status}${worker.pid ? ` · PID ${worker.pid}` : ''}</span>
          </div>`;
        }).join('')
        : '<div class="fleet-empty">Belum ada worker pembangunan aktif.</div>';
    }
    const last = data.recentLogs?.at(-1);
    if (constructionLastLog) {
      constructionLastLog.textContent = last ? `[${last.role}] ${last.message}` : 'Belum ada sesi pembangunan.';
      constructionLastLog.title = last?.message || '';
    }
  }

  function refreshStorageConstruction() {
    fetch('/api/storage/construction/status').then(r => r.json()).then(res => renderStorageConstruction(res.data)).catch(() => {});
  }

  document.getElementById('btn-storage-construction-start')?.addEventListener('click', () => {
    addTerminalLog('[ Browser Control ] Memulai builder, landscaper, dan antrean pemasang peti storage room...', 'warning');
    fetch('/api/storage/construction/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ builderWorkerCount: 2, builderBatch: 16, landscaperWorkerCount: 1, roleStartStaggerMs: 6000 })
    }).then(r => r.json()).then(data => {
      addTerminalLog(`[ Respon Server ] ${data.data?.status?.phase || data.error?.message || 'Perintah diterima'}`, 'system');
      refreshStorageConstruction();
    }).catch(error => addTerminalLog(`[ Error ] ${error.message}`, 'error'));
  });

  document.getElementById('btn-storage-construction-stop')?.addEventListener('click', () => {
    fetch('/api/storage/construction/stop', { method: 'POST' }).then(r => r.json()).then(data => {
      addTerminalLog(`[ Respon Server ] ${data.data?.status?.phase || data.error?.message || 'Perintah diterima'}`, 'system');
      refreshStorageConstruction();
    }).catch(error => addTerminalLog(`[ Error ] ${error.message}`, 'error'));
  });
  refreshStorageConstruction();
  setInterval(refreshStorageConstruction, 5000);

  const materialsStatus = document.getElementById('storage-materials-status');
  const materialsSummary = document.getElementById('storage-materials-summary');
  const materialsLastLog = document.getElementById('storage-materials-last-log');

  function renderStorageMaterials(data) {
    if (!data) return;
    const phase = data.phase || (data.active ? 'RUNNING' : 'IDLE');
    const labels = {
      IDLE: 'SIAP', STARTING: 'MEMULAI', RUNNING: 'BERJALAN', PREPARE: 'PERSIAPAN',
      LOGISTICS: 'LOGISTIK', WAITING_MATERIAL: 'MENUNGGU MATERIAL', RESTARTING: 'MULAI ULANG',
      STOPPING: 'MENGHENTIKAN', STOPPED: 'BERHENTI', COMPLETE: 'SELESAI',
      BLOCKED: 'TERBLOKIR', NEEDS_ATTENTION: 'PERLU PERHATIAN'
    };
    if (materialsStatus) {
      materialsStatus.textContent = labels[phase] || phase.replaceAll('_', ' ');
      materialsStatus.dataset.state = data.active ? 'active' : phase.toLowerCase();
      materialsStatus.title = data.lastError || '';
    }
    if (materialsSummary) {
      const bot = data.botName ? ` · ${data.botName}` : '';
      materialsSummary.textContent = data.active || data.startedAt
        ? `fase ${labels[phase] || phase}${bot} · siklus ${data.cycle || 0} · produksi ${data.produced || 0} · diantar ${data.deposited || 0}${data.restarts ? ` · restart ${data.restarts}` : ''}`
        : 'Belum ada worker materials aktif.';
    }
    const last = data.recentLogs?.at(-1);
    if (materialsLastLog) {
      materialsLastLog.textContent = last?.message || data.lastMessage || 'Belum ada sesi materials.';
      materialsLastLog.title = last?.message || data.lastMessage || '';
    }
  }

  function refreshStorageMaterials() {
    fetch('/api/storage/materials/status').then(r => r.json()).then(res => renderStorageMaterials(res.data)).catch(() => {});
  }

  document.getElementById('btn-storage-materials-start')?.addEventListener('click', () => {
    addTerminalLog('[ Browser Control ] Memulai worker smelting/crafting materials...', 'warning');
    fetch('/api/storage/materials/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botName: 'StorageMatUI' })
    }).then(r => r.json()).then(data => {
      addTerminalLog(`[ Respon Server ] ${data.data?.status?.phase || data.error?.message || 'Perintah diterima'}`, data.success ? 'system' : 'error');
      renderStorageMaterials(data.data?.status);
    }).catch(error => addTerminalLog(`[ Error ] ${error.message}`, 'error'));
  });

  document.getElementById('btn-storage-materials-stop')?.addEventListener('click', () => {
    fetch('/api/storage/materials/stop', { method: 'POST' }).then(r => r.json()).then(data => {
      addTerminalLog(`[ Respon Server ] ${data.data?.status?.phase || data.error?.message || 'Perintah diterima'}`, data.success ? 'system' : 'error');
      renderStorageMaterials(data.data?.status);
    }).catch(error => addTerminalLog(`[ Error ] ${error.message}`, 'error'));
  });

  refreshStorageMaterials();
  setInterval(refreshStorageMaterials, 5000);

  const miningStatus = document.getElementById('mining-fleet-status');
  const miningWorkers = document.getElementById('mining-fleet-workers');
  const miningError = document.getElementById('mining-fleet-error');

  function readMiningOptions() {
    const corners = Array.from({ length: 4 }, (_, index) => ({
      x: Number(document.getElementById(`mining-corner-${index + 1}-x`)?.value),
      z: Number(document.getElementById(`mining-corner-${index + 1}-z`)?.value)
    }));
    const count = Number(document.getElementById('mining-fleet-count')?.value);
    const mode = document.getElementById('mining-mode')?.value || 'surface_to_floor';
    const floorY = Number(document.getElementById('mining-floor-y')?.value);
    const maxY = Number(document.getElementById('mining-max-y')?.value);
    if (![count, floorY, maxY, ...corners.flatMap(point => [point.x, point.z])].every(Number.isInteger)) throw new Error('Semua koordinat dan jumlah worker wajib berupa bilangan bulat.');
    if (count < 1 || count > 4) throw new Error('Jumlah worker harus antara 1 sampai 4.');
    const xs = new Set(corners.map(point => point.x));
    const zs = new Set(corners.map(point => point.z));
    const points = new Set(corners.map(point => `${point.x},${point.z}`));
    if (xs.size !== 2 || zs.size !== 2 || points.size !== 4) throw new Error('Empat sudut harus membentuk persegi panjang X/Z tanpa titik duplikat.');
    if (floorY >= maxY) throw new Error('Floor Y harus lebih rendah dari Max Y.');
    return { count, mode, floorY, maxY, corners, minInventoryFillRatio: 0.75 };
  }

  function renderMiningFleet(data) {
    if (!data) return;
    const phase = data.phase || 'IDLE';
    if (miningStatus) {
      const labels = { IDLE: 'SIAP', MINING: 'MENAMBANG', STOPPING: 'BERHENTI', STOPPED: 'BERHENTI', COMPLETE: 'SELESAI', NEEDS_ATTENTION: 'PERLU PERHATIAN' };
      const modeLabel = data.config?.mode === 'strip_surface_to_floor'
        ? ' · STRIP + TANGGA'
        : data.config?.mode === 'surface_flat_then_stair'
          ? ' · RATakan → TANGGA'
          : data.config?.mode === 'surface_to_floor' ? ' · PERMUKAAN' : '';
      miningStatus.textContent = `${labels[phase] || phase.replaceAll('_', ' ')}${modeLabel}`;
      if (data.config?.maxSafeDrop) miningStatus.title = `Batas jatuh aman: ${data.config.maxSafeDrop} blok`;
      miningStatus.dataset.state = data.active ? 'active' : phase.toLowerCase();
    }
    if (miningWorkers) {
      const workers = Object.values(data.workers || {});
      miningWorkers.innerHTML = workers.length ? workers.map(worker => `
        <div class="fleet-row construction-worker-row">
          <div class="construction-worker-main">
            <span class="fleet-row-name">${worker.name}</span>
            <span class="construction-worker-role">Region ${worker.region}</span>
          </div>
          <span class="fleet-row-stats construction-worker-status ${String(worker.phase || '').toLowerCase()}">${worker.phase || 'UNKNOWN'}${Number.isFinite(worker.inventoryFillRatio) ? ` · tas ${Math.round(worker.inventoryFillRatio * 100)}%` : ''}${Number.isInteger(worker.verifiedBlocks) ? ` · ${worker.verifiedBlocks} blok` : ''}</span>
        </div>`).join('') : '<div class="fleet-empty">Tidak ada worker tambang yang berjalan.</div>';
    }
    if (miningError) miningError.textContent = data.lastError || '';
  }

  function refreshMiningFleet() {
    fetch('/api/mining/status').then(response => response.json()).then(result => renderMiningFleet(result.data)).catch(() => {});
  }

  document.getElementById('btn-mining-fleet-start')?.addEventListener('click', async () => {
    try {
      const options = readMiningOptions();
      if (miningError) miningError.textContent = '';
      addTerminalLog(`[ Tambang ] Memulai ${options.count} worker pada area empat sudut...`, 'warning');
      const response = await fetch('/api/mining/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || 'Gagal memulai worker tambang.');
      renderMiningFleet(result.data?.status);
      addTerminalLog(`[ Tambang ] ${options.count} worker dimulai.`, 'system');
    } catch (error) {
      if (miningError) miningError.textContent = error.message;
      addTerminalLog(`[ Tambang ] ${error.message}`, 'error');
    }
  });

  document.getElementById('btn-mining-fleet-stop')?.addEventListener('click', async () => {
    const response = await fetch('/api/mining/stop', { method: 'POST' });
    const result = await response.json();
    if (miningError) miningError.textContent = response.ok ? '' : (result.error?.message || 'Gagal menghentikan worker tambang.');
    refreshMiningFleet();
  });

  refreshMiningFleet();
  setInterval(refreshMiningFleet, 5000);

  createFleetController({
    apiPrefix: 'explorer',
    label: 'penjelajah',
    listElId: 'explorer-fleet-list',
    countElId: 'explorer-fleet-count',
    startBtnId: 'btn-explorer-fleet-start',
    stopAllBtnId: 'btn-explorer-fleet-stop-all',
    defaultName: 'ExplorerWorker',
    namePrefix: 'Explorer',
    emptyText: 'Tidak ada penjelajah yang berjalan.',
    statsRenderer: (m) => {
      const explorer = m.explorer || {};
      return `waypoint <b>${explorer.waypointsVisited || 0}</b> · landmark ditemukan <b>${explorer.landmarksFound || 0}</b>`;
    }
  });

  // ── Landmark Dunia - temuan bot explorer ──
  const landmarksList = document.getElementById('landmarks-list');
  const landmarksCountBadge = document.getElementById('landmarks-count-badge');
  const landmarksCategoryFilter = document.getElementById('landmarks-category-filter');
  const landmarksSearch = document.getElementById('landmarks-search');
  const landmarksMeta = document.getElementById('landmarks-meta');
  const landmarksPageIndicator = document.getElementById('landmarks-page');
  const landmarksPrev = document.getElementById('landmarks-prev');
  const landmarksNext = document.getElementById('landmarks-next');
  let allLandmarks = [];
  let landmarksPage = 1;
  const LANDMARK_PAGE_SIZE = 8;

  function renderLandmarks(landmarks) {
    if (!landmarksList || !Array.isArray(landmarks)) return;
    allLandmarks = landmarks;
    landmarksPage = 1;

    if (landmarksCategoryFilter) {
      const selectedCategory = landmarksCategoryFilter.value;
      const categories = [...new Set(landmarks.map(landmark => landmark.category).filter(Boolean))].sort();
      landmarksCategoryFilter.innerHTML = '<option value="">Semua kategori</option>' + categories
        .map(category => `<option value="${category}">${category}</option>`).join('');
      landmarksCategoryFilter.value = categories.includes(selectedCategory) ? selectedCategory : '';
    }

    renderLandmarkPage();
  }

  function renderLandmarkPage() {
    const query = (landmarksSearch?.value || '').trim().toLowerCase();
    const category = landmarksCategoryFilter?.value || '';
    const filtered = allLandmarks.filter(landmark => {
      const matchesCategory = !category || landmark.category === category;
      const searchable = `${landmark.name || ''} ${landmark.category || ''}`.toLowerCase();
      return matchesCategory && (!query || searchable.includes(query));
    });
    const totalPages = Math.max(1, Math.ceil(filtered.length / LANDMARK_PAGE_SIZE));
    landmarksPage = Math.min(landmarksPage, totalPages);
    const start = (landmarksPage - 1) * LANDMARK_PAGE_SIZE;
    const pageItems = filtered.slice(start, start + LANDMARK_PAGE_SIZE);

    if (landmarksCountBadge) landmarksCountBadge.textContent = `${allLandmarks.length} LANDMARK`;
    if (landmarksMeta) {
      landmarksMeta.textContent = filtered.length
        ? `Menampilkan ${start + 1}-${start + pageItems.length} dari ${filtered.length} landmark`
        : (allLandmarks.length ? 'Tidak ada landmark yang cocok dengan filter.' : 'Belum ada landmark.');
    }
    if (landmarksPageIndicator) landmarksPageIndicator.textContent = `Halaman ${landmarksPage} / ${totalPages}`;
    if (landmarksPrev) landmarksPrev.disabled = landmarksPage <= 1;
    if (landmarksNext) landmarksNext.disabled = landmarksPage >= totalPages;

    if (pageItems.length === 0) {
      landmarksList.innerHTML = `<p class="empty-row">${allLandmarks.length ? 'Tidak ada landmark yang cocok.' : 'Belum ada landmark yang ditemukan - jalankan armada penjelajah untuk mulai menandai.'}</p>`;
      return;
    }

    landmarksList.innerHTML = pageItems.map((l) => {
      const locLabel = l.shape === 'point'
        ? `(${l.position.x},${l.position.y},${l.position.z})`
        : `poligon ${l.boundary.length} titik`;
      return `
        <div class="chest-map-card">
          <div class="chest-map-card-header">
            <span class="chest-map-category">${l.name}</span>
            <span class="chest-map-badge chest-map-badge-clean">${l.category}</span>
          </div>
          <span class="chest-map-pos">${locLabel}</span>
        </div>
      `;
    }).join('');
  }

  landmarksCategoryFilter?.addEventListener('change', () => {
    landmarksPage = 1;
    renderLandmarkPage();
  });
  landmarksSearch?.addEventListener('input', () => {
    landmarksPage = 1;
    renderLandmarkPage();
  });
  landmarksPrev?.addEventListener('click', () => {
    landmarksPage = Math.max(1, landmarksPage - 1);
    renderLandmarkPage();
  });
  landmarksNext?.addEventListener('click', () => {
    landmarksPage += 1;
    renderLandmarkPage();
  });

  fetch('/api/landmarks')
    .then(r => r.json())
    .then(res => { if (res.data?.landmarks) renderLandmarks(res.data.landmarks); })
    .catch(() => {});

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
    apiPrefix: 'mobfarm',
    label: 'pemburu spawner',
    listElId: 'mobfarm-fleet-list',
    countElId: 'mobfarm-fleet-count',
    startBtnId: 'btn-mobfarm-fleet-start',
    stopAllBtnId: 'btn-mobfarm-fleet-stop-all',
    defaultName: 'MobFarmWorker',
    namePrefix: 'MobFarm',
    emptyText: 'Tidak ada pemburu spawner yang berjalan.',
    statsRenderer: (m) => {
      const combat = m.combat || {};
      return `serang <b>${combat.attacks || 0}</b> · mundur <b>${combat.retreats || 0}</b>`;
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
      return `kumpul <b>${storage.collected || 0}</b> chest (${storage.itemsCollected || 0} item) · antar <b>${storage.delivered || 0}</b> · periksa <b>${storage.inspected || 0}</b> chest · rapikan <b>${storage.reorganized || 0}</b> item salah tempat`;
    }
  });

  createFleetController({
    apiPrefix: 'wood-gatherer',
    label: 'forestry',
    listElId: 'wood-gatherer-list',
    countElId: 'wood-gatherer-count',
    startBtnId: 'btn-wood-gatherer-start',
    stopAllBtnId: 'btn-wood-gatherer-stop',
    defaultName: 'WoodDiag1',
    namePrefix: 'WoodGatherer',
    emptyText: 'Tidak ada worker forestry yang berjalan.',
    statsRenderer: m => `pohon <b>${m.trees || 0}</b> · kayu <b>${m.logs || 0}</b> · tas <b>${m.carriedLogs || 0}</b> · tanam <b>${m.saplingsPlanted || 0}</b> · antar <b>${m.delivered || 0}</b>`
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
