(function () {
  'use strict';

  const canvas = document.getElementById('world-map-canvas');
  const stage = document.getElementById('world-map-stage');
  if (!canvas || !stage) return;
  const context = canvas.getContext('2d', { alpha: false });
  const loading = document.getElementById('world-map-loading');
  const meta = document.getElementById('world-map-meta');
  const badge = document.getElementById('world-map-known-badge');
  const cursor = document.getElementById('world-map-cursor');
  const tooltip = document.getElementById('world-map-tooltip');
  const modeInput = document.getElementById('world-map-mode');
  const yInput = document.getElementById('world-map-y');
  const yValue = document.getElementById('world-map-y-value');
  const selectionButton = document.getElementById('world-map-select-mining');
  const BASE = { x: -185, z: -352 };
  const state = {
    centerX: BASE.x,
    centerZ: BASE.z,
    radius: 96,
    zoom: 1,
    pan: { x: 0, y: 0 },
    data: null,
    blockIndex: new Map(),
    selectionMode: false,
    selectedPoints: [],
    pointer: null,
    requestId: 0
  };

  const layerIds = ['landmarks', 'structures', 'bots', 'reservations', 'mining'];
  const layerEnabled = name => document.getElementById(`world-map-layer-${name}`)?.checked !== false;

  function terrainColor(block) {
    if (!block || block.air) return '#0b0e13';
    const name = String(block.name || '');
    if (/water|bubble_column/.test(name)) return '#326b91';
    if (/lava/.test(name)) return '#d55b2a';
    if (/grass|moss|leaves|vine|farmland|wheat|carrot|potato|beetroot|sugar_cane|bamboo/.test(name)) return '#4f7f49';
    if (/sand|sandstone/.test(name)) return '#b5a56b';
    if (/snow|ice/.test(name)) return '#c8d9de';
    if (/dirt|mud|clay|gravel/.test(name)) return '#755d46';
    if (/stone|deepslate|tuff|andesite|diorite|granite|ore|cobble/.test(name)) return '#6d747d';
    if (/planks|bricks|glass|log|door|stairs|slab|fence|chest|barrel|furnace|crafting|bed/.test(name)) return '#b08a5a';
    return '#59636b';
  }

  function resizeCanvas() {
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function dimensions() {
    return { width: canvas.clientWidth, height: canvas.clientHeight };
  }

  function scale() {
    const { width, height } = dimensions();
    return Math.max(0.5, Math.min(width, height) / ((state.radius * 2 + 1))) * state.zoom;
  }

  function worldToScreen(x, z) {
    const { width, height } = dimensions();
    const pixels = scale();
    return { x: width / 2 + (x - state.centerX) * pixels + state.pan.x, y: height / 2 + (z - state.centerZ) * pixels + state.pan.y };
  }

  function screenToWorld(x, y) {
    const { width, height } = dimensions();
    const pixels = scale();
    return { x: state.centerX + (x - width / 2 - state.pan.x) / pixels, z: state.centerZ + (y - height / 2 - state.pan.y) / pixels };
  }

  function drawGrid(width, height) {
    context.fillStyle = '#090b10';
    context.fillRect(0, 0, width, height);
    const pixels = scale();
    const step = pixels >= 7 ? 8 : pixels >= 3 ? 16 : 32;
    const topLeft = screenToWorld(0, 0);
    const bottomRight = screenToWorld(width, height);
    context.strokeStyle = 'rgba(104,115,132,0.14)';
    context.lineWidth = 1;
    context.beginPath();
    for (let x = Math.floor(topLeft.x / step) * step; x <= bottomRight.x; x += step) {
      const point = worldToScreen(x, 0);
      context.moveTo(Math.round(point.x) + 0.5, 0);
      context.lineTo(Math.round(point.x) + 0.5, height);
    }
    for (let z = Math.floor(topLeft.z / step) * step; z <= bottomRight.z; z += step) {
      const point = worldToScreen(0, z);
      context.moveTo(0, Math.round(point.y) + 0.5);
      context.lineTo(width, Math.round(point.y) + 0.5);
    }
    context.stroke();
  }

  function drawTerrain() {
    if (!state.data) return;
    const pixels = scale();
    const cellSize = Math.max(1, Math.ceil(pixels + 0.35));
    const minY = state.data.availableWorlds?.[0]?.minY ?? -64;
    const maxY = state.data.availableWorlds?.[0]?.maxY ?? 100;
    for (const block of state.data.blocks || []) {
      const point = worldToScreen(block.x, block.z);
      context.fillStyle = terrainColor(block);
      context.globalAlpha = block.conflict ? 0.5 : 1;
      context.fillRect(Math.floor(point.x - pixels / 2), Math.floor(point.y - pixels / 2), cellSize, cellSize);
      if (state.data.mode === 'surface' && pixels >= 3 && !block.air) {
        const shade = Math.max(0, Math.min(0.22, ((block.y - minY) / Math.max(1, maxY - minY)) * 0.22));
        context.fillStyle = `rgba(255,255,255,${shade})`;
        context.fillRect(Math.floor(point.x - pixels / 2), Math.floor(point.y - pixels / 2), cellSize, Math.max(1, pixels * 0.15));
      }
    }
    context.globalAlpha = 1;
  }

  function drawRect(bounds, color, dashed = false) {
    const a = worldToScreen(bounds.minX - 0.5, bounds.minZ - 0.5);
    const b = worldToScreen(bounds.maxX + 0.5, bounds.maxZ + 0.5);
    context.save();
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.setLineDash(dashed ? [6, 4] : []);
    context.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    context.restore();
  }

  function drawOverlays() {
    if (!state.data) return;
    if (layerEnabled('mining')) for (const region of state.data.miningRegions || []) drawRect(region, '#4fb6c4', true);
    if (layerEnabled('structures')) for (const structure of state.data.structures || []) drawRect(structure, structure.kind === 'cultivation' ? '#70b66b' : '#d9a441');
    if (layerEnabled('reservations')) {
      for (const reservation of state.data.reservations || []) {
        if (!reservation.position) continue;
        const point = worldToScreen(reservation.position.x, reservation.position.z);
        const size = Math.max(4, scale());
        context.fillStyle = 'rgba(225,97,90,0.6)';
        context.fillRect(point.x - size / 2, point.y - size / 2, size, size);
      }
    }
    if (layerEnabled('landmarks')) {
      for (const landmark of state.data.landmarks || []) {
        const points = landmark.shape === 'area' ? landmark.boundary : [landmark.position];
        if (!Array.isArray(points) || !points.length) continue;
        context.save();
        context.strokeStyle = landmark.category === 'river' || landmark.category === 'water_area' ? '#58a6c8' : '#d9a441';
        context.fillStyle = landmark.category === 'river' || landmark.category === 'water_area' ? 'rgba(79,182,196,0.12)' : 'rgba(217,164,65,0.14)';
        context.lineWidth = 1.5;
        context.beginPath();
        points.forEach((point, index) => {
          const screen = worldToScreen(point.x, point.z);
          if (index === 0) context.moveTo(screen.x, screen.y); else context.lineTo(screen.x, screen.y);
        });
        if (landmark.shape === 'area') context.closePath();
        context.fill();
        context.stroke();
        context.restore();
      }
    }
    if (layerEnabled('bots')) {
      for (const bot of state.data.bots || []) {
        const point = worldToScreen(bot.x, bot.z);
        context.beginPath();
        context.fillStyle = '#4caf7d';
        context.arc(point.x, point.y, 6, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = '#d8f4e5';
        context.lineWidth = 1.5;
        context.stroke();
        context.fillStyle = '#e4e7ed';
        context.font = '11px IBM Plex Mono, monospace';
        context.fillText(bot.name || bot.id || 'bot', point.x + 9, point.y + 4);
      }
    }
  }

  function drawSelection() {
    if (!state.selectedPoints.length) return;
    context.save();
    context.strokeStyle = '#f0bf5c';
    context.fillStyle = 'rgba(217,164,65,0.16)';
    context.lineWidth = 2;
    context.setLineDash([5, 4]);
    context.beginPath();
    state.selectedPoints.forEach((point, index) => {
      const screen = worldToScreen(point.x, point.z);
      if (index === 0) context.moveTo(screen.x, screen.y); else context.lineTo(screen.x, screen.y);
    });
    if (state.selectedPoints.length === 4) context.closePath();
    context.fill();
    context.stroke();
    context.setLineDash([]);
    for (const [index, point] of state.selectedPoints.entries()) {
      const screen = worldToScreen(point.x, point.z);
      context.beginPath();
      context.fillStyle = '#f0bf5c';
      context.arc(screen.x, screen.y, 5, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#080a0d';
      context.font = 'bold 9px IBM Plex Mono, monospace';
      context.fillText(String(index + 1), screen.x - 3, screen.y + 3);
    }
    context.restore();
  }

  function draw() {
    const { width, height } = dimensions();
    if (!width || !height) return;
    context.clearRect(0, 0, width, height);
    drawGrid(width, height);
    drawTerrain();
    drawOverlays();
    drawSelection();
    const base = worldToScreen(BASE.x, BASE.z);
    context.fillStyle = '#e1615a';
    context.beginPath();
    context.moveTo(base.x, base.y - 7);
    context.lineTo(base.x + 6, base.y + 5);
    context.lineTo(base.x - 6, base.y + 5);
    context.closePath();
    context.fill();
  }

  async function loadMap() {
    const requestId = ++state.requestId;
    loading.hidden = false;
    const query = new URLSearchParams({ centerX: Math.round(state.centerX), centerZ: Math.round(state.centerZ), radius: state.radius, mode: modeInput.value, y: yInput.value });
    try {
      const response = await fetch(`/api/world-map?${query}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || 'Peta gagal dimuat.');
      if (requestId !== state.requestId) return;
      state.data = result.data;
      state.blockIndex = new Map((state.data.blocks || []).map(block => [`${block.x},${block.z}`, block]));
      badge.textContent = `${state.data.stats?.columns || 0} KOLOM`;
      meta.textContent = `${state.data.dimension || 'unknown'} · X ${state.data.bounds.minX}..${state.data.bounds.maxX} · Z ${state.data.bounds.minZ}..${state.data.bounds.maxZ} · ${state.data.structures.length} struktur`;
      draw();
    } catch (error) {
      meta.textContent = error.message;
    } finally {
      if (requestId === state.requestId) loading.hidden = true;
    }
  }

  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function setMiningCorners(points) {
    const xs = points.map(point => Math.round(point.x));
    const zs = points.map(point => Math.round(point.z));
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    if (minX === maxX || minZ === maxZ) return false;
    const corners = [{ x: minX, z: minZ }, { x: maxX, z: minZ }, { x: maxX, z: maxZ }, { x: minX, z: maxZ }];
    corners.forEach((point, index) => {
      const xInput = document.getElementById(`mining-corner-${index + 1}-x`);
      const zInput = document.getElementById(`mining-corner-${index + 1}-z`);
      if (xInput) xInput.value = point.x;
      if (zInput) zInput.value = point.z;
    });
    state.selectedPoints = corners;
    return true;
  }

  canvas.addEventListener('pointerdown', event => {
    canvas.setPointerCapture(event.pointerId);
    const point = pointerPosition(event);
    state.pointer = { id: event.pointerId, start: point, last: point, moved: false };
  });
  canvas.addEventListener('pointermove', event => {
    const point = pointerPosition(event);
    const world = screenToWorld(point.x, point.y);
    const block = state.blockIndex.get(`${Math.round(world.x)},${Math.round(world.z)}`);
    cursor.textContent = `X ${Math.round(world.x)} · Z ${Math.round(world.z)}${block ? ` · Y ${block.y} · ${block.name}` : ''}`;
    if (block) {
      tooltip.hidden = false;
      tooltip.textContent = `${block.name} · X ${block.x} Y ${block.y} Z ${block.z}`;
      tooltip.style.left = `${Math.min(canvas.clientWidth - 210, point.x + 14)}px`;
      tooltip.style.top = `${Math.max(8, point.y - 34)}px`;
    } else tooltip.hidden = true;
    if (!state.pointer || state.pointer.id !== event.pointerId || state.selectionMode) return;
    const dx = point.x - state.pointer.last.x;
    const dy = point.y - state.pointer.last.y;
    if (Math.hypot(point.x - state.pointer.start.x, point.y - state.pointer.start.y) > 4) state.pointer.moved = true;
    state.pan.x += dx;
    state.pan.y += dy;
    state.pointer.last = point;
    draw();
  });
  canvas.addEventListener('pointerup', event => {
    if (!state.pointer || state.pointer.id !== event.pointerId) return;
    const point = pointerPosition(event);
    if (state.selectionMode && !state.pointer.moved) {
      const world = screenToWorld(point.x, point.y);
      state.selectedPoints.push({ x: Math.round(world.x), z: Math.round(world.z) });
      if (state.selectedPoints.length === 4) {
        if (setMiningCorners(state.selectedPoints)) {
          state.selectionMode = false;
          selectionButton.classList.remove('active');
          selectionButton.textContent = '4 Sudut Tersimpan';
        } else {
          state.selectedPoints = [];
          meta.textContent = 'Pilihan sudut harus memiliki lebar dan panjang.';
        }
      } else selectionButton.textContent = `Pilih Sudut ${state.selectedPoints.length + 1}`;
      draw();
    } else if (!state.selectionMode && state.pointer.moved) {
      const pixels = scale();
      state.centerX -= state.pan.x / pixels;
      state.centerZ -= state.pan.y / pixels;
      state.pan = { x: 0, y: 0 };
      loadMap();
    }
    state.pointer = null;
  });
  canvas.addEventListener('pointercancel', () => { state.pointer = null; state.pan = { x: 0, y: 0 }; draw(); });
  canvas.addEventListener('pointerleave', () => { tooltip.hidden = true; });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    state.zoom = Math.max(0.6, Math.min(8, state.zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2)));
    draw();
  }, { passive: false });

  modeInput.addEventListener('change', () => { yInput.disabled = modeInput.value !== 'slice'; loadMap(); });
  yInput.addEventListener('input', () => { yValue.value = yInput.value; });
  yInput.addEventListener('change', loadMap);
  document.getElementById('world-map-zoom-in').addEventListener('click', () => { state.zoom = Math.min(8, state.zoom * 1.35); draw(); });
  document.getElementById('world-map-zoom-out').addEventListener('click', () => { state.zoom = Math.max(0.6, state.zoom / 1.35); draw(); });
  document.getElementById('world-map-center-base').addEventListener('click', () => { state.centerX = BASE.x; state.centerZ = BASE.z; state.zoom = 1; state.pan = { x: 0, y: 0 }; loadMap(); });
  document.getElementById('world-map-refresh').addEventListener('click', loadMap);
  selectionButton.addEventListener('click', () => {
    state.selectionMode = !state.selectionMode;
    state.selectedPoints = [];
    selectionButton.classList.toggle('active', state.selectionMode);
    selectionButton.textContent = state.selectionMode ? 'Pilih Sudut 1' : 'Pilih 4 Sudut Tambang';
    draw();
  });
  document.getElementById('world-map-clear-selection').addEventListener('click', () => {
    state.selectionMode = false;
    state.selectedPoints = [];
    selectionButton.classList.remove('active');
    selectionButton.textContent = 'Pilih 4 Sudut Tambang';
    draw();
  });
  for (const id of layerIds) document.getElementById(`world-map-layer-${id}`)?.addEventListener('change', draw);
  document.querySelector('[data-tab-target="world-map"]')?.addEventListener('click', () => setTimeout(resizeCanvas, 0));
  new ResizeObserver(resizeCanvas).observe(stage);
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.selectionMode) document.getElementById('world-map-clear-selection').click();
  });
  loadMap();
})();
