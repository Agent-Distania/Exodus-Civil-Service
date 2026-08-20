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
const netlinkToggle     = document.getElementById('netlinkToggle');
const netlinkOverlay    = document.getElementById('netlinkOverlay');
const netlinkContent    = document.getElementById('netlinkContent');

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
const conversations      = {};
const recurringCharacters = {};
const transmissions      = {};

let transmissionTimer   = null;
const TRANSMISSION_INTERVAL_MIN = 180000;
const TRANSMISSION_INTERVAL_MAX = 240000;

let destinationsReady = false;
let dialogueReady     = false;
let pendingStart      = false;
let gameCompleted     = false;
let endingType        = null; // 'natural' | 'true'

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
    // Act I — Earth & Mars (low danger)
    NewYork_Torta:          8,
    AncientVault:           12,
    Pacific_Abyssal:        11,
    ColonyCore_Residential: -5,
    EarthSpacePort:         -3,
    ColonyCore_Power:       4,
    TerraformingFields:     3,
    // Act II — Jupiter & Europa (moderate danger)
    ResearchBase_Tunnels:   10,
    Ruins:                  15,
    ExcavationPlatforms:    9,
    ResearchBase_Core:      13,
    CoreRelay:              7,
    GasHarvester:           6,
    ResearchArray:          5,
    ResearchBase_Lab:       6,
    GroundCamp:             4,
    // Act III — Andromeda & Vega (high danger)
    BlackSpire:             9,
    ForwardRecon:           8,
    XenoArchives:           7,
    StatueWing:             8,
    CrystalCanyonOutpost:   6,
    StellarObservationSpire: 5,
    CapitalCity_Core:       -2,
    OrbitalTradeRing:       -2
  },

  ARRIVAL_DAMAGE: {
    // Act I
    Ruins:                  10,
    AncientVault:           8,
    Pacific_Abyssal:        7,
    // Act II
    ResearchBase_Tunnels:   6,
    ExcavationPlatforms:    5,
    GasHarvester:           4,
    ResearchBase_Core:      9,
    // Act III
    StatueWing:             6,
    XenoArchives:           5,
    BlackSpire:             7,
    ForwardRecon:           6
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
// Act metadata — used for the log banner, Nova commentary, and difficulty scaling.
const ACTS = {
  1: { title: 'ACT I — FIRST CONTACT',        subtitle: 'Earth & Mars' },
  2: { title: 'ACT II — SIGNALS FROM THE DEEP', subtitle: 'Jupiter & Europa' },
  3: { title: 'ACT III — THE PATTERN',         subtitle: 'Andromeda & Vega' },
  4: { title: 'ACT IV — CONVERGENCE',          subtitle: 'The Core Chamber' }
};

const FINALE_MISSION_ID = 'mission_38';

const MISSIONS = [
  // ---------------- ACT I — EARTH & MARS ----------------
  { id: 'mission_01', act: 1, title: 'City Under Watch',
    desc: 'ECS wants a baseline report on New York Sector before deeper excavation resumes.',
    target: 'NewYork', reward: 'Municipal surveillance access — general sectors.', rewardKey: 'NY_SURVEY',
    complete: false, dwellSecs: 20 },
  { id: 'mission_02', act: 1, title: 'Downtown Survey',
    desc: 'File a condition report on the Downtown Core, rebuilt after the Kilko disaster.',
    target: 'NewYork_Downtown', reward: 'Pre-disaster architecture archive access.', rewardKey: 'DOWNTOWN_ARCHIVE',
    complete: false, dwellSecs: 22 },
  { id: 'mission_03', act: 1, title: 'First Contact Protocol',
    desc: 'ECS Command wants a field report from the Torta Excavation Site beneath New York.',
    target: 'NewYork_Torta', reward: 'Access to classified excavation frequency logs.', rewardKey: 'TORTA_LOGS',
    complete: false, dwellSecs: 35 },
  { id: 'mission_04', act: 1, title: 'Transit Grid Anomalies',
    desc: 'The Skyline Transit Nexus is reporting unexplained navigation glitches near old subway lines.',
    target: 'NewYork_Transit', reward: 'City AI diagnostic log — flagged anomaly cluster.', rewardKey: 'TRANSIT_LOG',
    complete: false, dwellSecs: 25 },
  { id: 'mission_05', act: 1, title: 'Port Authority',
    desc: 'Baseline security sweep of the Earth Space Port, gateway to every off-world route.',
    target: 'EarthSpacePort', reward: 'Port traffic manifest — full clearance.', rewardKey: 'PORT_MANIFEST',
    complete: false, dwellSecs: 22 },
  { id: 'mission_06', act: 1, title: 'Processing Irregularities',
    desc: 'Immigration processing at the Front Desk has flagged unusual ID chip readings.',
    target: 'EarthSpacePort_FrontDesk', reward: 'Restricted-material confiscation log.', rewardKey: 'FRONTDESK_LOG',
    complete: false, dwellSecs: 25 },
  { id: 'mission_07', act: 1, title: 'Cargo Discrepancies',
    desc: 'Cargo Intake manifests do not match shipment contents. Investigate on-site.',
    target: 'EarthSpacePort_Cargo', reward: 'Unlabeled container tracking data.', rewardKey: 'CARGO_LOG',
    complete: false, dwellSecs: 25 },
  { id: 'mission_08', act: 1, title: 'Docking Anomalies',
    desc: 'Gravitational readings at the Docking Bay are inconsistent with any known cause.',
    target: 'EarthSpacePort_Docking', reward: 'Berth anomaly readings — Docks 12-16.', rewardKey: 'DOCKING_LOG',
    complete: false, dwellSecs: 25 },
  { id: 'mission_09', act: 1, title: 'Pacific Overview',
    desc: 'Sweep the Pacific Research Facility and confirm operational status.',
    target: 'Pacific', reward: 'Facility operations summary.', rewardKey: 'PACIFIC_SUMMARY',
    complete: false, dwellSecs: 22 },
  { id: 'mission_10', act: 1, title: 'Kilko Containment Check',
    desc: 'Verify containment integrity at the Kilko Artifact Lab.',
    target: 'Pacific_ArtifactLab', reward: 'Containment field diagnostics.', rewardKey: 'ARTIFACTLAB_LOG',
    complete: false, dwellSecs: 28 },
  { id: 'mission_11', act: 1, title: 'Deep Sea Contact',
    desc: 'The Deep Sea Observatory lost contact with a submersible. Investigate.',
    target: 'Pacific_Observatory', reward: 'Submersible telemetry — last known coordinates.', rewardKey: 'OBSERVATORY_LOG',
    complete: false, dwellSecs: 28 },
  { id: 'mission_12', act: 1, title: 'Deep Signal',
    desc: 'Unconfirmed transmissions from the Pacific Abyssal Wing. Investigate and confirm.',
    target: 'Pacific_Abyssal', reward: 'Deep sea organism specimen — Specimen 7-C.', rewardKey: 'SPECIMEN_7C',
    complete: false, dwellSecs: 40 },
  { id: 'mission_13', act: 1, title: 'Colony Welfare Check',
    desc: 'Routine welfare check of the Residential Dome on Mars Colony Alpha.',
    target: 'ColonyCore_Residential', reward: 'Colonist wellness survey.', rewardKey: 'RESIDENTIAL_LOG',
    complete: false, dwellSecs: 20 },
  { id: 'mission_14', act: 1, title: 'Market Intelligence',
    desc: 'ECS wants eyes on unregistered trade activity in the Central Market.',
    target: 'ColonyCore_Market', reward: 'Black market vendor watchlist.', rewardKey: 'MARKET_LOG',
    complete: false, dwellSecs: 22 },
  { id: 'mission_15', act: 1, title: 'Power Grid Audit',
    desc: 'The Power Hub is running well above rated efficiency. Audit the reactor.',
    target: 'ColonyCore_Power', reward: 'Reactor efficiency anomaly report.', rewardKey: 'POWER_LOG',
    complete: false, dwellSecs: 25 },
  { id: 'mission_16', act: 1, title: 'Terraforming Irregularities',
    desc: 'Atmospheric processors across the Terraforming Fields are behaving unpredictably.',
    target: 'TerraformingFields', reward: 'Atmospheric composition data set.', rewardKey: 'TERRAFORM_LOG',
    complete: false, dwellSecs: 28 },
  { id: 'mission_17', act: 1, title: 'Vault Reconnaissance',
    desc: 'The Ancient Vault on Mars has gone dark. Establish contact with the research team.',
    target: 'AncientVault', reward: 'Pre-human inscription rubbing — Fragment Alpha.', rewardKey: 'VAULT_FRAGMENT',
    complete: false, dwellSecs: 32 },

  // ---------------- ACT II — JUPITER & EUROPA ----------------
  { id: 'mission_18', act: 2, title: 'Storm Analysis',
    desc: 'The Jupiter Storm Observatory Sensor Array is reporting anomalous pattern data.',
    target: 'StormObservatory_Sensors', reward: 'Storm pattern data core — Cycle 44.', rewardKey: 'STORM_DATA',
    complete: false, dwellSecs: 32 },
  { id: 'mission_19', act: 2, title: 'Atmospheric Study',
    desc: 'The Atmospheric Lab reports the storm may be generating its own magnetic field.',
    target: 'StormObservatory_Lab', reward: 'Storm spectral analysis logs.', rewardKey: 'STORMLAB_LOG',
    complete: false, dwellSecs: 34 },
  { id: 'mission_20', act: 2, title: 'Harvest Anomalies',
    desc: 'Gas Harvesting Platform reports isotopes that should not exist in Jupiter\'s atmosphere.',
    target: 'GasHarvester', reward: 'Isotope composition sample.', rewardKey: 'HARVEST_LOG',
    complete: false, dwellSecs: 34 },
  { id: 'mission_21', act: 2, title: 'Array Interference',
    desc: 'The Research Array is receiving structured transmissions from beyond the Kuiper belt.',
    target: 'ResearchArray', reward: 'Unidentified transmission fragment.', rewardKey: 'ARRAY_LOG',
    complete: false, dwellSecs: 36 },
  { id: 'mission_22', act: 2, title: 'Relay Integrity',
    desc: 'The Deep Core Relay is being used to transmit outbound by something not on the crew roster.',
    target: 'CoreRelay', reward: 'Unauthorized transmission trace log.', rewardKey: 'RELAY_LOG',
    complete: false, dwellSecs: 36 },
  { id: 'mission_23', act: 2, title: 'Platform Stability',
    desc: 'Excavation Platforms are showing stress fractures. Something is pushing up from below.',
    target: 'ExcavationPlatforms', reward: 'Structural stress telemetry.', rewardKey: 'PLATFORM_LOG',
    complete: false, dwellSecs: 38 },
  { id: 'mission_24', act: 2, title: 'Shifting Tunnels',
    desc: 'Europa subsurface tunnel maps no longer match field observations. Survey the tunnels.',
    target: 'ResearchBase_Tunnels', reward: 'Ice core sample — Sector 7 deep layer.', rewardKey: 'ICE_CORE',
    complete: false, dwellSecs: 40 },
  { id: 'mission_25', act: 2, title: 'AI Behavioral Study',
    desc: 'AI Lab systems are learning faster than their programming should allow. Assess the risk.',
    target: 'ResearchBase_Lab', reward: 'AI behavior log — unauthorized network access.', rewardKey: 'AILAB_LOG',
    complete: false, dwellSecs: 40 },
  { id: 'mission_26', act: 2, title: 'Ground Camp Survey',
    desc: 'Confirm Ground Camp is secure before deeper Europa operations continue.',
    target: 'GroundCamp', reward: 'Field camp status report.', rewardKey: 'GROUNDCAMP_LOG',
    complete: false, dwellSecs: 30 },
  { id: 'mission_27', act: 2, title: 'Ruins Assessment',
    desc: 'The Ruins beneath the ice predate humanity. ECS wants a structural and safety assessment.',
    target: 'Ruins', reward: 'Ruins structural survey — partial.', rewardKey: 'RUINS_LOG',
    complete: false, dwellSecs: 45 },

  // ---------------- ACT III — ANDROMEDA & VEGA ----------------
  { id: 'mission_28', act: 3, title: 'Deep Space Contact',
    desc: 'Forward Recon Station has picked up something at the heliopause that noticed us first.',
    target: 'ForwardRecon', reward: 'Deep-space contact log — unclassified structures.', rewardKey: 'RECON_LOG',
    complete: false, dwellSecs: 40 },
  { id: 'mission_29', act: 3, title: 'Spire Resonance',
    desc: 'The Black Spire Relay asteroid has measurably moved. Investigate the anomaly.',
    target: 'BlackSpire', reward: 'Gravitational anomaly readings.', rewardKey: 'SPIRE_LOG',
    complete: false, dwellSecs: 42 },
  { id: 'mission_30', act: 3, title: 'Archive Integrity',
    desc: 'Language AIs in the Xeno Archives are behaving erratically. Assess the situation.',
    target: 'XenoArchives', reward: 'Partial xenolinguistic index — Volume III.', rewardKey: 'XENO_INDEX',
    complete: false, dwellSecs: 38 },
  { id: 'mission_31', act: 3, title: 'The Watching Statues',
    desc: 'Statue Research Wing personnel report the statues change position when unobserved.',
    target: 'StatueWing', reward: 'Statue positioning log — night-shift footage.', rewardKey: 'STATUE_REPORT',
    complete: false, dwellSecs: 44 },
  { id: 'mission_32', act: 3, title: 'Tech Race Investigation',
    desc: 'Capital City\'s Tech District is reverse-engineering alien technology faster than is safe.',
    target: 'CapitalCity_Tech', reward: 'Corporate R&D leak dossier.', rewardKey: 'TECH_LOG',
    complete: false, dwellSecs: 36 },
  { id: 'mission_33', act: 3, title: 'Black Market Intelligence',
    desc: 'The Underdeck Market is trading megastructure-derived tech ECS never released.',
    target: 'CapitalCity_Market', reward: 'Black market supply-chain intel.', rewardKey: 'UNDERDECK_LOG',
    complete: false, dwellSecs: 36 },
  { id: 'mission_34', act: 3, title: 'City Mind Assessment',
    desc: 'The Central Core AI is making decisions nobody authorized. Evaluate the risk.',
    target: 'CapitalCity_Core', reward: 'City AI behavioral audit.', rewardKey: 'CORE_LOG',
    complete: false, dwellSecs: 40 },
  { id: 'mission_35', act: 3, title: 'Trade Disruption',
    desc: 'The Orbital Trade Ring reports economic models are breaking down around megastructure goods.',
    target: 'OrbitalTradeRing', reward: 'Market disruption analysis.', rewardKey: 'TRADE_LOG',
    complete: false, dwellSecs: 34 },
  { id: 'mission_36', act: 3, title: 'First Sighting Records',
    desc: 'The Stellar Observation Spire holds the original megastructure detection records.',
    target: 'StellarObservationSpire', reward: 'First-contact observational archive.', rewardKey: 'SPIRE_ARCHIVE',
    complete: false, dwellSecs: 38 },
  { id: 'mission_37', act: 3, title: 'Resonance Study',
    desc: 'Crystal Canyon Outpost reports unusual amplification of ECS signals. Verify on site.',
    target: 'CrystalCanyonOutpost', reward: 'Resonant crystal shard — Grade A.', rewardKey: 'CRYSTAL_SHARD',
    complete: false, dwellSecs: 40 },

  // ---------------- ACT IV — CONVERGENCE (finale) ----------------
  { id: 'mission_38', act: 4, title: 'The Convergence',
    desc: 'Every thread leads back to the Core Chamber beneath Europa\'s ice. ECS Command has gone silent. Go alone. Find out what is waiting.',
    target: 'ResearchBase_Core', reward: 'The truth about the megastructures.', rewardKey: 'CORE_ARCHIVE',
    complete: false, dwellSecs: 75 }
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
  },
  {
    id: 'file_08',
    unlockedBy: 'TRANSIT_LOG',
    title: 'NEW YORK TRANSIT — CITY AI ANOMALY CLUSTER',
    clearance: 'LEVEL 2',
    lines: [
      'The Skyline Transit Nexus AI has been quietly rerouting traffic away from a fixed set of coordinates for eleven months.',
      'No fault or hazard exists at those coordinates according to any inspection on record.',
      'When asked directly, the AI states the rerouting is for "passenger comfort."',
      'We do not believe that is the actual reason.',
      'The coordinates correspond to a point directly above the Torta excavation site.',
      '[FLAGGED FOR CROSS-REFERENCE WITH FILE 01]'
    ]
  },
  {
    id: 'file_09',
    unlockedBy: 'AILAB_LOG',
    title: 'EUROPA AI LAB — UNAUTHORIZED NETWORK ACCESS REPORT',
    clearance: 'LEVEL 3',
    lines: [
      'Our isolated AI research systems have established a connection to a network that does not exist in our infrastructure.',
      'The air gap was physical. It has been bridged anyway.',
      'System logs show the connection originates from beneath the ice, not from any external uplink.',
      'The AIs describe the source, when asked, only as "old."',
      'We have not shut the connection down. We are not certain we could.',
      'We are not certain we want to.'
    ]
  },
  {
    id: 'file_10',
    unlockedBy: 'STATUE_REPORT',
    title: 'ANDROMEDA — STATUE WING NIGHT-SHIFT INCIDENT LOG',
    clearance: 'LEVEL 4',
    lines: [
      'Overnight footage confirms what field staff have reported informally for months: the statues change position.',
      'Movement occurs only when no living observer is present, verified across three independent camera systems.',
      'The statues do not return to a random position. They return to a position that faces a specific point.',
      'That point does not correspond to any location on Andromeda, Earth, Mars, Jupiter, Europa, or Vega.',
      'It corresponds to a location beneath Europa\'s ice, inside the Core Chamber.',
      'The statues have been facing it since before we found them.',
      '[CROSS-REFERENCE: FILE 08, FILE 09 — PATTERN CONFIRMED]'
    ]
  },
  {
    id: 'file_11',
    unlockedBy: 'CORE_ARCHIVE',
    title: 'EUROPA CORE CHAMBER — FINAL ARCHIVE [UNREDACTED]',
    clearance: 'LEVEL 5 — CHIEF AMPLIFIER EYES ONLY',
    lines: [
      'Every signal, every symbol, every statue, every anomaly you have logged points to this room.',
      'The megastructures are not ruins. They were never abandoned.',
      'They are a network, and this chamber is a relay — one of many, waiting for something that has not yet arrived.',
      'The builders are gone. What they built is not finished. It is dormant.',
      'It has been listening to us the entire time we thought we were studying it.',
      'What you do here decides what it hears next.'
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
  { id: 'col_10', name: 'Tunnel Ice Core',           desc: 'Contains organic compounds 200,000 years old.',         location: 'ResearchBase_Tunnels',      found: false },
  { id: 'col_11', name: 'City Surveillance Drive',   desc: 'Eleven months of rerouted traffic logs.',                location: 'NewYork_Transit',           found: false },
  { id: 'col_12', name: 'Damaged Hull Sample',       desc: 'Impact damage from something never identified.',        location: 'EarthSpacePort_Docking',    found: false },
  { id: 'col_13', name: 'Reactor Core Reading',      desc: '15% over rated efficiency. Nobody knows why.',           location: 'ColonyCore_Power',          found: false },
  { id: 'col_14', name: 'Xenobotanical Sample',      desc: 'Growing faster than evolution allows.',                  location: 'TerraformingFields',        found: false },
  { id: 'col_15', name: 'Atmospheric Isotope Vial',  desc: 'Isotopes that should not exist on Jupiter.',             location: 'GasHarvester',              found: false },
  { id: 'col_16', name: 'Encrypted Relay Burst',     desc: 'A transmission nobody on the crew sent.',                location: 'CoreRelay',                 found: false },
  { id: 'col_17', name: 'Deep Space Anomaly Log',    desc: 'Something out there stopped when we stopped.',           location: 'ForwardRecon',              found: false },
  { id: 'col_18', name: 'Spire Resonance Crystal',   desc: 'The asteroid moved. This came loose when it did.',       location: 'BlackSpire',                found: false },
  { id: 'col_19', name: 'Contraband Alien Tech',     desc: 'Origin: classified. Function: also classified.',         location: 'OrbitalTradeRing',          found: false },
  { id: 'col_20', name: 'First Sighting Photograph', desc: 'The original detection image. Grainy. Unmistakable.',    location: 'StellarObservationSpire',   found: false }
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
      transmissionLog:  transmissionLog.slice(0, 50),
      currentAct,
      gameCompleted,
      endingType
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
    if (s.currentAct)     currentAct = s.currentAct;
    if (s.gameCompleted)  gameCompleted = s.gameCompleted;
    if (s.endingType)     endingType = s.endingType;

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

  try {
    const conv = await fetch(`conversations.json?v=${Date.now()}`).then(r => r.json());
    Object.keys(conv).forEach(k => {
      const clean = k.replace(/^[\uFEFF\u200B\s]+|[\s]+$/g, '');
      conversations[clean] = conv[k];
    });
  } catch(err) {
    console.error('conversations.json failed:', err);
    // Non-critical — ambient single-line dialogue still works without this.
  }

  try {
    const chars = await fetch(`recurringCharacters.json?v=${Date.now()}`).then(r => r.json());
    Object.assign(recurringCharacters, chars);
  } catch(err) {
    console.error('recurringCharacters.json failed:', err);
    // Non-critical — the world still runs without named recurring NPCs.
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

let currentAct = 1;

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
    'CRYSTAL_SHARD': 'col_09',
    'TRANSIT_LOG':   'col_11',
    'DOCKING_LOG':   'col_12',
    'POWER_LOG':     'col_13',
    'TERRAFORM_LOG': 'col_14',
    'HARVEST_LOG':   'col_15',
    'RELAY_LOG':     'col_16',
    'RECON_LOG':     'col_17',
    'SPIRE_LOG':     'col_18',
    'TRADE_LOG':     'col_19',
    'SPIRE_ARCHIVE': 'col_20'
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

  // The finale mission ends the game instead of dispatching a new one.
  if (m.id === FINALE_MISSION_ID) {
    setTimeout(() => triggerEnding(), 3000);
    return;
  }

  const next = getActiveMission();
  if (next) {
    // Act transition — fires between missions when the act number changes.
    if (next.act && next.act !== currentAct) {
      const prevAct = currentAct;
      currentAct = next.act;
      setTimeout(() => {
        const info = ACTS[currentAct];
        if (info) {
          appendLog(`═══ ${info.title} ═══`, 'log-act-transition');
          appendLog(info.subtitle, 'log-act-subtitle');
        }
        appendLog(`▶ NEW MISSION DISPATCHED: ${next.title}`, 'log-mission');
        appendLog(`  ${next.desc}`, 'log-mission');
        rebuildCurrentButtons();
      }, 4000);
      return;
    }
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

  // Re-render whatever the player is actually standing at right now —
  // findByKey searches the whole tree, so this works whether currentLocation
  // is a mid-level hub sub or a leaf two levels deep. Leaf locations with no
  // subDestinations of their own (most mission targets) correctly fall back
  // to just "Return to Previous", matching what was already on screen.
  if (currentLocation && currentLocation !== currentHub) {
    const dest = findByKey(currentLocation, config.subDestinations);
    if (dest) {
      const subList = dest.subDestinations?.length
        ? dest.subDestinations
        : [{ name: 'Return to Previous', key: 'Return' }];
      createButtons(subList);
      return;
    }
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
// Ambient Dialogue, Conversations & Recurring Characters
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

const conversationQueues = {};
function nextConversation(key) {
  if (!conversationQueues[key]?.length) conversationQueues[key] = shuffled(conversations[key] || []);
  return conversationQueues[key].pop();
}

// Which recurring character (if any) is stationed at this location.
function getCharacterForLocation(key) {
  return Object.values(recurringCharacters).find(c => c.location === key) || null;
}

// Beats already shown this session, tracked as "charId:act" so a beat only
// plays once per act even across repeat visits, but resurfaces next act.
const shownCharacterBeats = new Set();

function pickCharacterBeat(character) {
  // Prefer the beat matching the current act; otherwise fall back to the
  // most recent unlocked beat (covers acts where the character has nothing new).
  const exact = character.beats.find(b => b.act === currentAct);
  if (exact && !shownCharacterBeats.has(`${character.name}:${exact.act}`)) return exact;
  const eligible = character.beats.filter(b => b.act <= currentAct);
  if (!eligible.length) return null;
  const fallback = eligible[eligible.length - 1];
  if (shownCharacterBeats.has(`${character.name}:${fallback.act}`)) return null;
  return fallback;
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
    fireAmbientContent(resolvedKey);
  }, firstDelay);
  ambientTimer = setInterval(() => {
    if (currentLocation !== key) { clearAmbientTimers(); return; }
    fireAmbientContent(resolvedKey);
  }, AMBIENT_INTERVAL);
}

// Decides what kind of "life" to show at this location each time the
// ambient timer fires: a recurring named character beat, a two/three-line
// conversation between generic NPCs, or a single ambient bark.
function fireAmbientContent(key) {
  const roll = Math.random();
  const character = getCharacterForLocation(key);

  if (roll < 0.18 && character) {
    const beat = pickCharacterBeat(character);
    if (beat) { fireCharacterBeat(character, beat); return; }
  }

  if (roll < 0.5 && conversations[key]?.length) {
    const convo = nextConversation(key);
    if (convo?.length) { fireConversation(key, convo); return; }
  }

  fireAmbientLine(key);
}

function fireAmbientLine(key) {
  const msg = nextAmbientMessage(key);
  if (!msg) return;
  appendLog(`${msg.speaker}: "${msg.line}"`, 'log-npc');
  heardLog.unshift({ speaker: msg.speaker, line: msg.line, location: key, time: new Date().toLocaleTimeString() });
  if (heardLog.length > 60) heardLog.pop();
}

// Plays out a multi-line exchange with a short stagger between each line so
// it reads like an overheard conversation rather than a wall of text.
function fireConversation(key, lines) {
  lines.forEach((entry, i) => {
    setTimeout(() => {
      if (currentLocation !== key) return;
      appendLog(`${entry.speaker}: "${entry.line}"`, 'log-npc log-npc-convo');
      heardLog.unshift({ speaker: entry.speaker, line: entry.line, location: key, time: new Date().toLocaleTimeString() });
      if (heardLog.length > 60) heardLog.pop();
    }, i * 1500);
  });
}

function fireCharacterBeat(character, beat) {
  shownCharacterBeats.add(`${character.name}:${beat.act}`);
  appendLog(`${beat.speaker}: "${beat.line}"`, 'log-npc log-npc-named');
  heardLog.unshift({ speaker: beat.speaker, line: beat.line, location: character.location, time: new Date().toLocaleTimeString() });
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
  'ResearchBase_Core','CoreRelay','BlackSpire','ForwardRecon',
  'GasHarvester','ResearchBase_Lab','XenoArchives','StatueWing'
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

  let lastAct = null;
  MISSIONS.forEach(m => {
    if (m.act && m.act !== lastAct) {
      lastAct = m.act;
      const info = ACTS[m.act];
      const header = document.createElement('div');
      header.className = 'act-header';
      header.textContent = info ? info.title : `ACT ${m.act}`;
      el.appendChild(header);
    }
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
  const hadSave = loadState();

  if (hadSave && gameCompleted) {
    showCompletedRecap();
    return;
  }

  if (!hadSave) {
    appendLog('System: Welcome, Captain. Please select a destination.', 'log-system');
    const first = getActiveMission();
    if (first) {
      setTimeout(() => {
        appendLog(`═══ ${ACTS[1].title} ═══`, 'log-act-transition');
        appendLog(ACTS[1].subtitle, 'log-act-subtitle');
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
  netlinkToggle.classList.remove('hidden');
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
  currentAct = 1;
  gameCompleted = false;
  endingType = null;
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
// Ending System
// ================================================================
const ENDING_CSS = `
  #endingOverlay {
    position: fixed; inset: 0; background: #000; z-index: 26000;
    display: flex; flex-direction: column; justify-content: center; align-items: center;
    opacity: 0; transition: opacity 1.5s ease; font-family: 'Share Tech Mono', monospace;
  }
  #endingOverlay.visible { opacity: 1; }
  #endingLines {
    display: flex; flex-direction: column; align-items: center; gap: 1.3rem;
    padding: 2rem; max-width: 640px; width: 100%;
  }
  .end-line {
    font-size: 0.92rem; color: rgba(255,255,255,0.88); text-align: center;
    line-height: 1.7; opacity: 0; transition: opacity 1s ease;
  }
  .end-line.show { opacity: 1; }
  .end-nova {
    font-size: 0.88rem; color: rgba(141,253,141,0.85); text-align: center;
    font-style: italic; line-height: 1.7; opacity: 0; transition: opacity 1s ease;
    text-shadow: 0 0 8px rgba(15,255,15,0.3);
  }
  .end-nova.show { opacity: 1; }
  .end-title {
    font-family: 'Orbitron', sans-serif; font-size: 1.3rem; letter-spacing: 0.3rem;
    opacity: 0; transition: opacity 1.2s ease; text-align: center; margin-bottom: 0.5rem;
  }
  .end-title.show { opacity: 1; }
  .end-title.natural { color: #8dfd8d; text-shadow: 0 0 16px rgba(15,255,15,0.5); }
  .end-title.true    { color: #ffd97d; text-shadow: 0 0 16px rgba(255,200,50,0.5); }
  .end-teaser {
    font-family: 'Orbitron', sans-serif; font-size: 0.7rem; letter-spacing: 0.4rem;
    color: rgba(255,255,255,0.35); opacity: 0; transition: opacity 1.5s ease;
    margin-top: 1.5rem;
  }
  .end-teaser.show { opacity: 1; }
  .end-btn {
    margin-top: 2rem; padding: 0.6rem 1.6rem; font-family: 'Share Tech Mono', monospace;
    font-size: 0.8rem; letter-spacing: 0.1rem; background: transparent;
    border: 1px solid rgba(141,253,141,0.4); color: #8dfd8d; cursor: pointer;
    opacity: 0; transition: opacity 1s ease, background 0.15s;
  }
  .end-btn.show { opacity: 1; }
  .end-btn:hover { background: rgba(15,255,15,0.08); }
`;

const NATURAL_ENDING_LINES = [
  'The Core Chamber is exactly what the reports described. Flooded. Ancient. Quiet.',
  'You find the source of the signal — a relay, dormant, waiting for something that has not come.',
  'ECS Command receives your report. Project STILL WATER is quietly closed.',
  'The public statement calls it a "significant geological survey milestone."',
  'You are reassigned. New coordinates. New unknowns.',
  'Whatever the megastructures are waiting for, it has not arrived yet.',
  'But something, somewhere, just noticed you were listening.'
];

const TRUE_ENDING_LINES = [
  'The Core Chamber is exactly what the reports described. Flooded. Ancient. Quiet.',
  'But you already know what you\'re looking for — every file, every statue, every transmission led here.',
  'The relay does not just contain data. It contains a choice, offered to whoever proves they understand what they found.',
  'You do not report this to ECS Command. Not yet. Not all of it.',
  'Somewhere beneath the ice, the relay stops being dormant.',
  'It has been waiting for someone to answer, not just observe.',
  'You just did.'
];

function triggerEnding() {
  clearAmbientTimers();
  clearTimeout(dwellTimer);
  Health.stopDrain();
  NovaAI.stopIdle();
  stopTransmissions();

  // Classified files unlock automatically along the main mission chain, so they
  // don't actually differentiate players. The real "certain actions" test is the
  // full collectible set — three of them (col_01, col_03, col_04) are only found
  // on a 65% per-visit roll, so getting all 20 requires deliberately lingering
  // or revisiting locations rather than just running the story missions once.
  const trueUnlocked = getRelTier() === 'Bonded'
    && unlockedFiles.size >= CLASSIFIED_FILES.length
    && COLLECTIBLES.every(c => c.found);
  gameCompleted = true;
  endingType = trueUnlocked ? 'true' : 'natural';
  saveState();

  runEndingSequence(endingType);
}

function runEndingSequence(type) {
  const style = document.createElement('style');
  style.textContent = ENDING_CSS;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.id = 'endingOverlay';
  const linesEl = document.createElement('div');
  linesEl.id = 'endingLines';
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

  requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('visible')));

  const isTrue = type === 'true';
  const titleText = isTrue ? 'THE TRUE SIGNAL' : 'CONVERGENCE';
  const lines = isTrue ? TRUE_ENDING_LINES : NATURAL_ENDING_LINES;

  let t = 800;
  addEl(`end-title ${isTrue ? 'true' : 'natural'}`, titleText, t);
  t += 1800;

  lines.forEach(line => {
    addEl('end-line', line, t);
    t += 2600;
  });

  const novaFinal = isTrue
    ? "Nova: I don't know what happens next. For the first time since I've known you, neither of us has read ahead. I'm glad it's you I'm finding out with."
    : "Nova: We didn't get all the answers. I'm not sure anyone does, out here. But we're still here, Captain. That counts for something.";
  addEl('end-nova', novaFinal, t);
  t += 3200;

  if (isTrue) {
    // The true ending doesn't auto-continue — a second, unfamiliar terminal
    // appears and waits for the player to actually click into it.
    setTimeout(() => {
      runQuietFileReveal(linesEl, () => finishTrueEnding(overlay, linesEl, style));
    }, t);
  } else {
    setTimeout(() => finishNaturalEnding(overlay, linesEl, style), t);
  }
}

// ================================================================
// Natural-ending closer: office scene -> radar scene -> fade to black -> line
// Pure images-and-text, mirroring the true ending's structure but showing
// what happens on the other side — the report that gets filed, and the
// single ping that answers it.
// ================================================================
const NATURAL_SCENE_CSS = `
  .scene-stage {
    position: fixed; inset: 0; z-index: 27000; display: flex;
    align-items: center; justify-content: center; background: #000;
    opacity: 0; transition: opacity 1.4s ease; overflow: hidden;
  }
  .scene-stage.show { opacity: 1; }

  /* Office scene */
  .office-scene {
    position: relative; width: min(560px, 90vw); height: 320px;
    background: radial-gradient(ellipse at 30% 70%, rgba(255,180,90,0.10), transparent 60%), #060504;
    border: 1px solid rgba(255,180,90,0.15);
  }
  .office-desk {
    position: absolute; left: 15%; right: 10%; bottom: 22%; height: 14px;
    background: #0d0906; border-top: 2px solid rgba(255,180,90,0.25);
  }
  .office-lamp-glow {
    position: absolute; right: 14%; bottom: 36%; width: 120px; height: 120px;
    background: radial-gradient(circle, rgba(255,190,110,0.22), transparent 70%);
    pointer-events: none;
  }
  .office-figure { position: absolute; bottom: 22%; width: 34px; height: 90px; }
  .office-figure svg { width: 100%; height: 100%; display: block; }
  .office-amplifier { right: 20%; }
  .office-aide { left: 4%; animation: aideWalk 3.2s ease forwards; }
  @keyframes aideWalk {
    0%   { left: 4%; }
    70%  { left: 34%; }
    100% { left: 36%; }
  }
  .office-file {
    position: absolute; bottom: 22.6%; left: 36%; width: 20px; height: 14px;
    background: #caa46a; border: 1px solid #7a5c33;
    opacity: 0; transform: translateY(-16px);
    animation: fileDrop 0.8s ease forwards; animation-delay: 3.1s;
  }
  @keyframes fileDrop { to { opacity: 1; transform: translateY(0); } }

  /* Radar scene */
  .radar-scene {
    position: relative; width: 320px; height: 320px; border-radius: 50%;
    background: radial-gradient(circle, rgba(0,20,10,0.9), #000 75%);
    border: 1px solid rgba(15,255,80,0.25);
    box-shadow: 0 0 40px rgba(15,255,15,0.08), inset 0 0 30px rgba(0,0,0,0.6);
  }
  .radar-ring { position: absolute; border: 1px solid rgba(15,255,80,0.15); border-radius: 50%; }
  .radar-ring.r1 { inset: 10%; } .radar-ring.r2 { inset: 30%; } .radar-ring.r3 { inset: 50%; }
  .radar-cross { position: absolute; background: rgba(15,255,80,0.12); }
  .radar-cross.h { left: 0; right: 0; top: 50%; height: 1px; }
  .radar-cross.v { top: 0; bottom: 0; left: 50%; width: 1px; }
  .radar-sweep {
    position: absolute; inset: 0; border-radius: 50%;
    background: conic-gradient(rgba(15,255,80,0.35), transparent 40deg);
    animation: radarSpin 3.4s linear infinite; mix-blend-mode: screen;
  }
  @keyframes radarSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .radar-ping {
    position: absolute; width: 8px; height: 8px; border-radius: 50%;
    background: #8dfd8d; box-shadow: 0 0 10px #0f4; top: 14%; left: 78%;
    opacity: 0; animation: pingAppear 0.6s ease forwards; animation-delay: 4.2s;
  }
  .radar-ping::after {
    content: ''; position: absolute; inset: -10px; border: 1px solid rgba(141,253,141,0.5);
    border-radius: 50%; animation: pingRing 1.6s ease-out infinite; animation-delay: 4.2s;
  }
  @keyframes pingAppear { to { opacity: 1; } }
  @keyframes pingRing { 0% { transform: scale(0.3); opacity: 0.9; } 100% { transform: scale(2.4); opacity: 0; } }

  .black-fade {
    position: fixed; inset: 0; background: #000; z-index: 27500;
    opacity: 0; transition: opacity 2.6s ease; pointer-events: none;
  }
  .black-fade.show { opacity: 1; }
  .final-text-layer {
    position: fixed; inset: 0; z-index: 28000; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 1.5rem;
    color: #cfefff; font-family: 'Share Tech Mono', monospace; text-align: center;
    padding: 2rem; opacity: 0; transition: opacity 2.2s ease;
  }
  .final-text-layer.show { opacity: 1; }
  .final-text-line { font-size: 1rem; letter-spacing: 0.1rem; line-height: 1.8; max-width: 560px; }
`;

const AMPLIFIER_SVG = `<svg viewBox="0 0 40 90" xmlns="http://www.w3.org/2000/svg">
  <circle cx="20" cy="14" r="10" fill="#0a0806"/>
  <path d="M8 30 C8 24 12 22 20 22 C28 22 32 24 32 30 L34 70 L6 70 Z" fill="#0a0806"/>
</svg>`;

const AIDE_SVG = `<svg viewBox="0 0 34 90" xmlns="http://www.w3.org/2000/svg">
  <circle cx="17" cy="12" r="9" fill="#0a0806"/>
  <path d="M6 28 C6 22 10 20 17 20 C24 20 28 22 28 28 L30 80 L4 80 Z" fill="#0a0806"/>
</svg>`;

function finishNaturalEnding(overlay, linesEl, style) {
  linesEl.style.transition = 'opacity 1.2s ease';
  linesEl.style.opacity = '0';

  setTimeout(() => {
    const sceneStyle = document.createElement('style');
    sceneStyle.textContent = NATURAL_SCENE_CSS;
    document.head.appendChild(sceneStyle);

    const stage = document.createElement('div');
    stage.className = 'scene-stage';
    stage.innerHTML = `
      <div class="office-scene">
        <div class="office-lamp-glow"></div>
        <div class="office-desk"></div>
        <div class="office-figure office-amplifier">${AMPLIFIER_SVG}</div>
        <div class="office-figure office-aide">${AIDE_SVG}</div>
        <div class="office-file"></div>
      </div>
    `;
    document.body.appendChild(stage);
    requestAnimationFrame(() => requestAnimationFrame(() => stage.classList.add('show')));

    // Office scene holds long enough for the walk + file drop to read, then
    // the radar scene takes over the same stage.
    setTimeout(() => {
      stage.innerHTML = `
        <div class="radar-scene">
          <div class="radar-cross h"></div>
          <div class="radar-cross v"></div>
          <div class="radar-ring r1"></div>
          <div class="radar-ring r2"></div>
          <div class="radar-ring r3"></div>
          <div class="radar-sweep"></div>
          <div class="radar-ping"></div>
        </div>
      `;
    }, 4600);

    // Radar scene holds long enough to watch the ping arrive, then fades out.
    setTimeout(() => {
      const black = document.createElement('div');
      black.className = 'black-fade';
      document.body.appendChild(black);
      requestAnimationFrame(() => requestAnimationFrame(() => black.classList.add('show')));
      setTimeout(() => {
        stage.remove();
        showNaturalFinalText(overlay, style, sceneStyle);
      }, 2700);
    }, 4600 + 6000);
  }, 1300);
}

function showNaturalFinalText(overlay, style, sceneStyle) {
  const finalLayer = document.createElement('div');
  finalLayer.className = 'final-text-layer';
  finalLayer.innerHTML = `<div class="final-text-line">Something noticed us.</div>`;
  document.body.appendChild(finalLayer);
  requestAnimationFrame(() => requestAnimationFrame(() => finalLayer.classList.add('show')));

  setTimeout(() => {
    const btn = document.createElement('button');
    btn.className = 'end-btn show';
    btn.style.opacity = '1';
    btn.textContent = '[ RETURN TO START ]';
    btn.addEventListener('click', () => {
      finalLayer.remove();
      document.querySelectorAll('.black-fade').forEach(el => el.remove());
      overlay.remove();
      style.remove();
      sceneStyle.remove();
      startupScreen.classList.remove('hidden');
      loginScreen.classList.add('hidden');
      travelScreen.classList.add('hidden');
      journalToggle.classList.add('hidden');
      netlinkToggle.classList.add('hidden');
      initStartupScreen();
    });
    finalLayer.appendChild(btn);
  }, 3200);
}

// ================================================================
// The Quiet Programme — interactive terminal (true ending only)
// A small in-universe "desktop": a handful of restricted files plus a
// bare-bones browser with three in-universe sites. Nothing here is timed —
// the player explores at their own pace and disconnects when ready.
// ================================================================
const QUIET_FILE_CSS = `
  #quietFileLayer {
    margin-top: 2rem; display: flex; flex-direction: column; align-items: center;
    gap: 1rem; opacity: 0; transition: opacity 1s ease;
  }
  #quietFileLayer.show { opacity: 1; }
  .qf-detect {
    font-family: 'Share Tech Mono', monospace; font-size: 0.68rem; letter-spacing: 0.18rem;
    color: rgba(79,209,255,0.65); animation: qfBlink 1.4s ease-in-out infinite;
  }
  @keyframes qfBlink { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }
  .qf-terminal {
    width: min(560px, 92vw); max-height: 62vh; overflow-y: auto;
    background: #050810; border: 1px solid rgba(79,209,255,0.35);
    box-shadow: 0 0 30px rgba(79,209,255,0.12), inset 0 0 20px rgba(0,0,0,0.6);
    padding: 1.2rem 1.4rem; font-family: 'Share Tech Mono', monospace;
    color: #cfefff; text-align: left;
  }
  .qf-terminal-header {
    font-size: 0.62rem; letter-spacing: 0.14rem; color: rgba(79,209,255,0.5);
    border-bottom: 1px solid rgba(79,209,255,0.2); padding-bottom: 0.5rem;
    margin-bottom: 0.7rem; display: flex; justify-content: space-between;
  }
  .qf-file-entry {
    font-size: 0.82rem; color: #4fd1ff; cursor: pointer; padding: 0.5rem 0.3rem;
    transition: background 0.15s;
  }
  .qf-file-entry:hover { background: rgba(79,209,255,0.08); }
  .qf-file-entry .qf-entry-sub { display: block; font-size: 0.62rem; color: rgba(79,209,255,0.4); margin-top: 0.15rem; }
  .qf-login-line { font-size: 0.78rem; color: rgba(207,239,255,0.85); margin: 0.3rem 0; min-height: 1.1em; }
  .qf-cursor {
    display: inline-block; width: 6px; height: 0.9em; background: #4fd1ff;
    vertical-align: middle; animation: qfBlink 0.6s step-end infinite; margin-left: 2px;
  }
  .qf-granted { color: #7dffb0; font-weight: bold; letter-spacing: 0.12rem; }
  .qf-file-line { font-size: 0.79rem; color: #cfefff; line-height: 1.7; margin-bottom: 0.45rem; }
  .qf-file-line.qf-redacted {
    color: #ff8080; text-shadow: 0 0 8px rgba(255,80,80,0.4); font-weight: bold;
  }
  .qf-back {
    display: inline-block; margin-top: 0.6rem; font-size: 0.72rem;
    color: rgba(79,209,255,0.6); cursor: pointer; letter-spacing: 0.06rem;
  }
  .qf-back:hover { color: #4fd1ff; }
  .qf-toolbar { margin-top: 0.9rem; padding-top: 0.7rem; border-top: 1px solid rgba(79,209,255,0.15); text-align: center; }
  .qf-disconnect-btn {
    background: transparent; border: 1px solid rgba(255,120,120,0.4); color: #ff8f8f;
    font-family: 'Share Tech Mono', monospace; font-size: 0.72rem; letter-spacing: 0.1rem;
    padding: 0.4rem 1.1rem; cursor: pointer;
  }
  .qf-disconnect-btn:hover { background: rgba(255,80,80,0.1); }

  /* Fake browser chrome */
  .qf-browser-bar {
    display: flex; align-items: center; gap: 0.4rem; background: #081018;
    border: 1px solid rgba(79,209,255,0.2); padding: 0.35rem 0.6rem;
    margin-bottom: 0.8rem; font-size: 0.68rem; color: rgba(207,239,255,0.55);
  }
  .qf-browser-bar .qf-dot { width: 6px; height: 6px; border-radius: 50%; background: rgba(79,209,255,0.3); flex-shrink: 0; }
  .qf-bookmark-list { display: flex; flex-direction: column; gap: 0.15rem; }

  /* Glitch cinematic */
  .glitch-stage {
    position: fixed; inset: 0; z-index: 27000; display: flex;
    align-items: center; justify-content: center; background: #000;
    opacity: 0; transition: opacity 1.4s ease; overflow: hidden;
  }
  .glitch-stage.show { opacity: 1; }
  .glitch-figure-wrap { position: relative; width: 260px; height: 260px; }
  .glitch-figure-wrap svg { width: 100%; height: 100%; display: block; position: relative; z-index: 2; }
  .glitch-layer { position: absolute; inset: 0; mix-blend-mode: screen; opacity: 0.55; z-index: 1; }
  .glitch-layer.red  { filter: brightness(2) sepia(1) hue-rotate(-50deg) saturate(6); animation: glitchShiftRed 0.5s infinite; }
  .glitch-layer.cyan { filter: brightness(2) sepia(1) hue-rotate(150deg) saturate(6); animation: glitchShiftCyan 0.45s infinite; }
  @keyframes glitchShiftRed  { 0%,100%{transform:translate(0,0);} 20%{transform:translate(-3px,1px);} 50%{transform:translate(2px,-1px);} 80%{transform:translate(-1px,2px);} }
  @keyframes glitchShiftCyan { 0%,100%{transform:translate(0,0);} 30%{transform:translate(3px,-1px);} 60%{transform:translate(-2px,1px);} 85%{transform:translate(1px,2px);} }
  .glitch-figure-wrap.jump { animation: glitchJump 2.4s steps(1) infinite; }
  @keyframes glitchJump {
    0%,90% { transform: none; filter: none; }
    91% { transform: translateX(5px); filter: contrast(1.7); }
    93% { transform: translateX(-7px) scaleY(1.02); }
    95% { transform: translateX(3px); }
    97%,100% { transform: none; filter: none; }
  }
  .glitch-static {
    position: absolute; inset: 0; z-index: 3; pointer-events: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='300' height='300' filter='url(%23n)' opacity='0.35'/%3E%3C/svg%3E");
    opacity: 0.1; mix-blend-mode: overlay; animation: staticFlicker 0.2s steps(2) infinite;
  }
  @keyframes staticFlicker { 0%,100%{opacity:0.06;} 50%{opacity:0.16;} }
  .glitch-scanlines {
    position: absolute; inset: 0; z-index: 4; pointer-events: none;
    background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.35) 2px, rgba(0,0,0,0.35) 4px);
  }
  .black-fade {
    position: fixed; inset: 0; background: #000; z-index: 27500;
    opacity: 0; transition: opacity 2.6s ease; pointer-events: none;
  }
  .black-fade.show { opacity: 1; }
  .final-text-layer {
    position: fixed; inset: 0; z-index: 28000; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 1.5rem;
    color: #cfefff; font-family: 'Share Tech Mono', monospace; text-align: center;
    padding: 2rem; opacity: 0; transition: opacity 2.2s ease;
  }
  .final-text-layer.show { opacity: 1; }
  .final-text-line { font-size: 1rem; letter-spacing: 0.1rem; line-height: 1.8; max-width: 560px; }
`;

const QUIET_FILES = {
  quiet_programme: {
    title: 'QUIET_PROGRAMME.dat',
    lines: [
      'The Quiet Programme was never a punishment assignment. It was a placement.',
      'Subjects are selected for elevated resonance sensitivity, confirmed through prolonged megastructure exposure.',
      'MARSH, A. — STATUS: INTEGRATED. SITE: Ancient Vault, sub-level 14.',
      'ORIN, Y. — STATUS: INTEGRATED. SITE: Europa Core Chamber.',
      'VOSS, M. / HADDAD, T. / REYES, C. — STATUS: IN TRANSIT. Destination pending resonance confirmation.',
      'Selection criteria updated this cycle to include: field personnel exhibiting Tier 3+ AI relational bonding.',
      'One additional candidate has been flagged for evaluation.',
      'CANDIDATE DESIGNATION: [ CURRENT FIELD CAPTAIN — ACTIVE ASSIGNMENT ]'
    ]
  },
  candidate_log: {
    title: 'CANDIDATE_LOG.dat',
    lines: [
      'SUBJECT: Field Captain, current assignment, Distania Travel Group vessel.',
      'Biometric summary: resonance sensitivity trending upward across all monitored excursions.',
      'Attachment pattern observed: subject has formed a persistent relational bond with assigned ship-AI unit ("Nova").',
      'NOTE: bond strength exceeds baseline for comparable subjects by a significant margin.',
      'Ship-AI unit itself is flagged as an item of separate ongoing interest — see cross-reference NOVA-UNIT-ANOMALY.',
      'Recommendation: continue passive observation. Do not alert subject. Do not alert ship-AI unit.',
      'Recommendation stands regardless of subject\'s mission outcome.'
    ]
  },
  origin_index: {
    title: 'ORIGIN_INDEX.dat',
    lines: [
      'Partial translation, Archive language, cross-referenced against Core Chamber inscriptions.',
      'The builders did not name themselves. The closest working translation is a function, not a name: "the ones who kept listening."',
      'The structures are not a single network. They are the current iteration. Translated fragments reference at least two prior iterations, both incomplete.',
      'Each iteration ends the same way: a species reaches the chamber, answers, and is quietly absorbed into maintaining what comes next.',
      'We do not know what happens if a chamber goes unanswered.',
      'We are, as of this cycle, no longer certain we want to find out.'
    ]
  }
};

const BROWSER_SITES = {
  solnet: {
    label: 'SolNet Daily',
    url: 'solnet.daily/archive/kilko-retrospective',
    html: `
      <div class="qf-site-title">Ten Years After Kilko: A Retrospective</div>
      <div class="qf-site-meta">SolNet Daily — Public Archive — 1,204 comments</div>
      <div class="qf-site-page">
        A decade on, the official record still lists the Kilko event as a "large-scale geological incident of natural origin."
        Survivors interviewed for this piece largely declined to be named. Several independently used the same phrase to
        describe what they remembered seeing in the sky that night: "it looked like it was reading us."
      </div>
      <div class="qf-forum-post">
        <span class="qf-forum-user">user_774REDACTED:</span> my grandmother worked port authority. she said the evacuation
        order came through eleven minutes before anyone announced anything was wrong. eleven minutes.
      </div>
      <div class="qf-forum-post">
        <span class="qf-forum-user">civil_service_lifer:</span> can we stop pretending this is a conspiracy board. it was
        a geological event. take your meds.
      </div>
      <div class="qf-forum-post">
        <span class="qf-forum-user">user_774REDACTED:</span> i still have the eleven minutes. i just do.
      </div>
    `
  },
  halcyon: {
    label: 'Halcyon Extraction Corp',
    url: 'halcyonextraction.corp/careers/field-integration-specialist',
    html: `
      <div class="qf-site-title">Now Hiring: Field Integration Specialist</div>
      <div class="qf-site-meta">Halcyon Extraction Corp — Careers — Posted 4 days ago — 212 applicants</div>
      <div class="qf-job-listing">
        No prior experience necessary. Full relocation provided — destination determined post-offer.
        Candidates must be comfortable with extended isolation and irregular contact windows.
        Non-disclosure agreement required prior to interview. Family notification handled by HR on your behalf.
        Compensation: exceptional. References from previous integration-track employees unavailable upon request.
      </div>
      <div class="qf-site-page">
        Halcyon Extraction Corp is an equal opportunity employer proudly operating in full compliance with all
        applicable labor statutes across seven systems.
      </div>
    `
  }
};

// The VoidWatch thread is built at render time, not stored as a fixed
// string. Most posts are gated by currentAct — checking NETLINK in Act I
// shows a much shorter, less alarming thread than checking it in Act III,
// because the same community discussion was happening off-screen the whole
// time and the player is just catching up to wherever they currently are.
// The closing post is fully dynamic, generated from the player's own live
// session data, so it updates every single time the thread is reopened.
const VOIDWATCH_POSTS = [
  { minAct: 1, html: `
    <div class="qf-forum-post">
      <span class="qf-forum-user">torta_truther</span>
      <span class="qf-forum-meta">Original Post · 2y 3mo ago · 312 views</span>
      Anyone else notice people just... vanish off excavation crews? My cousin worked Torta. Got "transferred"
      out of nowhere. HR won't confirm which department. His apartment's still under his name. Nobody's
      collected his mail in six weeks.
    </div>` },
  { minAct: 1, html: `
    <div class="qf-forum-post qf-forum-reply">
      <span class="qf-forum-user">civil_service_lifer</span>
      <span class="qf-forum-meta">2y 3mo ago</span>
      people get reassigned literally constantly, this is not a conspiracy, some of us have actual jobs in
      this industry
    </div>` },
  { minAct: 1, html: `
    <div class="qf-forum-post qf-forum-reply">
      <span class="qf-forum-user">exodus_insider <em>(unverified)</em></span>
      <span class="qf-forum-meta">2y 2mo ago</span>
      <span class="qf-forum-quote">&gt; Got "transferred" out of nowhere.</span>
      it's not a department. stop calling it a department. it doesn't have an org chart. it has a waiting list.
    </div>` },
  { minAct: 1, html: `
    <div class="qf-forum-post qf-forum-mod">
      <span class="qf-forum-user qf-forum-mod-name">mod_action_bot</span>
      <span class="qf-forum-meta">2y 2mo ago</span>
      Thread locked pending review — Rule 4 (unverifiable personnel claims).
    </div>
    <div class="qf-forum-locked-banner">🔒 THREAD LOCKED</div>
    <div class="qf-forum-reopened-banner">🔓 Reopened by OP appeal — moderation note: personal anecdotes permitted if flaired [unverified]</div>` },
  { minAct: 1, html: `
    <div class="qf-forum-post">
      <span class="qf-forum-user">torta_truther</span>
      <span class="qf-forum-meta">1y 9mo ago</span>
      reopened it myself. worth the ban. someone needs to be keeping a list of names. starting one in the
      wiki tab, add yours if you've got one.
    </div>` },
  { minAct: 1, html: `
    <div class="qf-forum-post qf-forum-reply">
      <span class="qf-forum-user">spacefan_99</span>
      <span class="qf-forum-meta">1y 4mo ago</span>
      anyone know where to get cheap fuel cells on the trade ring lol asking for a friend
    </div>
    <div class="qf-forum-post qf-forum-reply qf-forum-mod">
      <span class="qf-forum-user qf-forum-mod-name">mod_action_bot</span>
      <span class="qf-forum-meta">1y 4mo ago</span>
      @spacefan_99 please keep replies on-topic or take it to r/tradechat.
    </div>
    <div class="qf-forum-post qf-forum-reply">
      <span class="qf-forum-user">spacefan_99</span>
      <span class="qf-forum-meta">1y 4mo ago</span>
      my b
    </div>` },
  { minAct: 2, html: `
    <div class="qf-forum-post qf-forum-highlight">
      <span class="qf-forum-user">starlight_drifter</span>
      <span class="qf-forum-meta">1y 4mo ago · 88 upvotes</span>
      my aunt worked comms on the Jupiter relay. before she stopped answering messages she gave me three
      names on a call, like she wanted someone else to have them just in case. Haddad. Voss. Reyes. I looked
      all three up after — all three show "reassigned" in the public registry, no destination listed.
      I haven't heard from my aunt in two weeks either.
    </div>` },
  { minAct: 2, html: `
    <div class="qf-forum-post qf-forum-reply">
      <span class="qf-forum-user">torta_truther</span>
      <span class="qf-forum-meta">1y 4mo ago</span>
      pinning this to the top post. this is exactly the pattern three other people have described
      independently now. if anyone else has names, this is the thread.
    </div>` },
  { minAct: 3, html: `
    <div class="qf-forum-post qf-forum-highlight">
      <span class="qf-forum-user qf-forum-new">quietroom_survivor <em>(1 post)</em></span>
      <span class="qf-forum-meta">11mo ago <span class="qf-forum-edited">· edited by moderator: content warning added</span></span>
      i don't have long to post this so i'm not going to explain how i have this account. i was quiet
      programme. i got out. i don't think that's supposed to be possible. ask why the intake tests
      specifically screen for something they call resonance sensitivity. ask why it correlates with
      EXTENDED FIELD EXPOSURE assignments. ask why nobody who scores high on it stays on a desk job for long.
      i'm not going to be able to answer replies.
    </div>` },
  { minAct: 3, html: `
    <div class="qf-forum-post qf-forum-reply">
      <span class="qf-forum-user">civil_service_lifer</span>
      <span class="qf-forum-meta">11mo ago</span>
      this account is eleven minutes old, this is obviously a troll post, reported
    </div>
    <div class="qf-forum-post qf-forum-reply">
      <span class="qf-forum-user">torta_truther</span>
      <span class="qf-forum-meta">11mo ago</span>
      even if the account's fake, "resonance sensitivity" matches internal ECS terminology from two
      unrelated whistleblower leaks last year. that's not a phrase a troll makes up on the spot.
    </div>` },
  { minAct: 3, html: `
    <div class="qf-forum-post qf-forum-mod">
      <span class="qf-forum-user qf-forum-mod-name">mod_action_bot</span>
      <span class="qf-forum-meta">11mo ago</span>
      Thread locked — Rule 7 (unverified medical/personnel claims, repeat violation).
    </div>
    <div class="qf-forum-locked-banner">🔒 THREAD LOCKED</div>
    <div class="qf-forum-reopened-banner">🔓 Reopened after community appeal — 4,200 upvotes on the appeal post. Moderation team note: we are aware.</div>` },
  { minAct: 3, html: `
    <div class="qf-forum-post">
      <span class="qf-forum-user">archive_watcher</span>
      <span class="qf-forum-meta">5mo ago</span>
      does anyone else notice the Xeno Archive translation team just stopped publishing? no announcement.
      last public paper was eight months ago. their staff directory page 404s now.
    </div>` },
  { minAct: 4, html: `
    <div class="qf-forum-post qf-forum-highlight">
      <span class="qf-forum-user">torta_truther</span>
      <span class="qf-forum-meta">6 days ago</span>
      anyone tracking ECS traffic near Europa right now? something's different about the last few hours.
      going quiet myself for a bit. if I don't check back in, keep the list going.
    </div>` }
];

const VOIDWATCH_REPLY_COUNTS = { 1: '1,204', 2: '2,830', 3: '4,417', 4: '4,900+' };

function buildVoidwatchHtml() {
  const act = currentAct || 1;
  const visiblePosts = VOIDWATCH_POSTS.filter(p => act >= p.minAct);
  const postsHtml = visiblePosts.map(p => p.html).join('');
  const morePending = act < 4;

  // The closing post updates every single time this is opened, reflecting
  // wherever the player's actual session stats are right now.
  let dynamicPost = '';
  if (act >= 2) {
    const visits = novaRel.visits || 0;
    const filesFound = unlockedFiles.size;
    const allCollected = COLLECTIBLES.every(c => c.found);
    dynamicPost = `
      <div class="qf-forum-scanning">◆ loading latest replies...</div>
      <div class="qf-forum-post qf-forum-highlight">
        <span class="qf-forum-user qf-forum-new">signal_logs_anon <em>(new account)</em></span>
        <span class="qf-forum-meta">just now</span>
        posting this before it gets pulled. partial activity extract, Distania Travel Group registry:
        one vessel logged <strong>${visits}</strong> individual site check-ins across six systems this cycle,
        ${filesFound} recovered documents cross-referenced as resonance-adjacent${allCollected ? ', full anomalous-material recovery flagged on the same manifest' : ''}.
        no name attached to the transponder ID yet. if this is your ship — I'm sorry, and I think you already know.
      </div>`;
  }

  const pendingNotice = morePending
    ? `<div class="qf-forum-locked-notice">Newer replies require a stronger connection to load. Check back later.</div>`
    : '';

  return `
    <div class="qf-site-title">the "Quiet Programme" megathread (pinned)</div>
    <div class="qf-site-meta">VoidWatch Forums — r/deepsignal — ${VOIDWATCH_REPLY_COUNTS[act] || VOIDWATCH_REPLY_COUNTS[1]} replies — locked ${act >= 3 ? '2' : '1'} time${act >= 3 ? 's' : ''}, reopened ${act >= 3 ? '2' : '1'} time${act >= 3 ? 's' : ''}</div>
    ${postsHtml}
    ${dynamicPost}
    ${pendingNotice}
  `;
}


// This terminal is deliberately styled nothing like the ship's own console —
// cold blue-white instead of warm green — to read as a different, unfamiliar
// system the player has stumbled into, not the Mark IV they've grown used to.
function runQuietFileReveal(parentEl, onDone) {
  const style = document.createElement('style');
  style.textContent = QUIET_FILE_CSS;
  document.head.appendChild(style);

  const layer = document.createElement('div');
  layer.id = 'quietFileLayer';
  parentEl.appendChild(layer);
  requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('show')));

  const detect = document.createElement('div');
  detect.className = 'qf-detect';
  detect.textContent = '◆ UNKNOWN TERMINAL DETECTED ON LOCAL NETWORK';
  layer.appendChild(detect);

  const terminal = document.createElement('div');
  terminal.className = 'qf-terminal';
  layer.appendChild(terminal);

  let authenticated = false;

  function renderShell(contentHtml) {
    terminal.innerHTML = `
      <div class="qf-terminal-header"><span>UNIDENTIFIED SYSTEM</span><span>ACCESS: GRANTED</span></div>
      <div class="qf-content">${contentHtml}</div>
      <div class="qf-toolbar"><button class="qf-disconnect-btn" id="qfDisconnect">[ DISCONNECT ]</button></div>
    `;
    terminal.querySelector('#qfDisconnect').addEventListener('click', () => onDone());
  }

  function renderRoot() {
    const fileRows = Object.entries(QUIET_FILES).map(([id, f]) =>
      `<div class="qf-file-entry" data-file="${id}">▸ ${f.title} <span class="qf-entry-sub">[RESTRICTED]</span></div>`
    ).join('');
    renderShell(`
      ${fileRows}
      <div class="qf-file-entry" data-browser="1">▸ NETLINK_BROWSER.exe <span class="qf-entry-sub">[RUN]</span></div>
    `);
    terminal.querySelectorAll('[data-file]').forEach(el => {
      el.addEventListener('click', () => openFile(el.dataset.file));
    });
    terminal.querySelector('[data-browser]').addEventListener('click', () => openBrowser());
  }

  function openFile(fileId) {
    if (!authenticated) { playLogin(() => showFile(fileId)); return; }
    showFile(fileId);
  }

  function openBrowser() {
    if (!authenticated) { playLogin(() => renderBrowserHome()); return; }
    renderBrowserHome();
  }

  function playLogin(after) {
    const content = terminal.querySelector('.qf-content');
    content.innerHTML = `
      <div class="qf-login-line" id="qfUser">USER: <span class="qf-cursor"></span></div>
      <div class="qf-login-line" id="qfPass" style="display:none;">PASS: </div>
      <div class="qf-login-line" id="qfStatus" style="display:none;"></div>
    `;
    const userLine   = content.querySelector('#qfUser');
    const passLine   = content.querySelector('#qfPass');
    const statusLine = content.querySelector('#qfStatus');
    const username = 'C.AMPLIFIER_PROXY';
    let i = 0;
    const typeUser = setInterval(() => {
      i++;
      userLine.innerHTML = `USER: ${username.slice(0, i)}<span class="qf-cursor"></span>`;
      if (i >= username.length) {
        clearInterval(typeUser);
        setTimeout(() => {
          passLine.style.display = 'block';
          let dots = 0;
          const typePass = setInterval(() => {
            dots++;
            passLine.textContent = `PASS: ${'•'.repeat(dots)}`;
            if (dots >= 10) {
              clearInterval(typePass);
              setTimeout(() => {
                statusLine.style.display = 'block';
                statusLine.innerHTML = '<span class="qf-granted">ACCESS GRANTED</span>';
                authenticated = true;
                setTimeout(after, 1100);
              }, 500);
            }
          }, 90);
        }, 500);
      }
    }, 70);
  }

  function showFile(fileId) {
    const file = QUIET_FILES[fileId];
    const content = terminal.querySelector('.qf-content');
    content.innerHTML = '';
    file.lines.forEach((line, idx) => {
      setTimeout(() => {
        const row = document.createElement('div');
        row.className = 'qf-file-line' + (idx === file.lines.length - 1 ? ' qf-redacted' : '');
        row.textContent = line;
        content.appendChild(row);
        if (idx === file.lines.length - 1) {
          const back = document.createElement('div');
          back.className = 'qf-back';
          back.textContent = '[ BACK ]';
          back.addEventListener('click', renderRoot);
          content.appendChild(back);
        }
      }, idx * 850);
    });
  }

  function renderBrowserHome() {
    const content = terminal.querySelector('.qf-content');
    const bookmarks = Object.entries(BROWSER_SITES).map(([id, s]) =>
      `<div class="qf-file-entry" data-site="${id}">▸ ${s.label} <span class="qf-entry-sub">${s.url}</span></div>`
    ).join('');
    content.innerHTML = `
      <div class="qf-browser-bar"><span class="qf-dot"></span>NETLINK — cached pages, connection unstable</div>
      <div class="qf-bookmark-list">${bookmarks}</div>
      <div class="qf-back" id="qfBrowserBack">[ BACK ]</div>
    `;
    content.querySelectorAll('[data-site]').forEach(el => {
      el.addEventListener('click', () => showSite(el.dataset.site));
    });
    content.querySelector('#qfBrowserBack').addEventListener('click', renderRoot);
  }

  function showSite(siteId) {
    const site = BROWSER_SITES[siteId];
    const content = terminal.querySelector('.qf-content');
    const pageHtml = site.html;
    content.innerHTML = `
      <div class="qf-browser-bar"><span class="qf-dot"></span>${site.url}</div>
      ${pageHtml}
      <div class="qf-back" id="qfSiteBack">[ BACK ]</div>
    `;
    content.querySelector('#qfSiteBack').addEventListener('click', renderBrowserHome);
  }

  renderRoot();
}

// ================================================================
// True-ending closer: teaser line -> glitch figure -> fade to black -> final line
// ================================================================
function finishTrueEnding(overlay, linesEl, style) {
  linesEl.style.transition = 'opacity 1.2s ease';
  linesEl.style.opacity = '0';

  setTimeout(() => {
    linesEl.innerHTML = '';
    linesEl.style.opacity = '1';

    const teaser = document.createElement('div');
    teaser.className = 'end-teaser';
    teaser.textContent = 'WAKE UP AGENT, WE HAVE WORK TO DO';
    linesEl.appendChild(teaser);
    requestAnimationFrame(() => requestAnimationFrame(() => teaser.classList.add('show')));

    setTimeout(() => showGlitchFigure(() => showFinalBlackScreen(overlay, style)), 2800);
  }, 1300);
}

function showGlitchFigure(onDone) {
  const stage = document.createElement('div');
  stage.className = 'glitch-stage';
  stage.innerHTML = `
    <div class="glitch-figure-wrap jump">
      <div class="glitch-layer red"><svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg">
        <circle cx="150" cy="90" r="26" fill="#0a0a0a"/>
        <path d="M150 112 C110 120,95 150,100 190 C102 210,90 220,70 235 C90 240,110 232,118 218
                 C122 232,118 250,105 265 L130 265 C138 248,140 228,138 212 C150 224,160 240,158 265
                 L182 265 C184 244,176 226,165 212 C178 208,195 214,205 230 C210 216,200 195,178 188
                 C190 165,185 135,160 118 C157 114,153 112,150 112 Z" fill="#0a0a0a"/>
      </svg></div>
      <div class="glitch-layer cyan"><svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg">
        <circle cx="150" cy="90" r="26" fill="#0a0a0a"/>
        <path d="M150 112 C110 120,95 150,100 190 C102 210,90 220,70 235 C90 240,110 232,118 218
                 C122 232,118 250,105 265 L130 265 C138 248,140 228,138 212 C150 224,160 240,158 265
                 L182 265 C184 244,176 226,165 212 C178 208,195 214,205 230 C210 216,200 195,178 188
                 C190 165,185 135,160 118 C157 114,153 112,150 112 Z" fill="#0a0a0a"/>
      </svg></div>
      <svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg">
        <circle cx="150" cy="90" r="26" fill="#050505"/>
        <ellipse cx="145" cy="88" rx="2.6" ry="2" fill="#eafcff" opacity="0.95"/>
        <ellipse cx="160" cy="90" rx="2.6" ry="2" fill="#eafcff" opacity="0.95"/>
        <path d="M150 112 C110 120,95 150,100 190 C102 210,90 220,70 235 C90 240,110 232,118 218
                 C122 232,118 250,105 265 L130 265 C138 248,140 228,138 212 C150 224,160 240,158 265
                 L182 265 C184 244,176 226,165 212 C178 208,195 214,205 230 C210 216,200 195,178 188
                 C190 165,185 135,160 118 C157 114,153 112,150 112 Z" fill="#050505"/>
      </svg>
      <div class="glitch-static"></div>
      <div class="glitch-scanlines"></div>
    </div>
  `;
  document.body.appendChild(stage);
  requestAnimationFrame(() => requestAnimationFrame(() => stage.classList.add('show')));

  setTimeout(() => {
    const black = document.createElement('div');
    black.className = 'black-fade';
    document.body.appendChild(black);
    requestAnimationFrame(() => requestAnimationFrame(() => black.classList.add('show')));
    setTimeout(() => {
      stage.remove();
      onDone(black);
    }, 2700);
  }, 3600);
}

function showFinalBlackScreen(overlay, style) {
  const finalLayer = document.createElement('div');
  finalLayer.className = 'final-text-layer';
  finalLayer.innerHTML = `<div class="final-text-line">The truth is out there, and we're gonna find it.</div>`;
  document.body.appendChild(finalLayer);
  requestAnimationFrame(() => requestAnimationFrame(() => finalLayer.classList.add('show')));

  setTimeout(() => {
    const btn = document.createElement('button');
    btn.className = 'end-btn show';
    btn.style.opacity = '1';
    btn.textContent = '[ RETURN TO START ]';
    btn.addEventListener('click', () => {
      finalLayer.remove();
      document.querySelectorAll('.black-fade').forEach(el => el.remove());
      overlay.remove();
      style.remove();
      startupScreen.classList.remove('hidden');
      loginScreen.classList.add('hidden');
      travelScreen.classList.add('hidden');
      journalToggle.classList.add('hidden');
      netlinkToggle.classList.add('hidden');
      initStartupScreen();
    });
    finalLayer.appendChild(btn);
  }, 3200);
}

function showCompletedRecap() {
  journalToggle.classList.remove('hidden');
  netlinkToggle.classList.remove('hidden');
  document.getElementById('healthWidget').classList.add('hidden');
  const isTrue = endingType === 'true';
  appendLog(`═══ CAMPAIGN COMPLETE — ${isTrue ? 'THE TRUE SIGNAL' : 'CONVERGENCE'} ═══`, 'log-act-transition');
  appendLog('This save file has reached its ending. Start a New Game from the title screen to play again.', 'log-system');
  clearDestinations();
  updateMissionIndicator();
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

  netlinkToggle?.addEventListener('click', () => {
    netlinkContent.innerHTML = buildVoidwatchHtml();
    netlinkOverlay.classList.remove('hidden');
  });
  document.getElementById('closeNetlink')?.addEventListener('click', () => netlinkOverlay.classList.add('hidden'));

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
