// ================================================================
// DOM
// ================================================================
const startupScreen     = document.getElementById('startupScreen');
const loginScreen       = document.getElementById('loginScreen');
const travelScreen      = document.getElementById('travelScreen');
const destList          = document.querySelector('.dest-list');
const logEl             = document.getElementById('log');
const travelOverlay     = document.getElementById('travelOverlay');
const missionIndicator  = document.getElementById('missionIndicator');
const journalToggle     = document.getElementById('journalToggle');
const missionLogOverlay = document.getElementById('missionLogOverlay');

// ================================================================
// State
// ================================================================
let traveling          = false;
let currentLocation    = null;
let currentHub         = null;
let currentSubLocation = null;
let ambientTimer       = null;
let ambientFirstTimer  = null;
let dwellTimer         = null;
const AMBIENT_INTERVAL = 28000;

const ambientQueues      = {};
const mainDestinations   = [];
const destinationConfigs = {};
const ambientDialogue    = {};
const transmissions      = {};

let transmissionTimer   = null;
const TRANSMISSION_INTERVAL_MIN = 180000;
const TRANSMISSION_INTERVAL_MAX = 240000;

let destinationsReady = false;
let dialogueReady     = false;
let pendingStart      = false;

// ================================================================
// Nova Relationship
// ================================================================
const novaRel = { visits: 0, completions: 0 };

function getRelTier() {
  const tiers = NovaAI.dialogue.relationship?.tiers;
  if (!tiers) return 'Stranger';
  let tier = tiers[0];
  for (const t of tiers) {
    if (novaRel.completions >= t.minCompletions) tier = t;
  }
  return tier.label;
}

function checkTierUnlock(previousCompletions) {
  const tiers    = NovaAI.dialogue.relationship?.tiers;
  const unlocks  = NovaAI.dialogue.relationship?.tierUnlock;
  if (!tiers || !unlocks) return;
  for (const t of tiers) {
    if (t.label === 'Stranger') continue;
    if (previousCompletions < t.minCompletions &&
        novaRel.completions >= t.minCompletions) {
      setTimeout(() => appendLog(unlocks[t.label], 'log-nova log-nova-tier'), 2000);
    }
  }
}

// ================================================================
// Health System
// ================================================================
const Health = {
  max: 100,
  current: 100,
  shieldActive: false,

  LOCATION_DRAIN: {
    NewYork_Torta:          8,
    AncientVault:           12,
    ResearchBase_Tunnels:   10,
    Ruins:                  15,
    ExcavationPlatforms:    9,
    Pacific_Abyssal:        11,
    ResearchBase_Core:      13,
    CoreRelay:              7,
    BlackSpire:             6,
    ForwardRecon:           5,
    ColonyCore_Residential: -5,
    EarthSpacePort:         -3,
    CapitalCity:            -4
  },

  ARRIVAL_DAMAGE: {
    Ruins:                  10,
    AncientVault:           8,
    ResearchBase_Tunnels:   6,
    Pacific_Abyssal:        7,
    ExcavationPlatforms:    5
  },

  drainInterval: null,

  get pct() { return Math.round((this.current / this.max) * 100); },

  modify(amount) {
    this.current = Math.max(0, Math.min(this.max, this.current + amount));
    this.render();
    if (this.current <= 0) this.die();
  },

  startDrain(key) {
    this.stopDrain();
    const rate = this.LOCATION_DRAIN[key];
    if (!rate) return;
    const MAX_TICKS = rate > 0 ? 2 : 3;
    let ticks = 0;
    this.drainInterval = setInterval(() => {
      if (currentLocation !== key) { this.stopDrain(); return; }
      if (ticks >= MAX_TICKS) { this.stopDrain(); return; }
      ticks++;
      const delta = rate > 0 ? -rate : Math.abs(rate);
      this.modify(delta);
      if (rate > 0 && this.current < 40) {
        appendLog('Nova: Captain, your vitals are deteriorating. Consider leaving.', 'log-nova');
      }
    }, 20000);
  },

  stopDrain() {
    clearInterval(this.drainInterval);
    this.drainInterval = null;
  },

  applyArrivalDamage(key) {
    const dmg = this.ARRIVAL_DAMAGE[key];
    if (!dmg) return;
    this.modify(-dmg);
    appendLog('System: Hazardous environment detected. Suit integrity reduced.', 'log-system');
  },

  shipHeal() {
    const healed = Math.min(this.max - this.current, 30);
    if (healed > 0) {
      this.modify(healed);
      appendLog(`System: Medical systems online. Vitals stabilised (+${healed}).`, 'log-system');
    }
  },

  die() {
    this.stopDrain();
    clearAmbientTimers();
    clearTimeout(dwellTimer);
    NovaAI.stopIdle();
    stopTransmissions();
    runExtractionSequence(() => {
      this.current = 40;
      this.render();
      currentLocation = currentHub = currentSubLocation = null;
      // Save progress but at ship with no location — keeps missions/collectibles/Nova tier
      saveState();
      createButtons(mainDestinations);
      // Post-extraction Nova line — tier aware, fires after a short delay
      setTimeout(() => {
        const tier = getRelTier();
        const pool = NovaAI.dialogue.extraction?.postExtraction?.[tier]
          || NovaAI.dialogue.extraction?.postExtraction?.Stranger;
        if (pool?.length) {
          appendLog(pool[Math.floor(Math.random() * pool.length)], 'log-nova');
        }
        scheduleNextTransmission();
      }, 2000);
    });
  },

  render() {
    const bar    = document.getElementById('healthBar');
    const label  = document.getElementById('healthLabel');
    const widget = document.getElementById('healthWidget');
    if (!bar || !label || !widget) return;
    bar.style.width    = `${this.pct}%`;
    label.textContent  = `${this.current}/${this.max}`;
    bar.className      = 'health-bar-fill';
    if (this.pct <= 25)      bar.classList.add('critical');
    else if (this.pct <= 50) bar.classList.add('low');
    widget.classList.toggle('health-critical', this.pct <= 25);
  },

  save()       { return { current: this.current }; },
  load(data)   { if (data?.current !== undefined) { this.current = data.current; this.render(); } }
};

// ================================================================
// Missions
// ================================================================
const MISSIONS = [
  {
    id: 'mission_01',
    title: 'First Contact Protocol',
    desc: 'ECS Command wants a field report from the Torta Excavation Site beneath New York.',
    target: 'NewYork_Torta',
    reward: 'Access to classified excavation frequency logs.',
    rewardKey: 'TORTA_LOGS',
    complete: false,
    dwellSecs: 35
  },
  {
    id: 'mission_02',
    title: 'Deep Signal',
    desc: 'Unconfirmed transmissions from the Pacific Abyssal Wing. Investigate and confirm.',
    target: 'Pacific_Abyssal',
    reward: 'Deep sea organism specimen — Specimen 7-C.',
    rewardKey: 'SPECIMEN_7C',
    complete: false,
    dwellSecs: 40
  },
  {
    id: 'mission_03',
    title: 'Vault Reconnaissance',
    desc: 'The Ancient Vault on Mars has gone dark. Establish contact with the research team.',
    target: 'AncientVault',
    reward: 'Pre-human inscription rubbing — Fragment Alpha.',
    rewardKey: 'VAULT_FRAGMENT',
    complete: false,
    dwellSecs: 30
  },
  {
    id: 'mission_04',
    title: 'Storm Analysis',
    desc: 'The Jupiter Storm Observatory Sensor Array is reporting anomalous pattern data.',
    target: 'StormObservatory_Sensors',
    reward: 'Storm pattern data core — Cycle 44.',
    rewardKey: 'STORM_DATA',
    complete: false,
    dwellSecs: 30
  },
  {
    id: 'mission_05',
    title: 'Shifting Tunnels',
    desc: 'Europa subsurface tunnel maps no longer match field observations. Survey the tunnels.',
    target: 'ResearchBase_Tunnels',
    reward: 'Ice core sample — Sector 7 deep layer.',
    rewardKey: 'ICE_CORE',
    complete: false,
    dwellSecs: 40
  },
  {
    id: 'mission_06',
    title: 'Archive Integrity',
    desc: 'Language AIs in the Xeno Archives are behaving erratically. Assess the situation.',
    target: 'XenoArchives',
    reward: 'Partial xenolinguistic index — Volume III.',
    rewardKey: 'XENO_INDEX',
    complete: false,
    dwellSecs: 30
  },
  {
    id: 'mission_07',
    title: 'Resonance Study',
    desc: 'Crystal Canyon Outpost reports unusual amplification of ECS signals. Verify on site.',
    target: 'CrystalCanyonOutpost',
    reward: 'Resonant crystal shard — Grade A.',
    rewardKey: 'CRYSTAL_SHARD',
    complete: false,
    dwellSecs: 25
  }
];

// ================================================================
// Classified Files
// ================================================================
const CLASSIFIED_FILES = [
  {
    id: 'file_01',
    unlockedBy: 'TORTA_LOGS',
    title: 'ECS INTERNAL — EXCAVATION FREQUENCY ANALYSIS',
    clearance: 'LEVEL 2',
    lines: [
      'The resonance signature recorded at depth 9 of the New York Torta site does not correspond to any known geological process.',
      'Cross-referencing with the Kilko pre-event data shows a 94% waveform match.',
      'This information has not been shared with the site crew.',
      'Recommendation: continue excavation. Do not increase crew clearance at this time.',
      '[SIGNED] — Office of the Chief Amplifier'
    ]
  },
  {
    id: 'file_02',
    unlockedBy: 'SPECIMEN_7C',
    title: 'PACIFIC RESEARCH — ABYSSAL ORGANISM ASSESSMENT',
    clearance: 'LEVEL 3',
    lines: [
      'Specimen 7-C exhibits learning behaviour inconsistent with its neurological structure.',
      'It has solved containment protocols that were designed after its capture.',
      'DNA sequencing confirms no terrestrial ancestry.',
      'Three researchers have requested transfer. Requests denied.',
      'The organism appears to be waiting. For what, we cannot determine.',
      '[CLASSIFICATION: EYES ONLY]'
    ]
  },
  {
    id: 'file_03',
    unlockedBy: 'VAULT_FRAGMENT',
    title: 'MARS VAULT — SURVEY TEAM FINAL TRANSMISSION',
    clearance: 'LEVEL 3',
    lines: [
      'This is Dr. Alinta Marsh, lead surveyor, Ancient Vault sub-level 11.',
      'We found something below the sealed section. The official maps are wrong.',
      'There are more levels. Many more. The structure goes down further than the planet should allow.',
      'The symbols here are different. They\'re not decorative. They\'re instructions.',
      'We are — [SIGNAL INTERRUPTED]',
      '[NOTE: Dr. Marsh transferred to Quiet Programme. Survey team currently in debrief. Duration: indefinite.]'
    ]
  },
  {
    id: 'file_04',
    unlockedBy: 'STORM_DATA',
    title: 'JUPITER OBSERVATORY — CYCLE 44 PATTERN ANALYSIS',
    clearance: 'LEVEL 2',
    lines: [
      'The storm cycle data from Cycle 44 contains a signal embedded within the atmospheric interference.',
      'The signal repeats on a 17-minute loop. It is not random.',
      'When mapped against known mathematical constants, it produces a coordinate set.',
      'The coordinates point to a location inside Jupiter.',
      'We have not transmitted this finding to ECS Command.',
      'We are not sure we should.'
    ]
  },
  {
    id: 'file_05',
    unlockedBy: 'ICE_CORE',
    title: 'EUROPA TUNNELS — ICE CORE ANALYSIS, SECTOR 7',
    clearance: 'LEVEL 3',
    lines: [
      'Organic compounds found in the Sector 7 ice core predate the formation of Europa by approximately 200,000 years.',
      'This is not a measurement error. The equipment has been recalibrated four times.',
      'The compounds are not terrestrial. They are not from any catalogued source in the solar system.',
      'Trace analysis suggests they were placed there intentionally.',
      'The ice around them has been shaped. Carefully. Around them.',
      '[NOTE: This file is flagged for Chief Amplifier review. Do not distribute.]'
    ]
  },
  {
    id: 'file_06',
    unlockedBy: 'XENO_INDEX',
    title: 'ANDROMEDA ARCHIVES — XENOLINGUISTIC INDEX VOL. III [PARTIAL]',
    clearance: 'LEVEL 4',
    lines: [
      'The archive language does not function as communication between parties.',
      'It functions as communication across time.',
      'The symbols are not words. They are states. Conditions. Instructions written for a reader who does not yet exist.',
      'Volume III contains what appears to be a warning.',
      'The translation team has been stood down. Their notes have been archived.',
      'We have not published a translation because we do not agree on what it says.',
      'We do agree on what it implies.',
      '[REMAINDER OF INDEX: CLASSIFIED LEVEL 5 — CHIEF AMPLIFIER ACCESS ONLY]'
    ]
  },
  {
    id: 'file_07',
    unlockedBy: 'CRYSTAL_SHARD',
    title: 'VEGA — CRYSTAL CANYON SIGNAL AMPLIFICATION REPORT',
    clearance: 'LEVEL 2',
    lines: [
      'The crystal formations at Canyon Outpost are not amplifying our signals.',
      'They are amplifying a signal that was already present.',
      'Our transmissions are riding on top of something older.',
      'The underlying signal has been broadcasting continuously for longer than we can measure.',
      'When we filter our own transmissions out, what remains is structured.',
      'It sounds like a question.',
      'We do not know what it is asking.',
      'We do not know if it has received an answer.'
    ]
  }
];

// Track which files have been unlocked
const unlockedFiles = new Set();

function unlockClassifiedFile(rewardKey) {
  const file = CLASSIFIED_FILES.find(f => f.unlockedBy === rewardKey);
  if (!file || unlockedFiles.has(file.id)) return;
  unlockedFiles.add(file.id);
  setTimeout(() => {
    appendLog('▶ CLASSIFIED FILE UNLOCKED — check your journal.', 'log-classified-alert');
  }, 3000);
}

// ================================================================
// Collectibles
// ================================================================
const COLLECTIBLES = [
  { id: 'col_01', name: 'Kilko Fragment — Node 7',  desc: 'Still warm to the touch. Radiation minimal.',           location: 'Pacific_ArtifactLab',      found: false },
  { id: 'col_02', name: 'Encrypted Data Core',      desc: 'Origin: unknown. Format: unreadable.',                  location: 'ResearchBase_Lab',          found: false },
  { id: 'col_03', name: 'Obsidian Statue Shard',    desc: 'Edges are too perfect. Not carved — grown.',            location: 'StatueWing',                found: false },
  { id: 'col_04', name: 'Void Berry Sample',         desc: 'Technically not legal yet. Smells incredible.',         location: 'EarthSpacePort_FrontDesk',  found: false },
  { id: 'col_05', name: 'Torta Wall Rubbing',        desc: 'Symbols shift between viewings.',                       location: 'NewYork_Torta',             found: false },
  { id: 'col_06', name: 'Abyssal Organism — Jar',   desc: 'Still glowing. Still moving.',                          location: 'Pacific_Abyssal',           found: false },
  { id: 'col_07', name: 'Storm Data Wafer',          desc: 'The pattern stored here repeats every 88 seconds.',     location: 'StormObservatory_Sensors',  found: false },
  { id: 'col_08', name: 'Vault Inscription Photo',   desc: 'Camera corrupted on upload. Image survived.',           location: 'AncientVault',              found: false },
  { id: 'col_09', name: 'Crystal Shard — Grade A',  desc: 'Resonates at exactly 440 Hz. Concert A.',               location: 'CrystalCanyonOutpost',      found: false },
  { id: 'col_10', name: 'Tunnel Ice Core',           desc: 'Contains organic compounds 200,000 years old.',         location: 'ResearchBase_Tunnels',      found: false }
];

const heardLog = [];
const transmissionLog = [];

// ================================================================
// Save / Restore
// ================================================================
const SAVE_KEY = 'distania_save';

function saveState() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      currentLocation, currentHub, currentSubLocation,
      missions:      MISSIONS.map(m => ({ id: m.id, complete: m.complete })),
      collectibles:  COLLECTIBLES.map(c => ({ id: c.id, found: c.found })),
      novaRel,
      health:           Health.save(),
      unlockedFiles:    [...unlockedFiles],
      transmissionLog:  transmissionLog.slice(0, 50)
    }));
  } catch (_) {}
}

function loadState() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);

    if (s.missions)      s.missions.forEach(sv => { const m = MISSIONS.find(m => m.id === sv.id);     if (m) m.complete = sv.complete; });
    if (s.collectibles)  s.collectibles.forEach(sv => { const c = COLLECTIBLES.find(c => c.id === sv.id); if (c) c.found = sv.found; });
    if (s.novaRel)       Object.assign(novaRel, s.novaRel);
    if (s.health)        Health.load(s.health);
    if (s.unlockedFiles) s.unlockedFiles.forEach(id => unlockedFiles.add(id));
    if (s.transmissionLog) { transmissionLog.length = 0; s.transmissionLog.forEach(t => transmissionLog.push(t)); }

    if (s.currentHub && destinationConfigs[s.currentHub]) {
      currentLocation    = s.currentLocation;
      currentHub         = s.currentHub;
      currentSubLocation = s.currentSubLocation;
      return true;
    }
    return false;
  } catch (_) { return false; }
}

function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch (_) {}
}

// ================================================================
// Data Loading
// ================================================================
function onDataReady() {
  if (!destinationsReady || !dialogueReady) return;
  if (pendingStart) { pendingStart = false; startTravelConsole(); }
}

fetch(`destinations.json?v=${Date.now()}`)
  .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then(data => {
    mainDestinations.push(...data.mainDestinations);
    Object.assign(destinationConfigs, data.destinationConfigs);
    destinationsReady = true;
    onDataReady();
  })
  .catch(err => {
    console.error('destinations.json failed:', err);
    loadFallbackDestinations();
    destinationsReady = true;
    onDataReady();
  });

async function loadDialogueFiles() {
  // Load each file independently so one bad file doesn't break the others
  try {
    const nova = await fetch(`novaDialogue.json?v=${Date.now()}`).then(r => r.json());
    NovaAI.dialogue = nova;
  } catch(err) {
    console.error('novaDialogue.json failed:', err);
    appendLog('System: Nova dialogue offline — ' + err.message, 'log-system');
  }

  try {
    const ambient = await fetch(`ambientDialogue.json?v=${Date.now()}`).then(r => r.json());
    // Sanitise keys — strip BOM or stray whitespace
    Object.keys(ambient).forEach(k => {
      const clean = k.replace(/^[\uFEFF\u200B\s]+|[\s]+$/g, '');
      ambientDialogue[clean] = ambient[k];
    });
  } catch(err) {
    console.error('ambientDialogue.json failed:', err);
    appendLog('System: Ambient dialogue offline — ' + err.message, 'log-system');
  }

  try {
    const trans = await fetch(`transmissions.json?v=${Date.now()}`).then(r => r.json());
    Object.assign(transmissions, trans);
  } catch(err) {
    console.error('transmissions.json failed:', err);
    appendLog('System: Transmission array offline — ' + err.message, 'log-system');
  }

  dialogueReady = true;
  onDataReady();
}
loadDialogueFiles();

// ================================================================
// Fallback Destinations
// ================================================================
function loadFallbackDestinations() {
  appendLog('System: Navigation data unavailable — loading emergency backup.', 'log-system');
  const fallback = {
    mainDestinations: [
      { name: 'Earth', key: 'Earth' }, { name: 'Mars Colony Alpha', key: 'Mars' },
      { name: 'Jupiter Orbital Station', key: 'Jupiter' }, { name: 'Europa Research Base', key: 'Europa' },
      { name: 'Andromeda Outpost', key: 'Andromeda' }, { name: 'Vega Prime', key: 'Vega' }
    ],
    destinationConfigs: {
      Earth: { description: 'Orbiting Earth.', travelType: 'train', subDestinations: [
        { name: 'Return to Ship', key: 'Return' },
        { name: 'New York Sector', key: 'NewYork', description: 'Rebuilt after the Kilko disaster.', subDestinations: [
          { name: 'Return to Previous', key: 'Return' },
          { name: 'Downtown Core', key: 'NewYork_Downtown', description: 'Center of rebuilt New York.' },
          { name: 'Torta Excavation Site', key: 'NewYork_Torta', description: 'Ongoing megastructure digs.' },
          { name: 'Skyline Transit Nexus', key: 'NewYork_Transit', description: 'Floating vertical transit.' }
        ]},
        { name: 'Earth Space Port', key: 'EarthSpacePort', description: 'Cargo and civilian port.', subDestinations: [
          { name: 'Return to Previous', key: 'Return' },
          { name: 'Processing', key: 'EarthSpacePort_FrontDesk', description: 'Inspection zone.' },
          { name: 'Cargo Intake', key: 'EarthSpacePort_Cargo', description: 'Freight unloading.' },
          { name: 'Docking Bay', key: 'EarthSpacePort_Docking', description: 'Refueling and boarding.' }
        ]},
        { name: 'Pacific Research Facility', key: 'Pacific', description: 'Floating research base.', subDestinations: [
          { name: 'Return to Previous', key: 'Return' },
          { name: 'Kilko Artifact Lab', key: 'Pacific_ArtifactLab', description: 'Kilko containment.' },
          { name: 'Deep Sea Observatory', key: 'Pacific_Observatory', description: 'Submersible monitoring.' },
          { name: 'Abyssal Research Wing', key: 'Pacific_Abyssal', description: 'Deep trench labs.' }
        ]}
      ]},
      Mars: { description: 'Orbiting Mars Colony Alpha.', travelType: 'shuttle', subDestinations: [
        { name: 'Return to Ship', key: 'Return' },
        { name: 'Colony Core', key: 'ColonyCore', description: 'Heart of Martian habitation.', subDestinations: [
          { name: 'Return to Previous', key: 'Return' },
          { name: 'Residential Dome', key: 'ColonyCore_Residential', description: 'Colonist quarters.' },
          { name: 'Central Market', key: 'ColonyCore_Market', description: 'Commercial hub.' },
          { name: 'Power Hub', key: 'ColonyCore_Power', description: 'Life support power.' }
        ]},
        { name: 'Terraforming Fields', key: 'TerraformingFields', description: 'Atmosphere processors.', subDestinations: [{ name: 'Return to Previous', key: 'Return' }] },
        { name: 'Ancient Vault', key: 'AncientVault', description: 'Pre-human vault.', subDestinations: [{ name: 'Return to Previous', key: 'Return' }] }
      ]},
      Jupiter: { description: 'Orbiting Jupiter Orbital Station.', subDestinations: [
        { name: 'Return to Ship', key: 'Return' },
        { name: 'Storm Observatory', key: 'StormObservatory', description: 'Jupiter storm monitoring.', subDestinations: [
          { name: 'Return to Previous', key: 'Return' },
          { name: 'Sensor Array', key: 'StormObservatory_Sensors', description: 'EM field sensors.' },
          { name: 'Atmospheric Lab', key: 'StormObservatory_Lab', description: 'Weather research.' }
        ]},
        { name: 'Gas Harvesting Platform', key: 'GasHarvester', description: 'Fuel siphoning.', subDestinations: [{ name: 'Return to Previous', key: 'Return' }] },
        { name: 'Research Array', key: 'ResearchArray', description: 'Drone sensor network.', subDestinations: [{ name: 'Return to Previous', key: 'Return' }] },
        { name: 'Deep Core Relay', key: 'CoreRelay', description: 'Deep atmosphere comms.', subDestinations: [{ name: 'Return to Previous', key: 'Return' }] },
        { name: 'Excavation Platforms', key: 'ExcavationPlatforms', description: 'Ring excavation.', subDestinations: [{ name: 'Return to Previous', key: 'Return' }] }
      ]},
      Europa: { description: 'Orbiting Europa Research Base.', travelType: 'rover', subDestinations: [
        { name: 'Return to Ship', key: 'Return' },
        { name: 'Research Base', key: 'ResearchBase', description: 'Core Europa station.', subDestinations: [
          { name: 'Return to Previous', key: 'Return' },
          { name: 'Subsurface Tunnels', key: 'ResearchBase_Tunnels', description: 'Ice tunnels below.' },
          { name: 'AI Lab', key: 'ResearchBase_Lab', description: 'AI behavior research.' },
          { name: 'Core Chamber', key: 'ResearchBase_Core', description: 'Flooded cavern.' }
        ]},
        { name: 'Ground Camp', key: 'GroundCamp', description: 'Field drilling base.', subDestinations: [{ name: 'Return to Previous', key: 'Return' }] },
        { name: 'Ruins', key: 'Ruins', description: 'Ancient megastructure under ice.', subDestinations: [{ name: 'Return to Previous', key: 'Return' }] }
      ]},
      Andromeda: { description: 'Orbiting Andromeda Outpost.', travelType: 'shuttle', subDestinations: [
        { name: 'Return to Ship', key: 'Return' },
        { name: 'Forward Recon Station', key: 'ForwardRecon', description: 'Deep-space monitoring.', subDestinations: [{ name: 'Return to Previous', key: 'Return' }] },
        { name: 'Black Spire Relay', key: 'BlackSpire', description: 'Quantum signal relay.', subDestinations: [{ name: 'Return to Previous', key: 'Return' }] },
        { name: 'Xeno Archives', key: 'XenoArchives', description: 'Alien artifact vault.', subDestinations: [{ name: 'Return to Previous', key: 'Return' }] },
        { name: 'Statue Research Wing', key: 'StatueWing', description: 'Chamber of alien statues.', subDestinations: [{ name: 'Return to Previous', key: 'Return' }] }
      ]},
      Vega: { description: 'Orbiting Vega Prime.', subDestinations: [
        { name: 'Return to Ship', key: 'Return' },
        { name: 'Capital City', key: 'CapitalCity', description: 'Neon metropolis.', subDestinations: [
          { name: 'Return to Previous', key: 'Return' },
          { name: 'Tech District', key: 'CapitalCity_Tech', description: 'AI and startup hub.' },
          { name: 'Underdeck Market', key: 'CapitalCity_Market', description: 'Black market.' },
          { name: 'Central Core', key: 'CapitalCity_Core', description: 'City processors.' }
        ]},
        { name: 'Orbital Trade Ring', key: 'OrbitalTradeRing', description: 'Trade ring.', subDestinations: [{ name: 'Return to Previous', key: 'Return' }] },
        { name: 'Stellar Observation Spire', key: 'StellarObservationSpire', description: 'First to spot megastructures.', subDestinations: [{ name: 'Return to Previous', key: 'Return' }] },
        { name: 'Crystal Canyon Outpost', key: 'CrystalCanyonOutpost', description: 'Gem mines.', subDestinations: [{ name: 'Return to Previous', key: 'Return' }] }
      ]}
    }
  };
  mainDestinations.push(...fallback.mainDestinations);
  Object.assign(destinationConfigs, fallback.destinationConfigs);
}

// ================================================================
// Log Helper
// ================================================================
function appendLog(text, cssClass = '') {
  const line = document.createElement('div');
  line.textContent = text.trim();
  if (cssClass) {
    cssClass.split(' ').forEach(c => { if (c) line.classList.add(c); });
  }
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// ================================================================
// Startup
// ================================================================
function initStartupScreen() {
  try {
    if (localStorage.getItem(SAVE_KEY)) {
      document.getElementById('wipeSaveBtn').classList.remove('hidden');
    }
  } catch(_) {}
}

// ================================================================
// Boot Sequence
// ================================================================
const BOOT_LINES = [
  { text: 'DISTANIA TRAVEL GROUP — MARK IV NAVIGATION CONSOLE', delay: 0,    cls: 'boot-header' },
  { text: 'BIOS v4.1.7 — EXODUS CIVIL SERVICE CERTIFIED',       delay: 120,  cls: 'boot-dim' },
  { text: '',                                                    delay: 220 },
  { text: '[ POWER-ON SELF TEST ]',                             delay: 320,  cls: 'boot-section' },
  { text: '  Initialising memory banks .......... ',            delay: 480,  cls: 'boot-line', inline: 'OK',         inlineCls: 'boot-ok' },
  { text: '  Checking nav array ................. ',            delay: 700,  cls: 'boot-line', inline: 'OK',         inlineCls: 'boot-ok' },
  { text: '  Verifying hull sensor matrix ....... ',            delay: 960,  cls: 'boot-line', inline: 'OK',         inlineCls: 'boot-ok' },
  { text: '  Scanning drive cores ............... ',            delay: 1240, cls: 'boot-line', inline: 'OK',         inlineCls: 'boot-ok' },
  { text: '  Zero-point coil integrity .......... ',            delay: 1560, cls: 'boot-line', inline: 'OK',         inlineCls: 'boot-ok' },
  { text: '  Life support reserves .............. ',            delay: 1840, cls: 'boot-line', inline: 'OK',         inlineCls: 'boot-ok' },
  { text: '  Quantum comms handshake ............ ',            delay: 2160, cls: 'boot-line', inline: 'DEGRADED',   inlineCls: 'boot-warn' },
  { text: '  >> Signal loss on channel 7-C. Rerouting via relay.', delay: 2340, cls: 'boot-note' },
  { text: '',                                                    delay: 2600 },
  { text: '[ LOADING ECS FIELD AGENT PROFILE ]',               delay: 2700, cls: 'boot-section' },
  { text: '  Agent credentials .................. ',            delay: 2900, cls: 'boot-line', inline: 'VERIFIED',   inlineCls: 'boot-ok' },
  { text: '  Clearance level .................... ',            delay: 3150, cls: 'boot-line', inline: 'LEVEL 1',    inlineCls: 'boot-ok' },
  { text: '  Accessing mission database ......... ',            delay: 3400, cls: 'boot-line', inline: 'OK',         inlineCls: 'boot-ok' },
  { text: '  Loading destination manifests ...... ',            delay: 3700, cls: 'boot-line', inline: 'OK',         inlineCls: 'boot-ok' },
  { text: '  Syncing field AI (NOVA) ............ ',            delay: 4000, cls: 'boot-line', inline: 'ONLINE',     inlineCls: 'boot-ok' },
  { text: '',                                                    delay: 4300 },
  { text: '[ ANOMALY LOG — LAST SESSION ]',                    delay: 4400, cls: 'boot-section' },
  { text: '  Previous session records ........... ',            delay: 4600, cls: 'boot-line', inline: 'NOT FOUND',  inlineCls: 'boot-dim' },
  { text: '  >> This is your first recorded departure. Good luck, Captain.', delay: 4850, cls: 'boot-note' },
  { text: '',                                                    delay: 5200 },
  { text: '[ DISTANIA TRAVEL GROUP NETWORK ]',                 delay: 5300, cls: 'boot-section' },
  { text: '  Uplink to orbital relay ............ ',            delay: 5500, cls: 'boot-line', inline: 'OK',         inlineCls: 'boot-ok' },
  { text: '  Destination index loaded ........... ',            delay: 5750, cls: 'boot-line', inline: '6 SYSTEMS',  inlineCls: 'boot-ok' },
  { text: '  ECS broadcast frequency active ..... ',            delay: 6000, cls: 'boot-line', inline: 'LISTENING',  inlineCls: 'boot-ok' },
  { text: '  Megastructure research uplink ....... ',           delay: 6250, cls: 'boot-line', inline: 'RESTRICTED', inlineCls: 'boot-warn' },
  { text: '  >> Access requires clearance 4+. Flagged for future unlock.', delay: 6430, cls: 'boot-note' },
  { text: '',                                                    delay: 6700 },
  { text: 'ALL SYSTEMS NOMINAL.',                               delay: 6800, cls: 'boot-header' },
  { text: 'LAUNCHING NAVIGATION INTERFACE...',                  delay: 7100, cls: 'boot-dim' }
];

const BOOT_CSS = `
  #bootScreen {
    position: fixed; inset: 0; background: #000; z-index: 18500;
    display: flex; justify-content: center; align-items: center;
    font-family: 'Share Tech Mono', monospace; font-size: 0.82rem;
    color: #8dfd8d; overflow: hidden;
  }
  #bootInner {
    width: min(820px, 92vw); height: min(72vh, 600px);
    background: #030608; border: 2px solid #0a1a10;
    box-shadow: 0 0 0 8px #060c08, 0 0 0 10px #0a1008, 0 0 60px rgba(0,0,0,0.9);
    padding: 2rem 2.5rem; overflow: hidden; position: relative;
    display: flex; flex-direction: column;
  }
  #bootInner::after {
    content: ''; position: absolute; inset: 0; pointer-events: none;
    background: repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,20,10,0.13) 3px, rgba(0,20,10,0.13) 4px);
  }
  #bootLines { flex: 1; overflow: hidden; display: flex; flex-direction: column; gap: 0; }
  .boot-header  { color: #8dfd8d; letter-spacing: 0.12rem; font-size: 0.85rem; margin-bottom: 0.1rem; }
  .boot-section { color: rgba(141,253,141,0.55); letter-spacing: 0.1rem; font-size: 0.78rem; margin: 0.6rem 0 0.1rem; }
  .boot-line    { color: rgba(141,253,141,0.75); }
  .boot-dim     { color: rgba(141,253,141,0.35); }
  .boot-note    { color: rgba(141,253,141,0.42); font-size: 0.76rem; padding-left: 0.5rem; }
  .boot-ok      { color: #8dfd8d; }
  .boot-warn    { color: #ffd97d; text-shadow: 0 0 6px rgba(255,200,50,0.4); }
  #bootCursor   { display: inline-block; width: 8px; height: 0.85em; background: #8dfd8d; vertical-align: middle; animation: bootBlink 0.65s step-end infinite; margin-left: 2px; }
  @keyframes bootBlink { 0%,100%{opacity:1} 50%{opacity:0} }
  #bootScreen.boot-fade { animation: bootFadeOut 0.6s ease forwards; }
  @keyframes bootFadeOut { 0%{opacity:1} 40%{opacity:1;background:#fff} 55%{opacity:0;background:#fff} 100%{opacity:0} }
`;

function runBootSequence(onComplete) {
  const style = document.createElement('style');
  style.textContent = BOOT_CSS;
  document.head.appendChild(style);

  const bootScreen = document.createElement('div');
  bootScreen.id = 'bootScreen';
  bootScreen.innerHTML = `<div id="bootInner"><div id="bootLines"></div><span id="bootCursor"></span></div>`;
  document.body.appendChild(bootScreen);

  const linesEl = document.getElementById('bootLines');

  function addLine(entry) {
    const row = document.createElement('div');
    if (entry.cls) row.className = entry.cls;
    if (entry.text === '') {
      row.style.height = '0.5rem';
      row.innerHTML = '&nbsp;';
      linesEl.appendChild(row);
      return;
    }
    if (entry.inline) {
      row.textContent = entry.text;
      linesEl.appendChild(row);
      setTimeout(() => {
        const badge = document.createElement('span');
        badge.className = entry.inlineCls || '';
        badge.textContent = entry.inline;
        row.appendChild(badge);
      }, 180);
    } else {
      row.textContent = entry.text;
      linesEl.appendChild(row);
    }
    linesEl.scrollTop = linesEl.scrollHeight;
  }

  BOOT_LINES.forEach(entry => setTimeout(() => addLine(entry), entry.delay));

  const totalDuration = BOOT_LINES[BOOT_LINES.length - 1].delay + 1200;
  setTimeout(() => {
    bootScreen.classList.add('boot-fade');
    setTimeout(() => {
      bootScreen.remove();
      style.remove();
      onComplete();
    }, 600);
  }, totalDuration);
}

// ================================================================
// Nova AI
// ================================================================
const NovaAI = {
  dialogue: {},
  idleTimer: null,

  speak(category) {
    const pool = this.dialogue[category];
    if (!pool?.length) return;
    appendLog(pool[Math.floor(Math.random() * pool.length)], 'log-nova');
  },

  speakTiered(baseCategory) {
    const tier = getRelTier();
    const tieredKey = `${baseCategory}_${tier}`;
    const tieredPool = this.dialogue.relationship?.[tieredKey];
    if (tieredPool?.length) {
      appendLog(tieredPool[Math.floor(Math.random() * tieredPool.length)], 'log-nova');
      return;
    }
    this.speak(baseCategory);
  },

  speakPlanetArrival(key) {
    const line = this.dialogue.locationArrivals?.[key];
    if (line) appendLog(line, 'log-nova');
  },

  speakDanger(key) {
    const pool = this.dialogue.dangerLines?.[key] || this.dialogue.dangerLines?.default;
    if (!pool?.length) return;
    appendLog(pool[Math.floor(Math.random() * pool.length)], 'log-nova');
  },

  startIdle() {
    clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      if (!traveling && Math.random() < 0.6) this.speakTiered('idle');
    }, 45000);
  },

  stopIdle() { clearInterval(this.idleTimer); }
};

// ================================================================
// Mission System
// ================================================================
function getActiveMission() { return MISSIONS.find(m => !m.complete) || null; }

function updateMissionIndicator() {
  missionIndicator.classList.toggle('hidden', !getActiveMission());
}

function startDwellTimer(locationKey) {
  clearTimeout(dwellTimer);
  const m = getActiveMission();
  if (!m || m.target !== locationKey) return;
  const secs = m.dwellSecs || 30;
  appendLog(`System: Mission active. Remain at ${locationKey} for ${secs}s to complete.`, 'log-mission');
  dwellTimer = setTimeout(() => {
    if (currentLocation !== locationKey) return;
    completeMission(m);
  }, secs * 1000);
}

function completeMission(m) {
  const prevCompletions = novaRel.completions;
  m.complete = true;
  novaRel.completions++;

  appendLog(`▶ MISSION COMPLETE: ${m.title}`, 'log-mission');
  appendLog(`▶ REWARD LOGGED: ${m.reward}`, 'log-mission');

  // Tier-aware mission complete line
  NovaAI.speakTiered('missionComplete');

  // Check for tier unlock — fires its own delayed message if triggered
  checkTierUnlock(prevCompletions);

  // Unlock classified file
  unlockClassifiedFile(m.rewardKey);

  // Mark the corresponding collectible as found — mission reward guarantees the item
  const MISSION_COLLECTIBLE_MAP = {
    'TORTA_LOGS':    'col_05',
    'SPECIMEN_7C':   'col_06',
    'VAULT_FRAGMENT':'col_08',
    'STORM_DATA':    'col_07',
    'ICE_CORE':      'col_10',
    'XENO_INDEX':    'col_02',
    'CRYSTAL_SHARD': 'col_09'
  };
  const colId = MISSION_COLLECTIBLE_MAP[m.rewardKey];
  if (colId) {
    const col = COLLECTIBLES.find(c => c.id === colId);
    if (col && !col.found) {
      col.found = true;
      setTimeout(() => {
        appendLog(`◆ ITEM COLLECTED: ${col.name}`, 'log-collect');
        appendLog(`  ${col.desc}`, 'log-collect');
        NovaAI.speak('collectibleFound');
      }, 1500);
    }
  }

  updateMissionIndicator();
  rebuildCurrentButtons();
  saveState();

  const next = getActiveMission();
  if (next) {
    setTimeout(() => {
      appendLog(`▶ NEW MISSION DISPATCHED: ${next.title}`, 'log-mission');
      appendLog(`  ${next.desc}`, 'log-mission');
      rebuildCurrentButtons();
    }, 4000);
  }
}

function rebuildCurrentButtons() {
  if (!currentHub) { createButtons(mainDestinations); return; }
  const config = destinationConfigs[currentHub];
  if (currentSubLocation) {
    const parent = findByKey(currentSubLocation, config.subDestinations);
    if (parent?.subDestinations) { createButtons(parent.subDestinations); return; }
  }
  if (currentLocation && currentLocation !== currentHub) {
    const dest = findByKey(currentLocation, config.subDestinations);
    if (dest?.subDestinations) { createButtons(dest.subDestinations); return; }
  }
  createButtons(config.subDestinations);
}

// ================================================================
// Collectible System
// ================================================================
function checkCollectible(locationKey) {
  const col = COLLECTIBLES.find(c => c.location === locationKey && !c.found);
  if (!col || Math.random() > 0.65) return;
  col.found = true;
  appendLog(`◆ ITEM FOUND: ${col.name}`, 'log-collect');
  appendLog(`  ${col.desc}`, 'log-collect');
  NovaAI.speak('collectibleFound');
  saveState();
}

// ================================================================
// Ambient Dialogue
// ================================================================
function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function nextAmbientMessage(key) {
  if (!ambientQueues[key]?.length) ambientQueues[key] = shuffled(ambientDialogue[key] || []);
  return ambientQueues[key].pop();
}

// Normalise a key for ambient lookup — strips BOM, trims whitespace
function normaliseAmbientKey(key) {
  if (!key) return key;
  return key.replace(/^[\uFEFF\u200B\s]+|[\s]+$/g, '');
}

function startAmbientDialogue(key, firstDelay = 8000) {
  clearAmbientTimers();
  // Try direct match first, then normalised match
  let resolvedKey = null;
  if (ambientDialogue[key]?.length) {
    resolvedKey = key;
  } else {
    const norm = normaliseAmbientKey(key);
    const match = Object.keys(ambientDialogue).find(k => normaliseAmbientKey(k) === norm);
    if (match) resolvedKey = match;
  }
  if (!resolvedKey) return;
  ambientFirstTimer = setTimeout(() => {
    if (currentLocation !== key) return;
    fireAmbientLine(resolvedKey);
  }, firstDelay);
  ambientTimer = setInterval(() => {
    if (currentLocation !== key) { clearAmbientTimers(); return; }
    fireAmbientLine(resolvedKey);
  }, AMBIENT_INTERVAL);
}

function fireAmbientLine(key) {
  const msg = nextAmbientMessage(key);
  if (!msg) return;
  appendLog(`${msg.speaker}: "${msg.line}"`, 'log-npc');
  heardLog.unshift({ speaker: msg.speaker, line: msg.line, location: key, time: new Date().toLocaleTimeString() });
  if (heardLog.length > 60) heardLog.pop();
}

function clearAmbientTimers() {
  clearTimeout(ambientFirstTimer);
  clearInterval(ambientTimer);
  ambientFirstTimer = ambientTimer = null;
}

// ================================================================
// Transmission System
// ================================================================
function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function fireTransmission() {
  if (traveling) return;
  const sources = ['ECS', 'Government', 'Corporate'];
  const source  = randomFrom(sources);
  const pool    = transmissions[source];
  if (!pool?.length) return;
  const msg = randomFrom(pool);
  const location = currentHub ? currentLocation || currentHub : 'Deep Space';
  appendLog(`[ INCOMING TRANSMISSION — ${source.toUpperCase()} ]`, 'log-transmission-header');
  appendLog(`FROM: ${msg.from}`, 'log-transmission-from');
  appendLog(msg.body, 'log-transmission-body');
  // Store in dedicated transmission log
  transmissionLog.unshift({
    source,
    from: msg.from,
    body: msg.body,
    location,
    time: new Date().toLocaleTimeString()
  });
  if (transmissionLog.length > 50) transmissionLog.pop();
  if (Math.random() < 0.33) {
    const reactions = transmissions.novaReactions?.[source];
    if (reactions?.length) {
      setTimeout(() => appendLog(randomFrom(reactions), 'log-nova'), 3500);
    }
  }
}

function scheduleNextTransmission() {
  clearTimeout(transmissionTimer);
  // 60-90 seconds — frequent enough to feel active
  const delay = 60000 + Math.random() * 30000;
  transmissionTimer = setTimeout(() => {
    fireTransmission();
    scheduleNextTransmission();
  }, delay);
}

function stopTransmissions() {
  clearTimeout(transmissionTimer);
  transmissionTimer = null;
}

// ================================================================
// Danger Events
// ================================================================
const DANGER_LOCATIONS = [
  'NewYork_Torta','AncientVault','ResearchBase_Tunnels',
  'Ruins','ExcavationPlatforms','Pacific_Abyssal',
  'ResearchBase_Core','CoreRelay','BlackSpire','ForwardRecon'
];

function maybeTriggerDanger(key) {
  if (!DANGER_LOCATIONS.includes(key)) return;
  if (Math.random() > 0.4) return;
  const delay = 12000 + Math.random() * 15000;
  setTimeout(() => {
    if (currentLocation !== key) return;
    NovaAI.speakDanger(key);
  }, delay);
}

// ================================================================
// Journal
// ================================================================
function renderJournal() {
  renderMissionsTab();
  renderHeardTab();
  renderCollectedTab();
  renderClassifiedTab();
  renderTransmissionsTab();
  missionLogOverlay.classList.remove('hidden');
}

function renderMissionsTab() {
  const el = document.getElementById('missionsList');
  el.innerHTML = '';
  // Show current Nova relationship tier at the top
  const tierBadge = document.createElement('div');
  tierBadge.className = 'tier-badge';
  tierBadge.innerHTML = `NOVA STATUS &nbsp;—&nbsp; <span class="tier-label">${getRelTier()}</span>`;
  el.appendChild(tierBadge);

  MISSIONS.forEach(m => {
    const card = document.createElement('div');
    card.className = `mission-card${m.complete ? ' complete' : ''}`;
    card.innerHTML = `
      <div class="mission-title">${m.title}</div>
      <div class="mission-status-badge">${m.complete ? '✓ COMPLETE' : '● IN PROGRESS'}</div>
      <div class="mission-desc">${m.desc}</div>
      <div class="mission-target">Target: ${m.target} — Dwell: ${m.dwellSecs}s</div>
      <div class="mission-reward">Reward: ${m.complete ? m.reward : '???'}</div>
    `;
    el.appendChild(card);
  });
}

function renderHeardTab() {
  const el = document.getElementById('heardList');
  el.innerHTML = '';
  if (!heardLog.length) { el.innerHTML = '<div class="empty-state">Nothing overheard yet. Explore and listen.</div>'; return; }
  heardLog.forEach(({ speaker, line, location, time }) => {
    const entry = document.createElement('div');
    entry.className = 'heard-entry';
    entry.innerHTML = `<div class="heard-meta">[${time}] ${location}</div>${speaker}: "${line}"`;
    el.appendChild(entry);
  });
}

function renderCollectedTab() {
  const el = document.getElementById('collectedList');
  el.innerHTML = '';
  const found = COLLECTIBLES.filter(c => c.found);
  if (!found.length) { el.innerHTML = '<div class="empty-state">No items collected yet.</div>'; return; }
  found.forEach(c => {
    const entry = document.createElement('div');
    entry.className = 'collect-entry';
    entry.innerHTML = `
      <div class="collect-name">${c.name}</div>
      <div class="collect-desc">${c.desc}</div>
      <div class="collect-where">Found at: ${c.location}</div>
    `;
    el.appendChild(entry);
  });
}

function renderClassifiedTab() {
  const el = document.getElementById('classifiedList');
  if (!el) return;
  el.innerHTML = '';
  const unlocked = CLASSIFIED_FILES.filter(f => unlockedFiles.has(f.id));
  if (!unlocked.length) {
    el.innerHTML = '<div class="empty-state">No classified files unlocked. Complete missions to access restricted data.</div>';
    return;
  }
  unlocked.forEach(f => {
    const entry = document.createElement('div');
    entry.className = 'classified-entry';
    const linesHtml = f.lines.map(l => `<div class="classified-line">${l}</div>`).join('');
    entry.innerHTML = `
      <div class="classified-title">${f.title}</div>
      <div class="classified-clearance">CLEARANCE: ${f.clearance}</div>
      <div class="classified-body">${linesHtml}</div>
    `;
    el.appendChild(entry);
  });
}

function renderTransmissionsTab() {
  const el = document.getElementById('transmissionsList');
  if (!el) return;
  el.innerHTML = '';
  if (!transmissionLog.length) {
    el.innerHTML = '<div class="empty-state">No transmissions intercepted yet.</div>';
    return;
  }
  transmissionLog.forEach(t => {
    const entry = document.createElement('div');
    entry.className = `transmission-entry transmission-${t.source.toLowerCase()}`;
    entry.innerHTML = `
      <div class="transmission-meta">
        <span class="transmission-source">${t.source.toUpperCase()}</span>
        <span class="transmission-time">[${t.time}] ${t.location}</span>
      </div>
      <div class="transmission-from">${t.from}</div>
      <div class="transmission-body">${t.body}</div>
    `;
    el.appendChild(entry);
  });
}

function initJournalTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => { t.classList.remove('active'); t.classList.add('hidden'); });
      btn.classList.add('active');
      const target = document.getElementById(`tab-${btn.dataset.tab}`);
      target.classList.remove('hidden');
      target.classList.add('active');
      if (btn.dataset.tab === 'missions')       renderMissionsTab();
      if (btn.dataset.tab === 'heard')          renderHeardTab();
      if (btn.dataset.tab === 'collected')      renderCollectedTab();
      if (btn.dataset.tab === 'classified')     renderClassifiedTab();
      if (btn.dataset.tab === 'transmissions')  renderTransmissionsTab();
    });
  });
}

// ================================================================
// Button Helpers
// ================================================================
function clearDestinations() { destList.innerHTML = '<h2>Select Destination</h2>'; }
function enableButtons() { destList.querySelectorAll('button').forEach(b => (b.disabled = false)); }

function createButtons(destinations) {
  clearDestinations();
  const active = getActiveMission();
  destinations.forEach(dest => {
    const btn = document.createElement('button');
    btn.textContent  = dest.name;
    btn.dataset.dest = dest.key;
    if (active && active.target === dest.key) {
      btn.textContent = `${dest.name} ●`;
      btn.title = 'Mission target';
    }
    destList.appendChild(btn);
    btn.addEventListener('click', () => handleDestinationClick(dest, btn));
  });
}

// ================================================================
// Navigation Helpers
// ================================================================
function findByKey(key, list) {
  if (!list) return null;
  for (const item of list) {
    if (item.key === key) return item;
    const found = findByKey(key, item.subDestinations);
    if (found) return found;
  }
  return null;
}



// ================================================================
// Click Handler
// ================================================================
function handleDestinationClick(dest, btn) {
  if (traveling) return;
  if (dest.key === 'Return') { handleReturn(); return; }

  const isMain = mainDestinations.some(d => d.key === dest.key);
  if (isMain && !currentHub) { travelMain(dest, btn); return; }

  if (currentHub) {
    const config = destinationConfigs[currentHub];
    if (config.subDestinations?.some(d => d.key === dest.key)) { travelSub(dest, btn, config); return; }
    if (currentLocation) {
      const parent = findByKey(currentLocation, config.subDestinations);
      if (parent?.subDestinations?.some(d => d.key === dest.key)) { travelSubSub(dest, btn, parent); return; }
    }
  }
}

// ================================================================
// Return
// ================================================================
function handleReturn() {
  clearAmbientTimers();
  clearTimeout(dwellTimer);
  Health.stopDrain();
  NovaAI.stopIdle();

  if (currentSubLocation) {
    const config = destinationConfigs[currentHub];
    const parent = findByKey(currentSubLocation, config.subDestinations);
    if (parent?.subDestinations) {
      appendLog(`System: Returning to ${parent.name}.`, 'log-system');
      currentLocation    = currentSubLocation;
      currentSubLocation = null;
      createButtons(parent.subDestinations);
      startAmbientDialogue(currentLocation);
      Health.startDrain(currentLocation);
      NovaAI.startIdle();
      saveState();
      return;
    }
  }

  if (currentLocation && currentLocation !== currentHub) {
    const config = destinationConfigs[currentHub];
    appendLog(`System: Returning to ${currentHub} sectors.`, 'log-system');
    currentLocation    = currentHub;
    currentSubLocation = null;
    createButtons(config.subDestinations);
    NovaAI.startIdle();
    saveState();
    return;
  }

  appendLog('System: Returning to ship. Please select a destination.', 'log-system');
  Health.shipHeal();
  currentLocation = currentHub = currentSubLocation = null;
  clearSave();
  createButtons(mainDestinations);
}

// ================================================================
// Travel Core
// ================================================================
function beginTravel(btn) {
  traveling = true;
  clearAmbientTimers();
  clearTimeout(dwellTimer);
  Health.stopDrain();
  NovaAI.stopIdle();
  destList.querySelectorAll('button').forEach(b => { b.disabled = true; b.classList.remove('selected'); });
  if (btn) btn.classList.add('selected');
}

function endTravel(loc, hub, sub = null) {
  currentLocation = loc; currentHub = hub; currentSubLocation = sub;
  traveling = false;
  novaRel.visits++;
  enableButtons();
  saveState();
}

function showOverlay(msg) {
  travelOverlay.textContent = msg;
  travelOverlay.classList.remove('hidden');
  requestAnimationFrame(() => requestAnimationFrame(() => travelOverlay.classList.add('active')));
}

function hideOverlay() {
  travelOverlay.classList.remove('active');
  setTimeout(() => travelOverlay.classList.add('hidden'), 700);
}

function onArrival(key, isMainPlanet = false, ambientDelay = 8000) {
  if (isMainPlanet) {
    NovaAI.speak('arrival');
    NovaAI.speakPlanetArrival(key);
  }
  checkCollectible(key);
  maybeTriggerDanger(key);
  Health.applyArrivalDamage(key);
  Health.startDrain(key);
  startDwellTimer(key);
  startAmbientDialogue(key, ambientDelay);
  NovaAI.startIdle();
  updateMissionIndicator();
}

// ================================================================
// Travel Functions
// ================================================================
function travelMain(dest, btn) {
  beginTravel(btn);
  NovaAI.speak('travel');
  appendLog(`System: Initiating zero-point travel to ${dest.name}...`, 'log-system');
  showOverlay(`Engaging transit to ${dest.name}...`);
  setTimeout(() => {
    hideOverlay();
    appendLog(`System: Zero-point travel complete. Welcome to ${dest.name}.`, 'log-system');
    const config = destinationConfigs[dest.key];
    if (config?.description) appendLog(config.description, 'log-system');
    endTravel(dest.key, dest.key, null);
    createButtons(config.subDestinations);
    setTimeout(() => onArrival(dest.key, true), 2500);
  }, 3000);
}

function travelSub(dest, btn, config) {
  beginTravel(btn);
  const type = dest.travelType || config.travelType || 'shuttle';
  const labels = { drone: 'Deploying drone', orbit: 'Initiating orbital alignment', rover: 'Boarding the rover', shuttle: 'Boarding the shuttle', train: 'Boarding the train' };
  const label  = labels[type] || 'Traveling';
  appendLog(`System: ${label} to ${dest.name}...`, 'log-system');
  showOverlay(`${label} to ${dest.name}...`);
  setTimeout(() => {
    hideOverlay();
    appendLog(`System: Arrived at ${dest.name}.`, 'log-system');
    if (dest.description) appendLog(dest.description, 'log-system');
    const subList = dest.subDestinations?.length
      ? dest.subDestinations
      : [{ name: 'Return to Previous', key: 'Return' }];
    endTravel(dest.key, currentHub, null);
    createButtons(subList);
    onArrival(dest.key, false, 6000);
  }, type === 'drone' ? 2000 : 3000);
}

function travelSubSub(dest, btn, parentDest) {
  beginTravel(btn);
  appendLog(`System: Traveling deeper to ${dest.name}...`, 'log-system');
  showOverlay(`Traveling deeper to ${dest.name}...`);
  setTimeout(() => {
    hideOverlay();
    appendLog(`System: Arrived at ${dest.name}.`, 'log-system');
    if (dest.description) appendLog(dest.description, 'log-system');
    const subList = dest.subDestinations?.length
      ? dest.subDestinations
      : [{ name: 'Return to Previous', key: 'Return' }];
    endTravel(dest.key, currentHub, parentDest.key);
    createButtons(subList);
    onArrival(dest.key, false, 6000);
  }, 2000);
}

// ================================================================
// Session Restore
// ================================================================
function restoreSession() {
  if (!loadState()) {
    appendLog('System: Welcome, Captain. Please select a destination.', 'log-system');
    const first = getActiveMission();
    if (first) {
      setTimeout(() => {
        appendLog(`▶ MISSION DISPATCHED: ${first.title}`, 'log-mission');
        appendLog(`  ${first.desc}`, 'log-mission');
        updateMissionIndicator();
      }, 1500);
    }
    createButtons(mainDestinations);
    return;
  }

  appendLog(`System: Session restored. Last known location: ${currentLocation}.`, 'log-system');
  updateMissionIndicator();
  Health.render();

  if (currentSubLocation) {
    const config = destinationConfigs[currentHub];
    const parent = findByKey(currentSubLocation, config.subDestinations);
    if (parent?.subDestinations) {
      createButtons(parent.subDestinations);
      startAmbientDialogue(currentLocation);
      Health.startDrain(currentLocation);
      NovaAI.startIdle();
      return;
    }
  }

  if (currentLocation && currentLocation !== currentHub) {
    const config = destinationConfigs[currentHub];
    const dest   = findByKey(currentLocation, config.subDestinations);
    if (dest?.subDestinations) {
      createButtons(dest.subDestinations);
      startAmbientDialogue(currentLocation);
      Health.startDrain(currentLocation);
      NovaAI.startIdle();
      return;
    }
  }

  createButtons(destinationConfigs[currentHub].subDestinations);
  NovaAI.startIdle();
}

function startTravelConsole() {
  journalToggle.classList.remove('hidden');
  document.getElementById('healthWidget').classList.remove('hidden');
  Health.render();
  restoreSession();
  scheduleNextTransmission();
  try { if (!localStorage.getItem(SAVE_KEY)) saveState(); } catch(_) {}
}

function wipeSaveAndRestart() {
  clearSave();
  MISSIONS.forEach(m => m.complete = false);
  COLLECTIBLES.forEach(c => c.found = false);
  unlockedFiles.clear();
  novaRel.visits = 0;
  novaRel.completions = 0;
  Health.current = Health.max;
  Health.render();
  heardLog.length = 0;
  transmissionLog.length = 0;
  Object.keys(ambientQueues).forEach(k => delete ambientQueues[k]);
  currentLocation = currentHub = currentSubLocation = null;
  appendLog('System: Save data cleared. Starting fresh.', 'log-system');
}

// ================================================================
// Extraction Sequence
// ================================================================

const EXTRACTION_CSS = `
  #extractionOverlay {
    position: fixed;
    inset: 0;
    background: #000;
    z-index: 25000;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 0;
    opacity: 0;
    transition: opacity 1.2s ease;
    font-family: 'Share Tech Mono', monospace;
  }
  #extractionOverlay.visible { opacity: 1; }
  #extractionOverlay.fade-out {
    opacity: 0;
    transition: opacity 1.8s ease;
  }
  #extractionLines {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.4rem;
    padding: 2rem;
    max-width: 600px;
    width: 100%;
  }
  .ext-system {
    font-size: 0.7rem;
    letter-spacing: 0.3rem;
    color: rgba(255,255,255,0.25);
    text-align: center;
    opacity: 0;
    transition: opacity 0.8s ease;
  }
  .ext-system.show { opacity: 1; }
  .ext-divider {
    width: 120px;
    height: 1px;
    background: rgba(255,255,255,0.1);
    opacity: 0;
    transition: opacity 0.8s ease;
  }
  .ext-divider.show { opacity: 1; }
  .ext-soldier {
    font-size: 0.88rem;
    color: rgba(255,255,255,0.9);
    text-align: center;
    opacity: 0;
    transition: opacity 0.6s ease;
    line-height: 1.6;
  }
  .ext-soldier.show { opacity: 1; }
  .ext-soldier .ext-speaker {
    font-size: 0.65rem;
    letter-spacing: 0.18rem;
    color: rgba(255,255,255,0.35);
    display: block;
    margin-bottom: 0.3rem;
  }
  .ext-nova {
    font-size: 0.82rem;
    color: rgba(141,253,141,0.7);
    text-align: center;
    opacity: 0;
    transition: opacity 1s ease;
    font-style: italic;
    margin-top: 1rem;
  }
  .ext-nova.show { opacity: 1; }
`;

const SOLDIER_LINES = [
  { speaker: 'HAZMAT TEAM ALPHA', line: 'Agent located. Vitals are weak but stable.' },
  { speaker: 'HAZMAT TEAM ALPHA', line: 'Secure the suit. Get them to the airlock. Move.' },
  { speaker: 'HAZMAT TEAM ALPHA', line: 'Command, we have the agent. Extraction in ninety seconds.' }
];

function runExtractionSequence(onComplete) {
  // Inject CSS
  const style = document.createElement('style');
  style.textContent = EXTRACTION_CSS;
  document.head.appendChild(style);

  // Build overlay — construct elements directly to avoid getElementById timing issues
  const overlay = document.createElement('div');
  overlay.id = 'extractionOverlay';
  const linesEl = document.createElement('div');
  linesEl.id = 'extractionLines';
  overlay.appendChild(linesEl);
  document.body.appendChild(overlay);

  function addEl(cls, html, delay) {
    setTimeout(() => {
      const el = document.createElement('div');
      el.className = cls;
      el.innerHTML = html;
      linesEl.appendChild(el);
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
    }, delay);
  }

  // Fade overlay in
  requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('visible')));

  // Sequence
  addEl('ext-system', 'HAZMAT RECOVERY TEAM — ECS FIELD RESPONSE', 600);
  addEl('ext-system', 'AGENT LOCATED. INITIATING EXTRACTION PROTOCOL.', 1400);
  addEl('ext-divider', '', 2200);

  SOLDIER_LINES.forEach((s, i) => {
    addEl('ext-soldier',
      `<span class="ext-speaker">${s.speaker}</span>${s.line}`,
      3000 + i * 2200
    );
  });

  // Darkness beat — longer pause after last soldier line
  const novaDelay = 3000 + SOLDIER_LINES.length * 2200 + 2800;

  // Nova wake-up line (pre-full recovery, so always Stranger-level — warm but brief)
  const novaWakeLines = [
    "Hey. You're back on the ship. The extraction team flagged your suit for repair.",
    "I have you on sensors. You're stable. Take a minute before you move.",
    "Extraction team got you out. You're aboard. Rest."
  ];
  const novaLine = novaWakeLines[Math.floor(Math.random() * novaWakeLines.length)];
  addEl('ext-nova', `Nova: ${novaLine}`, novaDelay);

  // Fade out and complete
  const totalDuration = novaDelay + 3500;
  setTimeout(() => {
    overlay.classList.add('fade-out');
    setTimeout(() => {
      overlay.remove();
      style.remove();
      onComplete();
    }, 1800);
  }, totalDuration);
}

// ================================================================
// Event Listeners
// ================================================================
window.addEventListener('DOMContentLoaded', () => {
  initJournalTabs();

  document.getElementById('proceedBtn')?.addEventListener('click', e => {
    e.preventDefault();
    startupScreen.classList.add('hidden');
    loginScreen.classList.remove('hidden');
  });

  // Power On — always run boot scroll, then reveal travel console
  document.getElementById('onBtn')?.addEventListener('click', e => {
    e.preventDefault();
    loginScreen.classList.add('hidden');
    runBootSequence(() => {
      travelScreen.classList.remove('hidden');
      if (destinationsReady && dialogueReady) {
        startTravelConsole();
      } else {
        appendLog('System: Loading navigation data...', 'log-system');
        pendingStart = true;
      }
    });
  });

  journalToggle?.addEventListener('click', renderJournal);
  document.getElementById('closeJournal')?.addEventListener('click', () => missionLogOverlay.classList.add('hidden'));

  document.getElementById('wipeSaveBtn')?.addEventListener('click', () => {
    wipeSaveAndRestart();
    startupScreen.classList.add('hidden');
    loginScreen.classList.remove('hidden');
  });

  initStartupScreen();

  window.addEventListener('beforeunload', () => {
    if (currentHub !== null) saveState();
  });
});
