/**
 * @file chunkMatrix.js
 * @description Grid zoomable seluruh kolom blok (x,z) yang sudah "dibaca" bot lewat chunk yang
 * dimuat - satu sel = satu kolom, warna = ketinggian tanah (sequential, satu hue terang->gelap).
 * Jalur yang BENAR-BENAR dilewati bot ditandai terpisah dari kolom yang cuma diketahui pasif, dan
 * tiap sel yang pernah dicek langsung (blocksChecked dari DECISION_TICK) menyimpan alasan +
 * status lolos/tidaknya. Biaya (cost) tiap langkah jalur dihitung memakai rumus yang SAMA dengan
 * pathfinder.js (naik = penalti tetap, turun = biaya kecil per blok, datar = jarak murni) supaya
 * konsisten dengan apa yang benar-benar dipakai A* untuk memutuskan rute.
 */

(function () {
  'use strict';

  // Sama persis dengan JUMP_UP_PENALTY & DROP_COST_PER_BLOCK di src/ai/pathfinder.js &
  // chunkConnectivityGraph.js - kalau nilai itu berubah di backend, ubah juga di sini.
  const JUMP_UP_PENALTY = 3.0;
  const DROP_COST_PER_BLOCK = 0.3;
  function moveCost(dx, dy, dz) {
    const horizontal = Math.hypot(dx, dz);
    if (dy > 0) return horizontal + JUMP_UP_PENALTY;
    if (dy < 0) return horizontal + Math.abs(dy) * DROP_COST_PER_BLOCK;
    return horizontal;
  }

  const nodesMap = new Map(); // "x,z" -> {x,y,z}
  // Indeks spasial (ember/bucket) - dataset sudah sampai jutaan simpul (sapuan grid area luas),
  // render() yang meng-iterasi SEMUA nodesMap tiap frame (termasuk tiap drag/zoom) jadi sangat
  // lambat di skala ini. Kelompokkan simpul per ember BUCKET_SIZE blok, supaya render() cuma perlu
  // meng-iterasi ember yang benar-benar tumpang tindih dengan area layar yang terlihat, bukan
  // seluruh dataset - ini yang bikin "zoom keluar terlalu jauh" terasa lambat sebelumnya.
  const BUCKET_SIZE = 64;
  const bucketMap = new Map(); // "bx,bz" -> array simpul
  function bucketKey(x, z) { return `${Math.floor(x / BUCKET_SIZE)},${Math.floor(z / BUCKET_SIZE)}`; }
  function addToBucketIndex(n) {
    const bk = bucketKey(n.x, n.z);
    let bucket = bucketMap.get(bk);
    if (!bucket) { bucket = []; bucketMap.set(bk, bucket); }
    bucket.push(n);
  }
  const checkedMap = new Map(); // "x,z" -> {label, passable, reason, tick} (paling baru menang)
  const pathPoints = []; // urutan posisi nyata (float) yang benar-benar dilewati bot (riwayat)
  let plannedPath = []; // rute yang SEDANG dipilih A* untuk dilalui - diganti total tiap tick (bukan riwayat)
  let currentPos = null;
  let optimisticGoal = null; // koordinat base tujuan (garis lurus optimistik ditarik ke sini)
  let optimisticSpawn = null; // titik awal garis optimistik (spawn asli)
  let optimisticWaypoints = []; // rantai waypoint strategis (strategicRoute.js) - garis lurus dibagi segmen

  let ws = null, reconnectTimer = null;
  let camX = 0, camZ = 0, zoom = 8; // px per blok
  let dragging = false, dragStartX = 0, dragStartY = 0, dragStartCamX = 0, dragStartCamZ = 0;
  let hoverCell = null;
  let followBot = true;
  let minY = Infinity, maxY = -Infinity;

  const canvas = document.getElementById('matrixcanvas');
  const ctx = canvas.getContext('2d');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');

  function key(x, z) { return x + ',' + z; }

  function elevationColor(y) {
    if (!Number.isFinite(minY) || minY === maxY) return 'hsl(190, 45%, 55%)';
    const t = (y - minY) / (maxY - minY);
    // satu hue (teal->biru), terang (rendah) ke gelap (tinggi) - sequential, bukan pelangi.
    const lightness = 78 - t * 50;
    return `hsl(196, 55%, ${lightness}%)`;
  }

  // ── Data dari WebSocket (live tick) ────────────────────────
  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);
    ws.onopen = () => { statusDot.classList.add('connected'); statusText.textContent = 'Terhubung'; };
    ws.onclose = () => { statusDot.classList.remove('connected'); statusText.textContent = 'Terputus'; scheduleReconnect(); };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'DECISION_TICK') handleTick(msg.data);
        else if (msg.type === 'SWEEP_PROGRESS') handleSweepProgress(msg.data);
        else if (msg.type === 'AI_ACTION_EVENT' && msg.data.task === 'CHUNK_SWEEP') handleSweepLog(msg.data);
      } catch (e) {}
    };
  }
  function scheduleReconnect() { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 3000); }

  function handleTick(r) {
    currentPos = r.pos;
    pathPoints.push({ x: r.pos.x, y: r.pos.y, z: r.pos.z, tick: r.tick, decision: r.decision });
    if (pathPoints.length > 20000) pathPoints.shift();
    plannedPath = Array.isArray(r.path) ? r.path : [];
    if (r.goal) optimisticGoal = r.goal;
    if (r.spawn) optimisticSpawn = r.spawn;
    if (Array.isArray(r.waypointChain) && r.waypointChain.length) optimisticWaypoints = r.waypointChain;

    if (r.blocksChecked) {
      for (const b of r.blocksChecked) {
        checkedMap.set(key(b.x, b.z), { label: b.label, passable: b.passable, reason: b.reason, y: b.y, tick: r.tick });
      }
    }
    updateStats();
    if (followBot) centerOn(currentPos.x, currentPos.z);
    render();
  }

  // ── Snapshot graf (poll berkala - graf cuma tumbuh saat chunk baru dimuat) ────────
  function pollGraph() {
    fetch('/api/walk/graph').then((r) => r.json()).then((res) => {
      const nodes = res.data?.nodes || [];
      let changed = false;
      for (const n of nodes) {
        const k = key(n.x, n.z);
        if (!nodesMap.has(k)) { changed = true; addToBucketIndex(n); }
        nodesMap.set(k, n);
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      }
      if (changed) { updateStats(); render(); }
    }).catch(() => {});
  }

  function updateStats() {
    const el = document.getElementById('matrix-stats');
    el.innerHTML = `
      <span>Kolom dikenal: <b>${nodesMap.size}</b></span>
      <span>Tick jalur: <b>${pathPoints.length}</b></span>
      <span>Rentang Y: <b>${Number.isFinite(minY) ? minY + '..' + maxY : '-'}</b></span>
    `;
  }

  // ── Kamera / pan-zoom ───────────────────────────────────────
  function centerOn(x, z) {
    camX = x; camZ = z;
  }

  function worldToScreen(x, z) {
    const rect = canvas.getBoundingClientRect();
    return [rect.width / 2 + (x - camX) * zoom, rect.height / 2 + (z - camZ) * zoom];
  }
  function screenToWorld(px, py) {
    const rect = canvas.getBoundingClientRect();
    return [camX + (px - rect.width / 2) / zoom, camZ + (py - rect.height / 2) / zoom];
  }

  function fitAll() {
    if (nodesMap.size === 0 && !optimisticGoal) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const n of nodesMap.values()) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z);
    }
    const extras = [optimisticSpawn, optimisticGoal, ...optimisticWaypoints].filter(Boolean);
    for (const p of extras) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    const rect = canvas.getBoundingClientRect();
    const spanX = Math.max(maxX - minX, 1), spanZ = Math.max(maxZ - minZ, 1);
    zoom = Math.max(1, Math.min((rect.width - 40) / spanX, (rect.height - 40) / spanZ));
    camX = (minX + maxX) / 2;
    camZ = (minZ + maxZ) / 2;
    followBot = false;
    render();
  }

  // ── Render ──────────────────────────────────────────────────
  function render() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0b0d';
    ctx.fillRect(0, 0, rect.width, rect.height);

    // sel grid = kolom dikenal
    const showText = zoom >= 26;
    const plannedSet = new Set(plannedPath.map((p) => key(Math.floor(p.x), Math.floor(p.z))));

    // Cuma iterasi EMBER yang tumpang tindih area layar yang terlihat, bukan seluruh dataset (bisa
    // jutaan simpul untuk sapuan area luas) - lihat catatan bucketMap di atas.
    const worldMinX = camX - (rect.width / 2) / zoom, worldMaxX = camX + (rect.width / 2) / zoom;
    const worldMinZ = camZ - (rect.height / 2) / zoom, worldMaxZ = camZ + (rect.height / 2) / zoom;
    const bMinX = Math.floor(worldMinX / BUCKET_SIZE) - 1, bMaxX = Math.floor(worldMaxX / BUCKET_SIZE) + 1;
    const bMinZ = Math.floor(worldMinZ / BUCKET_SIZE) - 1, bMaxZ = Math.floor(worldMaxZ / BUCKET_SIZE) + 1;

    // Saat zoom sangat kecil (seluruh peta terlihat sekaligus), banyak simpul jatuh di piksel layar
    // yang SAMA - gambar tiap piksel cuma sekali per frame (bukan sekali per simpul) supaya jumlah
    // fillRect terbatas oleh ukuran layar, bukan ukuran dataset.
    const decimate = zoom < 2;
    const drawnPixels = decimate ? new Set() : null;

    for (let bx = bMinX; bx <= bMaxX; bx++) {
      for (let bz = bMinZ; bz <= bMaxZ; bz++) {
        const bucket = bucketMap.get(`${bx},${bz}`);
        if (!bucket) continue;
        for (const n of bucket) {
          const [px, py] = worldToScreen(n.x, n.z);
          if (px < -zoom || py < -zoom || px > rect.width + zoom || py > rect.height + zoom) continue;
          if (decimate) {
            const pixelKey = `${Math.round(px)},${Math.round(py)}`;
            if (drawnPixels.has(pixelKey)) continue;
            drawnPixels.add(pixelKey);
          }
          drawNode(n, px, py);
        }
      }
    }

    function drawNode(n, px, py) {
      const k = key(n.x, n.z);
      ctx.fillStyle = elevationColor(n.y);
      ctx.fillRect(px, py, Math.max(zoom - 0.6, 0.4), Math.max(zoom - 0.6, 0.4));

      // Border KHUSUS untuk blok yang SEDANG dipilih A* untuk dilalui - warna berbeda dari status
      // dicek (yang jadi titik kecil di pojok, bukan border, supaya tidak bentrok visual).
      if (plannedSet.has(k)) {
        ctx.strokeStyle = '#FF7043';
        ctx.lineWidth = Math.max(1.5, Math.min(zoom * 0.14, 3));
        ctx.strokeRect(px + 1, py + 1, Math.max(zoom - 2, 0.4), Math.max(zoom - 2, 0.4));
      }

      const checked = checkedMap.get(k);
      if (checked) {
        const dotR = Math.max(1.5, Math.min(zoom * 0.14, 4));
        ctx.fillStyle = checked.passable ? '#4CAF50' : '#EF5350';
        ctx.beginPath();
        ctx.arc(px + zoom - dotR - 1.5, py + dotR + 1.5, dotR, 0, Math.PI * 2);
        ctx.fill();
      }

      if (showText) {
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.font = `${Math.min(zoom * 0.32, 11)}px 'JetBrains Mono', monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(n.y), px + zoom / 2, py + zoom / 2);
      }
    }

    // Garis OPTIMISTIK: lurus dari spawn ke base lewat rantai waypoint strategis - tidak tahu
    // rintangan apapun, murni referensi "kalau dunia ini kosong total, ini rutenya". Dibandingkan
    // dengan trail kuning (jalur NYATA) di bawahnya, selisihnya persis menunjukkan di mana & seberapa
    // jauh bot terpaksa memutar karena rintangan nyata.
    if (optimisticSpawn && optimisticGoal) {
      const chain = [optimisticSpawn, ...optimisticWaypoints, optimisticGoal];
      ctx.strokeStyle = 'rgba(153,153,176,0.65)';
      ctx.lineWidth = Math.max(1, Math.min(zoom * 0.08, 2));
      ctx.setLineDash([Math.max(4, zoom * 0.3), Math.max(3, zoom * 0.22)]);
      ctx.beginPath();
      for (let i = 0; i < chain.length; i++) {
        const [px, py] = worldToScreen(chain[i].x, chain[i].z);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Tandai base tujuan dengan penanda jelas.
      const [gx, gy] = worldToScreen(optimisticGoal.x, optimisticGoal.z);
      ctx.fillStyle = '#EF5350';
      ctx.beginPath();
      ctx.moveTo(gx, gy - 7);
      ctx.lineTo(gx + 6, gy + 5);
      ctx.lineTo(gx - 6, gy + 5);
      ctx.closePath();
      ctx.fill();
    }

    // jalur yang benar-benar dilewati bot
    if (pathPoints.length > 1) {
      ctx.strokeStyle = '#FFC107';
      ctx.lineWidth = Math.max(1.5, Math.min(zoom * 0.12, 3));
      ctx.beginPath();
      for (let i = 0; i < pathPoints.length; i++) {
        const [px, py] = worldToScreen(pathPoints[i].x, pathPoints[i].z);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // posisi bot sekarang
    if (currentPos) {
      const [px, py] = worldToScreen(currentPos.x, currentPos.z);
      ctx.fillStyle = '#6C63FF';
      ctx.beginPath();
      ctx.arc(px, py, Math.max(4, zoom * 0.3), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    renderLegend();
  }

  function renderLegend() {
    const legend = document.getElementById('matrix-legend');
    const lowColor = elevationColor(minY);
    const highColor = elevationColor(maxY);
    legend.innerHTML = `
      <div class="legend-scale">
        <span>Y=${Number.isFinite(minY) ? minY : '-'}</span>
        <div class="legend-gradient" style="background:linear-gradient(90deg, ${lowColor}, ${highColor})"></div>
        <span>Y=${Number.isFinite(maxY) ? maxY : '-'}</span>
      </div>
      <div class="legend-items">
        <span class="legend-swatch"><span class="sw" style="border-top:2px dashed rgba(153,153,176,0.9); background:transparent; height:0;"></span> garis optimistik (lurus, tanpa rintangan)</span>
        <span class="legend-swatch"><span class="sw" style="background:#FFC107"></span> jalur sudah dilewati bot (nyata)</span>
        <span class="legend-swatch"><span class="sw" style="background:#6C63FF; border-radius:50%;"></span> posisi sekarang</span>
        <span class="legend-swatch"><span class="sw" style="border:2px solid #FF7043; background:transparent;"></span> blok DIPILIH untuk dilalui (rute A* aktif)</span>
        <span class="legend-swatch"><span class="sw" style="background:#4CAF50; border-radius:50%;"></span> dicek: lolos</span>
        <span class="legend-swatch"><span class="sw" style="background:#EF5350; border-radius:50%;"></span> dicek: gagal</span>
      </div>
    `;
  }

  // ── Detail sel (hover) ──────────────────────────────────────
  function findPathCostAt(x, z) {
    // Cari titik jalur (dibulatkan) yang paling dekat dengan sel ini, hitung biaya langkah dari
    // titik sebelumnya di jalur - persis rumus moveCost yang dipakai findPath (pathfinder.js).
    for (let i = 1; i < pathPoints.length; i++) {
      if (Math.floor(pathPoints[i].x) === x && Math.floor(pathPoints[i].z) === z) {
        const prev = pathPoints[i - 1], cur = pathPoints[i];
        const dx = cur.x - prev.x, dy = cur.y - prev.y, dz = cur.z - prev.z;
        return { cost: moveCost(dx, dy, dz), dy, tick: cur.tick, decision: cur.decision };
      }
    }
    return null;
  }

  function showCellDetail(x, z) {
    const node = nodesMap.get(key(x, z));
    const el = document.getElementById('celldetail');
    if (!node) {
      el.innerHTML = `<div class="bc-label">Kolom (${x}, ${z}) belum pernah dibaca.</div>`;
      return;
    }
    const checked = checkedMap.get(key(x, z));
    const pathCost = findPathCostAt(x, z);
    const isPlanned = plannedPath.some((p) => Math.floor(p.x) === x && Math.floor(p.z) === z);
    let html = `
      <div class="cd-row"><span class="k">Koordinat</span><span class="v">(${x}, ${node.y}, ${z})</span></div>
      <div class="cd-row"><span class="k">Ketinggian tanah</span><span class="v">Y=${node.y}</span></div>
      ${isPlanned ? `<div class="cd-row"><span class="k">Rute aktif</span><span class="cd-badge ok" style="background:rgba(255,112,67,0.18); color:#FF7043;">DIPILIH UNTUK DILALUI</span></div>` : ''}
    `;
    if (checked) {
      html += `
        <div class="cd-row"><span class="k">Terakhir dicek</span><span class="v">${checked.label} @ tick ${checked.tick}</span></div>
        <div class="cd-row"><span class="k">Status</span><span class="cd-badge ${checked.passable ? 'ok' : 'bad'}">${checked.passable ? 'LOLOS' : 'GAGAL'}</span></div>
        <div class="cd-reason">${checked.reason || '-'}</div>
      `;
    }
    if (pathCost) {
      html += `
        <div class="cd-row"><span class="k">Biaya A* langkah ini</span><span class="v">${pathCost.cost.toFixed(2)}</span></div>
        <div class="cd-row"><span class="k">Perubahan Y</span><span class="v">${pathCost.dy > 0 ? '+' : ''}${pathCost.dy.toFixed(2)} ${pathCost.dy > 0 ? '(lompat, penalti tetap)' : pathCost.dy < 0 ? '(turun, murah)' : '(datar)'}</span></div>
        <div class="cd-row"><span class="k">Keputusan tick ${pathCost.tick}</span><span class="v">${pathCost.decision}</span></div>
      `;
    }
    if (!checked && !pathCost) {
      html += `<div class="bc-label" style="margin-top:6px">Kolom ini diketahui dari data chunk, tapi belum pernah dicek langsung atau dilewati.</div>`;
    }
    el.innerHTML = html;
  }

  // ── Input: pan, zoom, hover ─────────────────────────────────
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const [wx, wz] = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    zoom = Math.max(0.5, Math.min(60, zoom * factor));
    // zoom terpusat pada posisi kursor
    const [nx, nz] = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    camX += wx - nx;
    camZ += wz - nz;
    followBot = false;
    render();
  }, { passive: false });

  canvas.addEventListener('mousedown', (e) => {
    dragging = true;
    canvas.classList.add('dragging');
    dragStartX = e.clientX; dragStartY = e.clientY;
    dragStartCamX = camX; dragStartCamZ = camZ;
    followBot = false;
  });
  window.addEventListener('mouseup', () => { dragging = false; canvas.classList.remove('dragging'); });
  canvas.addEventListener('mousemove', (e) => {
    if (dragging) {
      camX = dragStartCamX - (e.clientX - dragStartX) / zoom;
      camZ = dragStartCamZ - (e.clientY - dragStartY) / zoom;
      render();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const [wx, wz] = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const cx = Math.floor(wx), cz = Math.floor(wz);
    if (!hoverCell || hoverCell[0] !== cx || hoverCell[1] !== cz) {
      hoverCell = [cx, cz];
      showCellDetail(cx, cz);
    }
  });

  document.getElementById('btn-zoom-in').addEventListener('click', () => { zoom = Math.min(60, zoom * 1.4); followBot = false; render(); });
  document.getElementById('btn-zoom-out').addEventListener('click', () => { zoom = Math.max(0.5, zoom / 1.4); followBot = false; render(); });
  document.getElementById('btn-fit').addEventListener('click', fitAll);
  document.getElementById('btn-follow').addEventListener('click', () => {
    followBot = true;
    if (currentPos) centerOn(currentPos.x, currentPos.z);
    render();
  });

  // ── Sapuan grid area luas (RCON, lihat gridSweepViaRcon.js di backend) ──────────
  const sweepStatusEl = document.getElementById('sweep-status');
  function handleSweepProgress(p) {
    sweepStatusEl.textContent = `Sapuan: ${p.done}/${p.total} titik, ${p.nodeCount} simpul`;
  }
  function handleSweepLog(data) {
    if (data.status === 'COMPLETED' || data.status === 'ERROR') sweepStatusEl.textContent = data.step;
  }
  document.getElementById('btn-sweep-start').addEventListener('click', () => {
    sweepStatusEl.textContent = 'Memulai sapuan...';
    fetch('/api/sweep/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ center: { x: -34.5, z: -7.5 }, sizeBlocks: 1000, spacing: 48 })
    }).then((r) => r.json()).then((res) => {
      sweepStatusEl.textContent = res.success ? 'Sapuan berjalan...' : ('Gagal: ' + res.error.message);
    }).catch((e) => { sweepStatusEl.textContent = 'Gagal: ' + e.message; });
  });
  document.getElementById('btn-sweep-stop').addEventListener('click', () => {
    fetch('/api/sweep/stop', { method: 'POST' })
      .then((r) => r.json())
      .then((res) => { sweepStatusEl.textContent = res.success ? res.data.message : res.error.message; })
      .catch((e) => { sweepStatusEl.textContent = 'Gagal: ' + e.message; });
  });

  window.addEventListener('resize', render);

  connect();
  pollGraph();
  setInterval(pollGraph, 2000);
  render();
})();
