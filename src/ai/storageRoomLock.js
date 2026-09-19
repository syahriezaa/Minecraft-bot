const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const STALE_MS = 180000;
const STARVATION_MS = 30000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function tokenForProcess() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function chestResourceKey(position, adapter = null) {
  if (!position || !Number.isInteger(Number(position.x)) || !Number.isInteger(Number(position.y)) || !Number.isInteger(Number(position.z))) {
    return 'chest:unknown';
  }
  const normalized = {
    x: Number(position.x),
    y: Number(position.y),
    z: Number(position.z)
  };
  const getHalfType = candidate => {
    if (typeof adapter?.getChestHalfType !== 'function') return null;
    try { return adapter.getChestHalfType(candidate); } catch { return null; }
  };
  const ownType = getHalfType(normalized);
  const isHalf = ownType === 'left' || ownType === 'right';
  if (isHalf && typeof adapter?.getChestHalfType === 'function') {
    const neighbors = [
      { x: normalized.x - 1, y: normalized.y, z: normalized.z },
      { x: normalized.x + 1, y: normalized.y, z: normalized.z },
      { x: normalized.x, y: normalized.y, z: normalized.z - 1 },
      { x: normalized.x, y: normalized.y, z: normalized.z + 1 }
    ];
    for (const neighbor of neighbors) {
      const neighborType = getHalfType(neighbor);
      const validPair = (ownType === 'left' && neighborType === 'right') ||
        (ownType === 'right' && neighborType === 'left');
      if (!validPair) continue;
      const ordered = [normalized, neighbor].sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
      return `chest-double:${ordered[0].x},${ordered[0].y},${ordered[0].z}|${ordered[1].x},${ordered[1].y},${ordered[1].z}`;
    }
  }
  return `chest:${normalized.x},${normalized.y},${normalized.z}`;
}

async function processAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function readQueue(queuePath) {
  await fs.mkdir(queuePath, { recursive: true });
  const names = await fs.readdir(queuePath);
  const requests = [];
  for (const name of names) {
    const requestPath = `${queuePath}/${name}`;
    try {
      const request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
      const createdAt = Number(request.createdAt || 0);
      if (!await processAlive(Number(request.pid)) || Date.now() - createdAt > STALE_MS) {
        await fs.rm(requestPath, { force: true });
        continue;
      }
      requests.push({ ...request, path: requestPath });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      await fs.rm(requestPath, { force: true }).catch(() => {});
    }
  }
  const ordered = requests.sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) ||
    Number(a.createdAt) - Number(b.createdAt) || String(a.token).localeCompare(String(b.token)));
  // Priority mempercepat miner, tetapi tidak boleh membuat builder/materials menunggu selamanya
  // ketika miner melakukan retry berulang. Setelah menunggu cukup lama, request tertua mendapat
  // giliran; setelah itu urutan prioritas kembali normal.
  const oldest = requests.reduce((candidate, request) => !candidate || request.createdAt < candidate.createdAt ? request : candidate, null);
  if (oldest && Date.now() - Number(oldest.createdAt) >= STARVATION_MS) {
    return [oldest, ...ordered.filter(request => request.token !== oldest.token)];
  }
  return ordered;
}

async function readActiveLeases(activePath) {
  await fs.mkdir(activePath, { recursive: true });
  const names = await fs.readdir(activePath);
  const leases = [];
  for (const name of names) {
    const leasePath = `${activePath}/${name}`;
    try {
      const lease = JSON.parse(await fs.readFile(`${leasePath}/owner.json`, 'utf8'));
      if (!await processAlive(Number(lease.pid))) {
        await fs.rm(leasePath, { recursive: true, force: true });
        continue;
      }
      leases.push({ ...lease, path: leasePath });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      await fs.rm(leasePath, { recursive: true, force: true }).catch(() => {});
    }
  }
  return leases;
}

async function acquireAdmission(admissionPath) {
  for (;;) {
    try {
      await fs.mkdir(admissionPath);
      await fs.writeFile(`${admissionPath}/owner.json`, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
      return async () => fs.rm(admissionPath, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(await fs.readFile(`${admissionPath}/owner.json`, 'utf8'));
        if (!await processAlive(Number(owner.pid))) await fs.rm(admissionPath, { recursive: true, force: true });
      } catch (ownerError) {
        if (ownerError.code === 'ENOENT') continue;
      }
      await sleep(25);
    }
  }
}

async function withResourceLock(action, {
  lockPath,
  log = () => {},
  waitMessage,
  actionTimeoutMs,
  resourceKey,
  // Maksimal dua client boleh membuka chest fisik yang sama. Ini mempercepat
  // inspeksi/withdraw ringan tanpa membiarkan puluhan bot menimpa state window;
  // operasi sensitif dapat tetap memaksa resourceCapacity=1 dari caller.
  resourceCapacity = Number(process.env.STORAGE_ROOM_CHEST_CONCURRENCY) || 2,
  // Construction swarm memakai 4 miner + materials + builder paralel. Batasi
  // hanya satu operasi per chest fisik, bukan seluruh logistik.
  totalCapacity = Number(process.env.STORAGE_ROOM_LOGISTICS_MAX_CONCURRENCY) || 8,
  priority
}) {
  const queuePath = `${lockPath}.queue`;
  const activePath = `${lockPath}.active`;
  const admissionPath = `${lockPath}.admission`;
  const token = tokenForProcess();
  const requestPath = `${queuePath}/${token}.json`;
  const request = {
    pid: process.pid,
    token,
    resourceKey: String(resourceKey || 'chest:unknown'),
    resourceCapacity: Math.max(1, Math.floor(Number(resourceCapacity) || 1)),
    totalCapacity: Math.max(1, Math.floor(Number(totalCapacity) || 4)),
    priority,
    createdAt: Date.now()
  };
  await fs.mkdir(queuePath, { recursive: true });
  await fs.writeFile(requestPath, JSON.stringify(request), { flag: 'wx' });
  let lastLogAt = 0;
  const timeout = Number(actionTimeoutMs) || 60000;
  try {
    for (;;) {
      const queue = await readQueue(queuePath);
      const admissionRelease = await acquireAdmission(admissionPath);
      let leasePath = null;
      try {
        const active = await readActiveLeases(activePath);
        const eligible = queue.find(candidate => {
          const sameResource = active.filter(lease => lease.resourceKey === candidate.resourceKey).length;
          return active.length < candidate.totalCapacity && sameResource < candidate.resourceCapacity;
        });
        if (eligible?.token === token) {
          const leaseId = crypto.createHash('sha1').update(token).digest('hex');
          leasePath = `${activePath}/${leaseId}`;
          await fs.mkdir(leasePath);
          await fs.writeFile(`${leasePath}/owner.json`, JSON.stringify({
            pid: process.pid,
            token,
            resourceKey: request.resourceKey,
            acquiredAt: new Date().toISOString()
          }));
          await fs.rm(requestPath, { force: true });
        }
      } finally {
        await admissionRelease();
      }
      if (!leasePath) {
        if (Date.now() - lastLogAt > 5000) {
          log(waitMessage || `Menunggu kapasitas chest ${request.resourceKey}...`);
          lastLogAt = Date.now();
        }
        await sleep(250);
        continue;
      }
      const heartbeat = setInterval(() => fs.utimes(leasePath, new Date(), new Date()).catch(() => {}), 15000);
      const timeoutHandle = timeout > 0 ? setTimeout(() => {
        log(`LOCK_TIMEOUT setelah ${timeout}ms; lease ${request.resourceKey} dilepas agar swarm tidak membeku.`);
        fs.rm(leasePath, { recursive: true, force: true }).catch(() => {}).finally(() => process.exit(2));
      }, timeout) : null;
      try {
        return await action();
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        clearInterval(heartbeat);
        await fs.rm(leasePath, { recursive: true, force: true });
      }
    }
  } finally {
    await fs.rm(requestPath, { force: true });
    // Queue root sengaja dibiarkan hidup. Menghapusnya di sini memiliki race:
    // worker lain dapat sudah melewati mkdir() tetapi belum sempat writeFile()
    // request, lalu mendapat ENOENT ketika worker ini selesai lebih dulu.
  }
}

async function withStorageLock(action, { lockPath, log = () => {}, waitMessage = 'Menunggu lock logistik...', actionTimeoutMs = Number(process.env.STORAGE_ROOM_LOCK_ACTION_TIMEOUT_MS) || 60000, resourceKey = null, resourceCapacity, totalCapacity } = {}) {
  if (!lockPath) return action();
  if (resourceKey) {
    return withResourceLock(action, { lockPath, log, waitMessage, actionTimeoutMs, resourceKey, resourceCapacity, totalCapacity });
  }
  const queuePath = `${lockPath}.queue`;
  const token = tokenForProcess();
  const requestPath = `${queuePath}/${token}.json`;
  const script = String(process.argv[1] || '');
  const inferredPriority = script.includes('runStorageRoomQuarry') ? 100
    : script.includes('runStorageRoomMaterials') ? 80
      : script.includes('runStorageRoomBuilder') ? 10 : 0;
  const request = { pid: process.pid, token,
    priority: Number.isFinite(Number(process.env.STORAGE_ROOM_LOCK_PRIORITY))
      ? Number(process.env.STORAGE_ROOM_LOCK_PRIORITY) : inferredPriority,
    createdAt: Date.now() };
  await fs.mkdir(queuePath, { recursive: true });
  await fs.writeFile(requestPath, JSON.stringify(request), { flag: 'wx' });
  let lastLogAt = 0;
  try {
    for (;;) {
      const queue = await readQueue(queuePath);
      if (queue[0]?.token !== token) {
        if (Date.now() - lastLogAt > 5000) {
          log(waitMessage);
          lastLogAt = Date.now();
        }
        await sleep(250);
        continue;
      }
      try {
        await fs.mkdir(lockPath);
        await fs.writeFile(`${lockPath}/owner.json`, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
        await fs.rm(requestPath, { force: true });
        const heartbeat = setInterval(() => {
          fs.utimes(lockPath, new Date(), new Date()).catch(() => {});
        }, 15000);
        const timeoutHandle = actionTimeoutMs > 0 ? setTimeout(() => {
          log(`LOCK_TIMEOUT setelah ${actionTimeoutMs}ms; worker dihentikan agar lock tidak membekukan swarm.`);
          fs.rm(lockPath, { recursive: true, force: true })
            .catch(() => {})
            .finally(() => process.exit(2));
        }, actionTimeoutMs) : null;
        try {
          return await action();
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          clearInterval(heartbeat);
          await fs.rm(lockPath, { recursive: true, force: true });
        }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let ownerAlive = true;
        try {
          const owner = JSON.parse(await fs.readFile(`${lockPath}/owner.json`, 'utf8'));
          ownerAlive = await processAlive(Number(owner.pid));
        } catch (ownerError) {
          if (ownerError.code === 'ENOENT') ownerAlive = false;
        }
        if (!ownerAlive) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
        await sleep(250);
      }
    }
  } finally {
    await fs.rm(requestPath, { force: true });
    const remaining = await fs.readdir(queuePath).catch(() => []);
    if (remaining.length === 0) await fs.rm(queuePath, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { withStorageLock, chestResourceKey };
