const key = p => `${p.x},${p.y},${p.z}`;
const AIR = new Set(['air','cave_air','void_air']);
const CROPS = new Set(['wheat','carrots','potatoes','beetroots','torchflower_crop','pitcher_crop']);
const WORKSTATIONS = new Set(['lectern','composter','fletching_table','smithing_table','cartography_table','brewing_stand','grindstone','loom','stonecutter','blast_furnace','smoker','barrel','cauldron']);
const TYPES = Object.freeze(['crop_farm','storage','workshop','smeltery','house_candidate','villager_area',
  'trading_hall_candidate','breeder_candidate','iron_farm_candidate','mob_farm_candidate','animal_enclosure_candidate',
  'portal','railway','redstone_system','water_area','lava_hazard','excavation_candidate','structure_candidate','unknown']);

function analyzeSpatialRegion({ blocks, entities = [], bounds }) {
  const inside = p => ['x','y','z'].every(a => p[a] >= bounds.min[a] && p[a] < bounds.max[a]);
  const map = new Map(blocks.filter(b => b?.position && inside(b.position)).map(b => [key(b.position), b]));
  const count = predicate => [...map.values()].filter(b => predicate(b.name)).length;
  const has = name => count(n => n === name);
  const volume = ['x','y','z'].reduce((v,a) => v*(bounds.max[a]-bounds.min[a]),1);
  const localEntities = entities.filter(e => e.position && inside(e.position));
  const entityCount = names => localEntities.filter(e => names.includes(e.name)).length;
  const remaining = new Set([...map].filter(([,b]) => AIR.has(b.name)).map(([k]) => k));
  const rooms = [];
  while (remaining.size) {
    const start = remaining.values().next().value;
    remaining.delete(start);
    const queue = [map.get(start).position];
    let enclosed = true;
    for (let i=0; i<queue.length; i++) {
      const p = queue[i];
      for (const [dx,dy,dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        const q = { x:p.x+dx,y:p.y+dy,z:p.z+dz };
        const b = map.get(key(q));
        if (!b) { enclosed = false; continue; }
        if (!AIR.has(b.name) && b.boundingBox !== 'block') enclosed = false;
        if (remaining.delete(key(q))) queue.push(q);
      }
    }
    if (enclosed && queue.length >= 4) rooms.push({ volume: queue.length,
      min: Object.fromEntries(['x','y','z'].map(a=>[a,Math.min(...queue.map(p=>p[a]))])),
      max: Object.fromEntries(['x','y','z'].map(a=>[a,Math.max(...queue.map(p=>p[a]))+1])) });
  }
  const evidence = {
    observedBlocks: map.size, expectedBlocks: volume, coverage: map.size/volume,
    farmland: has('farmland'), planted: [...map.values()].filter(b => CROPS.has(b.name)
      && map.get(key({ ...b.position,y:b.position.y-1 }))?.name === 'farmland').length,
    storage: count(n=>['chest','trapped_chest','barrel','shulker_box'].includes(n)||n.endsWith('_shulker_box')),
    furnaces: count(n=>['furnace','blast_furnace','smoker'].includes(n)),
    workstations: count(n=>WORKSTATIONS.has(n)), beds: count(n=>n.endsWith('_bed')),
    doors: count(n=>n.endsWith('_door')), villagers: entityCount(['villager']),
    golems: entityCount(['iron_golem']), livestock: entityCount(['cow','sheep','pig','chicken','rabbit']),
    fences: count(n=>n.endsWith('_fence')||n.endsWith('_fence_gate')),
    hoppers: has('hopper'), water: has('water'), lava: has('lava'), spawners: has('spawner'),
    buildingBlocks: count(n=>/_planks$|_bricks$|glass|_door$/.test(n)), enclosedRooms: rooms.length
  };
  const hypotheses = [];
  const add = (type, score, reasons) => hypotheses.push({ type, score, reasons, status: 'tentative' });
  if (evidence.planted) add('crop_farm',.9,['crops_above_farmland']);
  else if (evidence.farmland) add('crop_farm',.55,['unplanted_farmland']);
  if (evidence.storage) add('storage',.7,['containers']);
  if (has('crafting_table') || has('anvil')) add('workshop',.7,['crafting_or_anvil']);
  if (evidence.furnaces) add('smeltery',.7,['furnaces']);
  if (rooms.length && evidence.doors && evidence.beds) add('house_candidate',.7,['enclosed_space','doors','beds']);
  if (evidence.villagers) add('villager_area',.8,['villagers_observed']);
  if (evidence.villagers >= 2 && evidence.workstations >= 2) add('trading_hall_candidate',.55,['villagers','workstations','trade_activity_unverified']);
  if (evidence.villagers >= 2 && evidence.beds >= 3) add('breeder_candidate',.4,['villagers','beds','breeding_unverified']);
  if (evidence.villagers && evidence.golems && evidence.hoppers && evidence.water) add('iron_farm_candidate',.45,['golem','villagers','collection','spawn_cycle_unverified']);
  if (evidence.spawners || evidence.hoppers && evidence.water && entityCount(['zombie','skeleton','spider','creeper'])) add('mob_farm_candidate',.55,['spawner_or_mobs_with_collection']);
  if (evidence.livestock && evidence.fences) add('animal_enclosure_candidate',.6,['livestock','fences']);
  if (has('nether_portal') || has('end_portal')) add('portal',.95,['portal_blocks']);
  if (count(n=>n.endsWith('rail'))) add('railway',.8,['rails']);
  if (count(n=>['redstone_wire','repeater','comparator','piston','sticky_piston'].includes(n))) add('redstone_system',.7,['redstone_components']);
  if (evidence.water) add('water_area',.8,['water_blocks']);
  if (evidence.lava) add('lava_hazard',.95,['lava_blocks']);
  if (evidence.buildingBlocks >= 3) add('structure_candidate',.6,['processed_building_blocks']);
  const surfaces = [...map.values()].filter(b=>b.boundingBox==='block' && AIR.has(map.get(key({ ...b.position,y:b.position.y+1 }))?.name));
  if (surfaces.length && Math.max(...surfaces.map(b=>b.position.y))-Math.min(...surfaces.map(b=>b.position.y))>=3) {
    add('excavation_candidate',.3,['height_difference','natural_depression_not_excluded']);
  }
  if (!hypotheses.length) add('unknown',0,['insufficient_semantic_evidence']);
  return { bounds, evidence, rooms, hypotheses, observedAt: Date.now(), complete: map.size===volume,
    warning: 'Hipotesis area pengamatan, bukan batas seluruh bangunan atau probabilitas terkalibrasi.' };
}

module.exports = { analyzeSpatialRegion, TYPES };
