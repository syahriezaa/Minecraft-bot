(function initStorageViewModel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StorageViewModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function positionKey(position) {
    if (!position) return '-';
    return `${position.x},${position.y},${position.z}`;
  }

  function aggregateItems(items = []) {
    const totals = new Map();
    for (const item of items) {
      if (!item?.name) continue;
      const current = totals.get(item.name) || { name: item.name, count: 0, stacks: 0 };
      current.count += Number(item.count) || 0;
      current.stacks += 1;
      totals.set(item.name, current);
    }
    return [...totals.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  function aggregateMisplaced(chests = []) {
    const groups = new Map();
    for (const chest of chests) {
      for (const item of chest.misplaced || []) {
        const from = positionKey(chest.position);
        const to = positionKey(item.targetPosition);
        const key = `${item.name}|${from}|${to}`;
        const current = groups.get(key) || {
          name: item.name || '?', count: 0, stacks: 0, from: chest.position, to: item.targetPosition
        };
        current.count += Number(item.count) || 0;
        current.stacks += 1;
        groups.set(key, current);
      }
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  function summarizeStorage(chests = []) {
    const summary = { chests: chests.length, cleanChests: 0, itemUnits: 0, misplacedUnits: 0 };
    for (const chest of chests) {
      const misplaced = chest.misplaced || [];
      if (misplaced.length === 0) summary.cleanChests += 1;
      summary.itemUnits += (chest.items || []).reduce((total, item) => total + (Number(item.count) || 0), 0);
      summary.misplacedUnits += misplaced.reduce((total, item) => total + (Number(item.count) || 0), 0);
    }
    return summary;
  }

  function filterChests(chests = [], categories = {}, query = '', status = 'all') {
    const needle = String(query).trim().toLowerCase();
    return chests.filter(chest => {
      const dirty = (chest.misplaced || []).length > 0;
      if (status === 'dirty' && !dirty) return false;
      if (status === 'clean' && dirty) return false;
      if (!needle) return true;
      const key = positionKey(chest.position);
      const category = categories[key] || '';
      const itemNames = (chest.items || []).map(item => item.name).join(' ');
      return `${key} ${category} ${itemNames}`.toLowerCase().includes(needle);
    });
  }

  return { aggregateItems, aggregateMisplaced, filterChests, positionKey, summarizeStorage };
}));
