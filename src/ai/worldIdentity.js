function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

function resolveWorldIdentity(memory, {
  host,
  port,
  world,
  dimension = 'overworld',
  now = Date.now(),
  agentFreshMs = 45000,
  observerFreshMs = 120000
} = {}) {
  const explicit = String(world || '').trim();
  if (explicit) return explicit;

  const requestedHost = normalizeHost(host);
  const requestedPort = Number(port) || 25565;
  const fallback = requestedHost ? `${host}:${requestedPort}` : null;
  if (!requestedHost || !memory?.db) return fallback;

  const choose = rows => rows
    .filter(row => String(row.world || '').toLowerCase().startsWith(`${requestedHost}:`))
    .sort((a, b) => Number(b.lastSeen) - Number(a.lastSeen) ||
      (String(b.world).endsWith(`:${requestedPort}`) ? 1 : 0) - (String(a.world).endsWith(`:${requestedPort}`) ? 1 : 0))[0]?.world;

  try {
    const activeAgents = memory.db.prepare(`SELECT world,MAX(lastSeen) AS lastSeen FROM swarm_agents
      WHERE dimension=? AND lastSeen>? AND status!='STOPPED' GROUP BY world`)
      .all(dimension, now - agentFreshMs);
    const activeWorld = choose(activeAgents);
    if (activeWorld) return activeWorld;
  } catch { /* Agent table belum dibuat sebelum worker pertama kali berjalan. */ }

  try {
    const activeObservers = memory.db.prepare(`SELECT world,MAX(lastSeen) AS lastSeen FROM observers
      WHERE dimension=? AND lastSeen>? GROUP BY world`)
      .all(dimension, now - observerFreshMs);
    const activeWorld = choose(activeObservers);
    if (activeWorld) return activeWorld;

    // Treat the last observed host identity as the logical world across dashboard
    // restarts; the connection's resolved relay port can differ from the UI port.
    const knownObservers = memory.db.prepare(`SELECT world,MAX(lastSeen) AS lastSeen FROM observers
      WHERE dimension=? GROUP BY world`).all(dimension);
    return choose(knownObservers) || fallback;
  } catch { return fallback; }
}

module.exports = { resolveWorldIdentity, normalizeHost };
