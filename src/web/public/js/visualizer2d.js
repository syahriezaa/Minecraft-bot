/**
 * @file visualizer2d.js
 * @description Renderer Canvas 2D untuk visualisasi jalur bot secara real-time (top-down view).
 */

(function () {
  'use strict';

  const canvas = document.getElementById('path-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const pathHistory = [];
  const MAX_POINTS = 500;

  let startPos = null;
  let targetPos = null;
  let viewOffsetX = 0;
  let viewOffsetZ = 0;
  let viewScale = 4;

  // Responsif canvas
  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width - 32;
    canvas.height = 360;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  function worldToScreen(wx, wz) {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    return {
      x: cx + (wx - viewOffsetX) * viewScale,
      y: cy + (wz - viewOffsetZ) * viewScale
    };
  }

  function addPoint(x, z) {
    pathHistory.push({ x, z });
    if (pathHistory.length > MAX_POINTS) pathHistory.shift();

    // Auto-center view pada posisi terbaru
    viewOffsetX = x;
    viewOffsetZ = z;
  }

  function setMarkers(start, target) {
    startPos = start;
    targetPos = target;
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Latar grid
    ctx.strokeStyle = 'rgba(42, 42, 54, 0.4)';
    ctx.lineWidth = 1;
    const gridStep = viewScale * 5;
    const ox = (canvas.width / 2) % gridStep;
    const oy = (canvas.height / 2) % gridStep;
    for (let x = ox; x < canvas.width; x += gridStep) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = oy; y < canvas.height; y += gridStep) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }

    // Titik awal (hijau)
    if (startPos) {
      const s = worldToScreen(startPos.x, startPos.z);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(76, 175, 80, 0.7)';
      ctx.fill();
      ctx.strokeStyle = '#4CAF50';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '10px Poppins';
      ctx.fillText('Mulai', s.x + 12, s.y + 4);
    }

    // Titik target (merah)
    if (targetPos) {
      const t = worldToScreen(targetPos.x, targetPos.z);
      ctx.beginPath();
      ctx.arc(t.x, t.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(239, 83, 80, 0.7)';
      ctx.fill();
      ctx.strokeStyle = '#EF5350';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '10px Poppins';
      ctx.fillText('Target', t.x + 12, t.y + 4);
    }

    // Jejak jalur (breadcrumb trail)
    if (pathHistory.length > 1) {
      ctx.beginPath();
      const first = worldToScreen(pathHistory[0].x, pathHistory[0].z);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < pathHistory.length; i++) {
        const p = worldToScreen(pathHistory[i].x, pathHistory[i].z);
        ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = 'rgba(108, 99, 255, 0.6)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Posisi bot saat ini (titik terang)
    if (pathHistory.length > 0) {
      const last = pathHistory[pathHistory.length - 1];
      const p = worldToScreen(last.x, last.z);

      // Lingkaran luar bercahaya
      ctx.beginPath();
      ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(108, 99, 255, 0.2)';
      ctx.fill();

      // Lingkaran dalam
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#6C63FF';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Koordinat teks
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '10px JetBrains Mono';
      ctx.fillText(`(${last.x.toFixed(0)}, ${last.z.toFixed(0)})`, p.x + 10, p.y - 8);
    }

    // Info sudut kiri atas
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '10px Poppins';
    ctx.fillText(`Titik: ${pathHistory.length} | Zoom: ${viewScale.toFixed(1)}x`, 10, 18);

    requestAnimationFrame(draw);
  }

  draw();

  // Zoom dengan scroll
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    viewScale += e.deltaY > 0 ? -0.5 : 0.5;
    viewScale = Math.max(0.5, Math.min(20, viewScale));
  });

  // Click-to-Move: Klik di peta untuk mengarahkan bot berjalan ke koordinat tersebut
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    const worldX = viewOffsetX + (clickX - cx) / viewScale;
    const worldZ = viewOffsetZ + (clickY - cy) / viewScale;

    setMarkers(startPos, { x: worldX, z: worldZ });

    const event = new CustomEvent('canvas_click_target', {
      detail: { x: worldX, z: worldZ }
    });
    window.dispatchEvent(event);
  });

  // Export global
  window.visualizer2d = { addPoint, setMarkers };
})();
