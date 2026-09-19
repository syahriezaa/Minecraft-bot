const COUNTERS = ['progressSequence', 'verifiedBlocks', 'cleared', 'built', 'delivered', 'deposited', 'produced', 'crafted', 'smelted'];

// Status messages and timestamps are liveness, not evidence of completed work.
class WorkProgress {
  constructor() {
    this.counters = new Map();
    this.positions = new Set();
    this.sessions = new Map();
  }

  beginSession(source, session) {
    if (!Number.isInteger(session) || session < 0 || session <= (this.sessions.get(source) ?? -1)) return false;
    this.sessions.set(source, session);
    const prefix = `${source}:`;
    for (const key of this.counters.keys()) if (key.startsWith(prefix)) this.counters.delete(key);
    for (const key of this.positions) if (key.startsWith(prefix)) this.positions.delete(key);
    return true;
  }

  observe(details = {}, source = '') {
    if (!details || typeof details !== 'object') return false;
    if (!this.acceptsSession(source, details.workerSession)) return false;
    let advanced = false;
    for (const field of COUNTERS) {
      const value = details[field];
      if (!Number.isFinite(value) || value < 0) continue;
      const key = `${source}:${field}`;
      const previous = this.counters.get(key) ?? 0;
      if (value > previous) { this.counters.set(key, value); advanced = true; }
    }
    if (Number.isFinite(details.remainingBlocks) && details.remainingBlocks >= 0) {
      const key = `${source}:remainingBlocks`;
      const previous = this.counters.get(key);
      if (previous !== undefined && details.remainingBlocks < previous) advanced = true;
      this.counters.set(key, Math.min(previous ?? Infinity, details.remainingBlocks));
    }
    const p = details.position;
    if (['NAVIGATED', 'BLOCK_DUG', 'BLOCK_PLACED'].includes(details.action) &&
        p && [p.x, p.y, p.z].every(Number.isFinite)) {
      const key = `${source}:${details.action}:${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      if (!this.positions.has(key) && this.positions.size < 10000) {
        this.positions.add(key);
        advanced = true;
      }
    }
    return advanced;
  }

  acceptsSession(source, session) {
    return !this.sessions.has(source) || session === this.sessions.get(source);
  }
}

module.exports = { WorkProgress };
