const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const MUTATING_TASK_TYPES = new Set([
  'MINE_CELL', 'ENSURE_ACCESS', 'BUILD', 'BUILD_STORAGE', 'LANDSCAPE', 'LANDSCAPE_SITE',
  'REPAIR_FARM', 'HARVEST', 'PLANT', 'SORT_ITEMS', 'SMELT', 'CRAFT',
  'MINING_SUPPLY', 'PREPARE_MATERIALS', 'FEED_ANIMALS', 'BALANCE_HERD'
]);

function requiresTaskVerification(task) {
  return task?.payload?.mutatesWorld === true || task?.payload?.requiresVerification === true ||
    MUTATING_TASK_TYPES.has(task?.type);
}

function validProofCheck(check) {
  if (typeof check?.name !== 'string' || !check.name || check.passed !== true ||
      check.expected == null || check.actual == null) return false;
  if ([check.expected, check.actual].some(value => typeof value === 'number' && !Number.isFinite(value))) return false;
  switch (check.operator || 'eq') {
    case 'eq': return isDeepStrictEqual(check.actual, check.expected);
    case 'ne': return !isDeepStrictEqual(check.actual, check.expected);
    case 'gt': return Number.isFinite(check.actual) && Number.isFinite(check.expected) && check.actual > check.expected;
    case 'gte': return Number.isFinite(check.actual) && Number.isFinite(check.expected) && check.actual >= check.expected;
    default: return false;
  }
}

function isValidTaskVerification(verification, now = Date.now(), maxAgeMs = 5 * 60 * 1000) {
  return verification?.status === 'VERIFIED' && Number.isFinite(verification.observedAt) &&
    verification.observedAt <= now && now - verification.observedAt <= maxAgeMs &&
    Array.isArray(verification.checks) && verification.checks.length > 0 &&
    verification.checks.every(validProofCheck);
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeCapabilities(capabilities) {
  return [...new Set((Array.isArray(capabilities) ? capabilities : []).filter(value => typeof value === 'string' && value))].sort();
}

function taskFromRow(row) {
  if (!row) return null;
  return {
    ...row,
    payload: parseJson(row.payload, {}),
    dependencies: parseJson(row.dependencies, []),
    result: parseJson(row.result, null)
  };
}

function taskAnchor(payload = {}) {
  const direct = payload.target || payload.position || payload.origin;
  if (direct && [direct.x, direct.y, direct.z].every(Number.isFinite)) return direct;
  const bounds = payload.bounds;
  if (bounds?.min && bounds?.max) return {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2
  };
  if (bounds && [bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].every(Number.isFinite)) return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: Number.isFinite(bounds.floorY) && Number.isFinite(bounds.maxY) ? (bounds.floorY + bounds.maxY) / 2 : 0,
    z: (bounds.minZ + bounds.maxZ) / 2
  };
  return null;
}

function assignmentAllowed(task, agentId) {
  const allowed = task.payload?.allowedAgents;
  const excluded = task.payload?.excludedAgents;
  if (Array.isArray(allowed) && allowed.length && !allowed.includes(agentId)) return false;
  return !Array.isArray(excluded) || !excluded.includes(agentId);
}

class SwarmTaskBoard {
  constructor(memory, options = {}) {
    if (!memory?.db) throw new TypeError('SwarmTaskBoard membutuhkan SharedWorldMemory.');
    this.db = memory.db;
    this.now = options.now || Date.now;
    this.defaultLeaseTtlMs = Number(options.defaultLeaseTtlMs) || 30000;
    this.agentTtlMs = Number(options.agentTtlMs) || 45000;
    this.maxFailures = Math.max(1, Number(options.maxFailures) || 5);
    this.maxDeferrals = Math.max(1, Number(options.maxDeferrals) || 20);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS swarm_agents (
        world TEXT NOT NULL, dimension TEXT NOT NULL, id TEXT NOT NULL,
        capabilities TEXT NOT NULL, status TEXT NOT NULL, position TEXT,
        snapshot TEXT NOT NULL, metadata TEXT NOT NULL, lastSeen INTEGER NOT NULL,
        PRIMARY KEY(world, dimension, id)
      );
      CREATE TABLE IF NOT EXISTS swarm_goals (
        id TEXT PRIMARY KEY, world TEXT NOT NULL, dimension TEXT NOT NULL,
        type TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL,
        payload TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS swarm_tasks (
        id TEXT PRIMARY KEY, goalId TEXT NOT NULL, world TEXT NOT NULL, dimension TEXT NOT NULL,
        type TEXT NOT NULL, capability TEXT NOT NULL, status TEXT NOT NULL,
        priority INTEGER NOT NULL, payload TEXT NOT NULL, dependencies TEXT NOT NULL,
        leaseOwner TEXT, leaseToken TEXT, leaseExpiresAt INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
        result TEXT, lastError TEXT,
        nextAttemptAt INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS swarm_task_claim
        ON swarm_tasks(world, dimension, status, priority, createdAt);
      CREATE INDEX IF NOT EXISTS swarm_task_goal ON swarm_tasks(goalId, status);
      CREATE TABLE IF NOT EXISTS swarm_task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT, goalId TEXT,
        agentId TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, createdAt INTEGER NOT NULL
      );
    `);
    try { this.db.exec('ALTER TABLE swarm_tasks ADD COLUMN nextAttemptAt INTEGER NOT NULL DEFAULT 0'); }
    catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }
    try { this.db.exec('ALTER TABLE swarm_tasks ADD COLUMN failures INTEGER NOT NULL DEFAULT 0'); }
    catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }
    try { this.db.exec('ALTER TABLE swarm_tasks ADD COLUMN deferrals INTEGER NOT NULL DEFAULT 0'); }
    catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }
  }

  registerAgent({ id, world, dimension, capabilities = [], metadata = {} }) {
    if (!id || !world || !dimension) throw new Error('Identitas agent dan konteks dunia wajib diisi.');
    const now = this.now();
    this.db.prepare(`INSERT INTO swarm_agents
      (world, dimension, id, capabilities, status, position, snapshot, metadata, lastSeen)
      VALUES (?, ?, ?, ?, 'STARTING', NULL, '{}', ?, ?)
      ON CONFLICT(world, dimension, id) DO UPDATE SET
        capabilities=excluded.capabilities, status='STARTING', position=NULL, snapshot='{}',
        metadata=excluded.metadata, lastSeen=excluded.lastSeen`)
      .run(world, dimension, id, JSON.stringify(normalizeCapabilities(capabilities)), JSON.stringify(metadata || {}), now);
    return this.getAgent(id, { world, dimension });
  }

  heartbeatAgent(id, { world, dimension, status = 'IDLE', position = null, snapshot = {} }) {
    if (!id || !world || !dimension) return false;
    try {
      const result = this.db.prepare(`UPDATE swarm_agents SET status=?, position=?, snapshot=?, lastSeen=?
        WHERE world=? AND dimension=? AND id=?`)
        .run(status, position ? JSON.stringify(position) : null, JSON.stringify(snapshot || {}), this.now(), world, dimension, id);
      return Number(result.changes) === 1;
    } catch (error) {
      if (error?.code === 'ERR_SQLITE_ERROR' && /database is locked/i.test(error.message)) return false;
      throw error;
    }
  }

  getAgent(id, { world, dimension }) {
    const row = this.db.prepare('SELECT * FROM swarm_agents WHERE world=? AND dimension=? AND id=?').get(world, dimension, id);
    return row ? this._agentFromRow(row) : null;
  }

  listAgents({ world, dimension }) {
    return this.db.prepare('SELECT * FROM swarm_agents WHERE world=? AND dimension=? ORDER BY id').all(world, dimension)
      .map(row => this._agentFromRow(row));
  }

  _agentFromRow(row) {
    const stale = row.status !== 'STOPPED' && this.now() - Number(row.lastSeen) > this.agentTtlMs;
    return { ...row, status: stale ? 'OFFLINE' : row.status,
      capabilities: parseJson(row.capabilities, []), position: stale ? null : parseJson(row.position, null),
      snapshot: stale ? {} : parseJson(row.snapshot, {}), metadata: parseJson(row.metadata, {}) };
  }

  createGoal({ id = randomUUID(), world, dimension, type, payload = {}, priority = 0 }) {
    if (!world || !dimension || !type) throw new Error('Goal membutuhkan world, dimension, dan type.');
    const now = this.now();
    this.db.prepare(`INSERT INTO swarm_goals VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`)
      .run(id, world, dimension, type, Math.trunc(Number(priority) || 0), JSON.stringify(payload || {}), now, now);
    this.recordEvent({ goalId: id, kind: 'GOAL_CREATED', data: { type } });
    return { id, world, dimension, type, status: 'ACTIVE', priority, payload };
  }

  addTask({ id = randomUUID(), goalId, world, dimension, type, capability = '*', payload = {}, priority = 0, dependencies = [] }) {
    if (!goalId || !world || !dimension || !type) throw new Error('Task membutuhkan goal, konteks dunia, dan type.');
    const now = this.now();
    const uniqueDependencies = [...new Set(dependencies || [])];
    this.db.prepare(`INSERT INTO swarm_tasks
      (id, goalId, world, dimension, type, capability, status, priority, payload, dependencies,
       leaseOwner, leaseToken, leaseExpiresAt, attempts, result, lastError, nextAttemptAt, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, NULL, NULL, NULL, 0, NULL, NULL, 0, ?, ?)`)
      .run(id, goalId, world, dimension, type, capability, Math.trunc(Number(priority) || 0),
        JSON.stringify(payload || {}), JSON.stringify(uniqueDependencies), now, now);
    this.recordEvent({ taskId: id, goalId, kind: 'TASK_CREATED', data: { type, capability } });
    return taskFromRow(this.db.prepare('SELECT * FROM swarm_tasks WHERE id=?').get(id));
  }

  _releaseExpired(now) {
    const expired = this.db.prepare(`SELECT id,goalId,leaseOwner AS agentId,attempts,failures FROM swarm_tasks
      WHERE status='CLAIMED' AND leaseExpiresAt<=?`).all(now);
    const release = this.db.prepare(`UPDATE swarm_tasks SET status=?,leaseOwner=NULL,leaseToken=NULL,
      leaseExpiresAt=NULL,failures=?,lastError=?,updatedAt=? WHERE id=? AND status='CLAIMED'`);
    for (const task of expired) {
      const failures = Number(task.failures || 0) + 1;
      const exhausted = failures >= this.maxFailures;
      const reason = exhausted ? 'LEASE_EXPIRED_RETRY_LIMIT' : 'LEASE_EXPIRED';
      const updated = release.run(exhausted ? 'FAILED' : 'PENDING', failures, reason, now, task.id);
      if (Number(updated.changes) !== 1) continue;
      this.recordEvent({ taskId: task.id, goalId: task.goalId, agentId: task.agentId,
        kind: exhausted ? 'TASK_FAILED' : 'TASK_RETRY', data: { reason, attempts: task.attempts, failures, maxFailures: this.maxFailures } });
      if (exhausted) this._refreshGoal(task.goalId);
    }
  }

  _dependenciesComplete(task) {
    if (!task.dependencies.length) return true;
    const placeholders = task.dependencies.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT id,status FROM swarm_tasks WHERE id IN (${placeholders})`).all(...task.dependencies);
    return rows.length === task.dependencies.length && rows.every(row => row.status === 'COMPLETED');
  }

  claimTask({ agentId, world, dimension, capabilities = [], taskTypes = null, position = null, ttlMs = this.defaultLeaseTtlMs }) {
    if (!agentId || !world || !dimension) throw new Error('Claim task membutuhkan agent dan konteks dunia.');
    const allowed = new Set([...normalizeCapabilities(capabilities), '*']);
    const supportedTypes = Array.isArray(taskTypes) ? new Set(taskTypes) : null;
    const ttl = Math.max(1000, Math.min(60000, Number(ttlMs) || this.defaultLeaseTtlMs));
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this._releaseExpired(now);
      const capabilityValues = normalizeCapabilities(capabilities);
      if (!capabilityValues.includes('*')) capabilityValues.push('*');
      const clauses = ['t.world=?', 't.dimension=?', "t.status='PENDING'", 't.nextAttemptAt<=?', "g.status='ACTIVE'",
        `t.capability IN (${capabilityValues.map(() => '?').join(',')})`];
      const params = [world, dimension, now, ...capabilityValues];
      if (Array.isArray(taskTypes)) {
        if (!taskTypes.length) { this.db.exec('COMMIT'); return null; }
        clauses.push(`t.type IN (${taskTypes.map(() => '?').join(',')})`);
        params.push(...taskTypes);
      }
      const baseQuery = `SELECT t.* FROM swarm_tasks t JOIN swarm_goals g ON g.id=t.goalId
        WHERE ${clauses.join(' AND ')} ORDER BY t.priority DESC,t.createdAt ASC,t.id ASC`;
      const candidates = [];
      for (let offset = 0; ; offset += 128) {
        const page = this.db.prepare(`${baseQuery} LIMIT 128 OFFSET ?`).all(...params, offset).map(taskFromRow);
        candidates.push(...page);
        if (page.length < 128) break;
      }
      const compatible = candidates.filter(candidate => allowed.has(candidate.capability) &&
        (!supportedTypes || supportedTypes.has(candidate.type)) && assignmentAllowed(candidate, agentId) &&
        this._dependenciesComplete(candidate));
      compatible.sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        const distance = task => {
          const anchor = taskAnchor(task.payload);
          if (!anchor || !position) return Number.MAX_SAFE_INTEGER;
          return (anchor.x - position.x) ** 2 + (anchor.y - position.y) ** 2 + (anchor.z - position.z) ** 2;
        };
        return distance(a) - distance(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
      });
      const task = compatible[0];
      if (!task) { this.db.exec('COMMIT'); return null; }
      const leaseToken = randomUUID();
      const result = this.db.prepare(`UPDATE swarm_tasks SET status='CLAIMED', leaseOwner=?, leaseToken=?,
        leaseExpiresAt=?, attempts=attempts+1, updatedAt=? WHERE id=? AND status='PENDING'`)
        .run(agentId, leaseToken, now + ttl, now, task.id);
      if (Number(result.changes) !== 1) { this.db.exec('ROLLBACK'); return null; }
      this.db.exec('COMMIT');
      this.recordEvent({ taskId: task.id, goalId: task.goalId, agentId, kind: 'TASK_CLAIMED', data: { leaseToken, ttl } });
      return { ...task, status: 'CLAIMED', leaseOwner: agentId, leaseToken, leaseExpiresAt: now + ttl, attempts: task.attempts + 1 };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  renewTask({ taskId, agentId, leaseToken, ttlMs = this.defaultLeaseTtlMs }) {
    const now = this.now();
    const ttl = Math.max(1000, Math.min(60000, Number(ttlMs) || this.defaultLeaseTtlMs));
    const result = this.db.prepare(`UPDATE swarm_tasks SET leaseExpiresAt=?,updatedAt=?
      WHERE id=? AND status='CLAIMED' AND leaseOwner=? AND leaseToken=? AND leaseExpiresAt>?`)
      .run(now + ttl, now, taskId, agentId, leaseToken, now);
    return Number(result.changes) === 1;
  }

  completeTask({ taskId, agentId, leaseToken, result = {} }) {
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = taskFromRow(this.db.prepare(`SELECT * FROM swarm_tasks WHERE id=? AND status='CLAIMED'
        AND leaseOwner=? AND leaseToken=? AND leaseExpiresAt>?`).get(taskId, agentId, leaseToken, now));
      if (!task) { this.db.exec('ROLLBACK'); return false; }
      if (requiresTaskVerification(task) && !isValidTaskVerification(result?.verification, now)) {
        this.recordEvent({ taskId, goalId: task.goalId, agentId, kind: 'TASK_COMPLETION_REJECTED',
          data: { reason: 'RESULT_NOT_VERIFIED', taskType: task.type } });
        this.db.exec('COMMIT');
        return false;
      }
      const update = this.db.prepare(`UPDATE swarm_tasks SET status='COMPLETED', result=?, lastError=NULL,
        leaseOwner=NULL, leaseToken=NULL, leaseExpiresAt=NULL, updatedAt=?
        WHERE id=? AND status='CLAIMED' AND leaseOwner=? AND leaseToken=? AND leaseExpiresAt>?`)
        .run(JSON.stringify(result || {}), now, taskId, agentId, leaseToken, now);
      if (Number(update.changes) !== 1) { this.db.exec('ROLLBACK'); return false; }
      this.recordEvent({ taskId, goalId: task.goalId, agentId, kind: 'TASK_COMPLETED', data: result || {} });
      this._refreshGoal(task.goalId);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deferTask({ taskId, agentId, leaseToken, reason, retryDelayMs = 5000 }) {
    if (reason === 'RESULT_NOT_VERIFIED') {
      return this.failTask({ taskId, agentId, leaseToken, error: reason, retryable: true });
    }
    const now = this.now();
    const nextAttemptAt = now + Math.max(250, Math.min(300000, Number(retryDelayMs) || 5000));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.db.prepare(`SELECT goalId,deferrals FROM swarm_tasks WHERE id=? AND status='CLAIMED'
        AND leaseOwner=? AND leaseToken=? AND leaseExpiresAt>?`).get(taskId, agentId, leaseToken, now);
      if (!task) { this.db.exec('ROLLBACK'); return false; }
      const exhausted = task.deferrals + 1 >= this.maxDeferrals;
      const result = this.db.prepare(`UPDATE swarm_tasks SET status=?,deferrals=deferrals+1,lastError=?,leaseOwner=NULL,
        leaseToken=NULL,leaseExpiresAt=NULL,nextAttemptAt=?,updatedAt=?
        WHERE id=? AND status='CLAIMED' AND leaseOwner=? AND leaseToken=? AND leaseExpiresAt>?`)
        .run(exhausted ? 'FAILED' : 'PENDING', exhausted ? 'DEFERRAL_LIMIT' : String(reason || 'DEFERRED'),
          nextAttemptAt, now, taskId, agentId, leaseToken, now);
      if (Number(result.changes) !== 1) { this.db.exec('ROLLBACK'); return false; }
      this.recordEvent({ taskId, goalId: task.goalId, agentId, kind: exhausted ? 'TASK_FAILED' : 'TASK_DEFERRED',
        data: { reason: exhausted ? 'DEFERRAL_LIMIT' : String(reason || 'DEFERRED'),
          cause: reason, deferrals: task.deferrals + 1, retryAt: exhausted ? null : nextAttemptAt } });
      if (exhausted) this._refreshGoal(task.goalId);
      this.db.exec('COMMIT');
      return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  noteTaskProgress({ taskId, agentId, leaseToken }) {
    return Number(this.db.prepare(`UPDATE swarm_tasks SET deferrals=0 WHERE id=? AND status='CLAIMED'
      AND leaseOwner=? AND leaseToken=? AND leaseExpiresAt>?`)
      .run(taskId, agentId, leaseToken, this.now()).changes) === 1;
  }

  failTask({ taskId, agentId, leaseToken, error, retryable = false }) {
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.db.prepare(`SELECT goalId,failures FROM swarm_tasks WHERE id=? AND status='CLAIMED'
        AND leaseOwner=? AND leaseToken=? AND leaseExpiresAt>?`).get(taskId, agentId, leaseToken, now);
      if (!task) { this.db.exec('ROLLBACK'); return false; }
      const failures = Number(task.failures || 0) + 1;
      const exhausted = !retryable || failures >= this.maxFailures;
      const retryAt = now + Math.min(60000, 1000 * (2 ** Math.min(failures - 1, 6)));
      this.db.prepare(`UPDATE swarm_tasks SET status=?,failures=?,lastError=?,leaseOwner=NULL,
        leaseToken=NULL,leaseExpiresAt=NULL,nextAttemptAt=?,updatedAt=? WHERE id=?`)
        .run(exhausted ? 'FAILED' : 'PENDING', failures, String(error || 'FAILED'), retryAt, now, taskId);
      this.recordEvent({ taskId, goalId: task.goalId, agentId,
        kind: exhausted ? 'TASK_FAILED' : 'TASK_RETRY',
        data: { error: String(error || 'FAILED'), retryable, failures, maxFailures: this.maxFailures, retryAt: exhausted ? null : retryAt } });
      if (exhausted) this._refreshGoal(task.goalId);
      this.db.exec('COMMIT');
      return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  _refreshGoal(goalId) {
    if (!goalId) return;
    let cascaded;
    do {
      cascaded = false;
      const taskRows = this.db.prepare(`SELECT id,dependencies FROM swarm_tasks
        WHERE goalId=? AND status='PENDING'`).all(goalId);
      const dependencyIds = [...new Set(taskRows.flatMap(row => parseJson(row.dependencies, [])))];
      const statusRows = dependencyIds.length
        ? this.db.prepare(`SELECT id,status FROM swarm_tasks WHERE id IN (${dependencyIds.map(() => '?').join(',')})`).all(...dependencyIds)
        : [];
      const statuses = new Map(statusRows.map(row => [row.id, row.status]));
      for (const row of taskRows) {
        const dependencies = parseJson(row.dependencies, []);
        const missing = dependencies.some(id => !statuses.has(id));
        const impossible = dependencies.some(id => ['FAILED', 'CANCELLED'].includes(statuses.get(id)));
        if (!missing && !impossible) continue;
        const status = missing ? 'FAILED' : 'CANCELLED';
        const reason = missing ? 'DEPENDENCY_MISSING' : 'DEPENDENCY_FAILED';
        const updated = this.db.prepare(`UPDATE swarm_tasks SET status=?,lastError=?,updatedAt=?
          WHERE id=? AND status='PENDING'`).run(status, reason, this.now(), row.id);
        if (Number(updated.changes) !== 1) continue;
        this.recordEvent({ taskId: row.id, goalId, kind: missing ? 'TASK_FAILED' : 'TASK_CANCELLED',
          data: { reason, dependencies } });
        cascaded = true;
      }
    } while (cascaded);
    const counts = this.db.prepare(`SELECT status,COUNT(*) AS count FROM swarm_tasks WHERE goalId=? GROUP BY status`).all(goalId);
    const total = counts.reduce((sum, row) => sum + Number(row.count), 0);
    const completed = Number(counts.find(row => row.status === 'COMPLETED')?.count || 0);
    const failed = Number(counts.find(row => row.status === 'FAILED')?.count || 0);
    const active = Number(counts.find(row => row.status === 'PENDING')?.count || 0) +
      Number(counts.find(row => row.status === 'CLAIMED')?.count || 0);
    const status = total > 0 && completed === total ? 'COMPLETED' : failed > 0 && active === 0 ? 'FAILED' : 'ACTIVE';
    this.db.prepare('UPDATE swarm_goals SET status=?,updatedAt=? WHERE id=?').run(status, this.now(), goalId);
  }

  listTasks({ goalId, world, dimension, status } = {}) {
    const clauses = [];
    const params = [];
    for (const [column, value] of [['goalId', goalId], ['world', world], ['dimension', dimension], ['status', status]]) {
      if (value === undefined) continue;
      clauses.push(`${column}=?`);
      params.push(value);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM swarm_tasks${where} ORDER BY priority DESC,createdAt,id`).all(...params).map(taskFromRow);
  }

  getGoal(goalId) {
    const row = this.db.prepare('SELECT * FROM swarm_goals WHERE id=?').get(goalId);
    return row ? { ...row, payload: parseJson(row.payload, {}) } : null;
  }

  cancelGoal(goalId, reason = 'CANCELLED') {
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const goal = this.db.prepare('UPDATE swarm_goals SET status=?,updatedAt=? WHERE id=? AND status=?')
        .run('CANCELLED', now, goalId, 'ACTIVE');
      if (Number(goal.changes) !== 1) { this.db.exec('ROLLBACK'); return false; }
      this.db.prepare(`UPDATE swarm_tasks SET status='CANCELLED',lastError=?,leaseOwner=NULL,
        leaseToken=NULL,leaseExpiresAt=NULL,updatedAt=? WHERE goalId=? AND status IN ('PENDING','CLAIMED')`)
        .run(String(reason), now, goalId);
      this.recordEvent({ goalId, kind: 'GOAL_CANCELLED', data: { reason: String(reason) } });
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listEvents({ goalId, taskId, limit = 200 } = {}) {
    const clauses = [];
    const params = [];
    if (goalId !== undefined) { clauses.push('goalId=?'); params.push(goalId); }
    if (taskId !== undefined) { clauses.push('taskId=?'); params.push(taskId); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM swarm_task_events${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, Math.max(1, Math.min(1000, Number(limit) || 200)));
    return rows.map(row => ({ ...row, data: parseJson(row.data, {}) })).reverse();
  }

  recordEvent({ taskId = null, goalId = null, agentId = null, kind, data = {} }) {
    this.db.prepare('INSERT INTO swarm_task_events(taskId,goalId,agentId,kind,data,createdAt) VALUES (?,?,?,?,?,?)')
      .run(taskId, goalId, agentId, kind, JSON.stringify(data || {}), this.now());
  }
}

module.exports = { SwarmTaskBoard, normalizeCapabilities, taskAnchor, assignmentAllowed,
  requiresTaskVerification, isValidTaskVerification };
