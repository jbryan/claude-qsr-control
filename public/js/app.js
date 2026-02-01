import { requestMIDIAccess, getDevices, queryDeviceIdentity, scanForQSDevice, sendModeSelect, sendBankSelect, sendProgramChange, sendMidiProgramSelect, sendGlobalParam, requestPatchName, requestGlobalData, requestUserProgram, unpackQSData } from './midi.js';
import { getPresetName, getAllPresets } from './presets.js';
import { getKeyboardSampleName, getDrumSampleName } from './samples.js';

const deviceSelect = document.getElementById('device-select');
const identifyBtn = document.getElementById('identify-btn');
const statusArea = document.getElementById('status');
const lcdLine1 = document.getElementById('lcd-line1');
const lcdLine2 = document.getElementById('lcd-line2');
const rescanBtn = document.getElementById('rescan-btn');
const advancedBtn = document.getElementById('advanced-btn');
const advancedPanel = document.getElementById('advanced-panel');
const progBtn = document.getElementById('prog-btn');
const mixBtn = document.getElementById('mix-btn');
const bankSelect = document.getElementById('bank-select');
const patchLabel = document.getElementById('patch-label');
const patchDisplay = document.getElementById('patch-display');
const patchPrev = document.getElementById('patch-prev');
const patchNext = document.getElementById('patch-next');
const searchBtn = document.getElementById('search-btn');
const searchModal = document.getElementById('search-modal');
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
const filterProg = document.getElementById('filter-prog');
const filterMix = document.getElementById('filter-mix');
const globalsBtn = document.getElementById('globals-btn');
const globalsModal = document.getElementById('globals-modal');
const globalsBody = document.getElementById('globals-body');
const globalsClose = document.getElementById('globals-close');
const progInfoBtn = document.getElementById('prog-info-btn');
const progInfoModal = document.getElementById('prog-info-modal');
const progInfoBody = document.getElementById('prog-info-body');
const progInfoClose = document.getElementById('prog-info-close');

const MIDI_CHANNEL = 0;

let devices = [];
let activeDevice = null;
let currentMode = 'prog';
let currentBank = 0;
let currentPatch = 0;
let currentPatchName = '';
let nameFetchId = 0;

const allPresets = getAllPresets();
let searchHighlight = -1;

const STORAGE_KEY = 'qsr-control-state';

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mode: currentMode,
      bank: currentBank,
      patch: currentPatch,
    }));
  } catch {
    // localStorage unavailable — ignore
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if ((s.mode === 'prog' || s.mode === 'mix') &&
        typeof s.bank === 'number' && typeof s.patch === 'number') {
      return s;
    }
  } catch {
    // Corrupt or unavailable — ignore
  }
  return null;
}

function setStatus(message, type = 'info') {
  lcdLine1.textContent = message;
  lcdLine2.innerHTML = '';
  statusArea.className = `lcd ${type}`;
}

function updateLCD() {
  const id = activeDevice.identity;
  lcdLine1.textContent = `${id.manufacturer} ${id.model} — fw ${id.softwareVersion}`;
  const modeName = currentMode === 'prog' ? 'PROG' : 'MIX';
  const bankNames = ['User', 'Preset 1', 'Preset 2', 'Preset 3', 'GenMIDI'];
  const bankName = bankNames[currentBank] || `Bank ${currentBank}`;
  const patchNum = String(currentPatch).padStart(3, '0');
  lcdLine2.innerHTML =
    `<span class="lcd-col-mode">${modeName}</span>` +
    `<span class="lcd-col-bank">${bankName}</span>` +
    `<span class="lcd-col-patch">${patchNum}</span>` +
    `<span class="lcd-col-name">${currentPatchName}</span>`;
  statusArea.className = 'lcd success';
}

async function fetchPatchName() {
  const id = ++nameFetchId;
  currentPatchName = '';
  updateLCD();
  if (!activeDevice) return;

  // Non-User banks have static preset names — no SysEx needed.
  const preset = getPresetName(currentMode, currentBank, currentPatch);
  if (preset) {
    if (id !== nameFetchId) return;
    currentPatchName = preset;
    updateLCD();
    return;
  }

  try {
    const name = await requestPatchName(
      activeDevice.device.output,
      activeDevice.device.input,
      currentMode,
      currentBank,
      currentPatch,
    );
    if (id !== nameFetchId) return;
    currentPatchName = name;
    updateLCD();
  } catch {
    // Timeout or unknown bank — leave name blank
  }
}

function updateModeButtons() {
  if (!activeDevice) {
    progBtn.disabled = true;
    mixBtn.disabled = true;
    progBtn.classList.remove('active');
    mixBtn.classList.remove('active');
    return;
  }
  progBtn.disabled = false;
  mixBtn.disabled = false;
  progBtn.classList.toggle('active', currentMode === 'prog');
  mixBtn.classList.toggle('active', currentMode === 'mix');
}


function maxPatch() {
  return currentMode === 'prog' ? 127 : 99;
}

function updateProgInfoVisibility() {
  const show = activeDevice && currentMode === 'prog' && currentBank === 0;
  progInfoBtn.classList.toggle('hidden', !show);
}

function updateBankPatchUI() {
  const connected = activeDevice !== null;
  bankSelect.disabled = !connected;
  patchPrev.disabled = !connected;
  patchNext.disabled = !connected;
  searchBtn.disabled = !connected;
  globalsBtn.disabled = !connected;
  patchLabel.textContent = currentMode === 'prog' ? 'Program' : 'Mix';
  bankSelect.value = currentBank;
  patchDisplay.textContent = String(currentPatch).padStart(3, '0');
  updateProgInfoVisibility();
}

function sendBankAndPatch() {
  const out = activeDevice.device.output;
  sendBankSelect(out, MIDI_CHANNEL, currentBank);
  sendProgramChange(out, MIDI_CHANNEL, currentPatch);
}

function selectBank(bank) {
  currentBank = bank;
  currentPatch = 0;
  updateBankPatchUI();
  sendBankAndPatch();
  fetchPatchName();
  saveState();
}

function selectPatch(patch) {
  const max = maxPatch();
  if (patch < 0) patch = max;
  if (patch > max) patch = 0;
  currentPatch = patch;
  updateBankPatchUI();
  sendBankAndPatch();
  fetchPatchName();
  saveState();
}

function activateMode(mode) {
  const out = activeDevice.device.output;
  const modeValue = mode === 'prog' ? 0 : 1;
  // In Program mode: "On" (1) makes PC select programs.
  // In Mix mode: "Channel 1" (2) makes PC on ch1 select mixes.
  const progSelect = mode === 'prog' ? 1 : 2;
  sendModeSelect(out, modeValue);
  sendMidiProgramSelect(out, progSelect);
  currentMode = mode;
  currentPatch = 0;
  updateModeButtons();
  updateBankPatchUI();
  sendBankAndPatch();
  fetchPatchName();
  saveState();
}

function restoreOrDefaultState() {
  const saved = loadState();
  const mode = saved ? saved.mode : 'prog';
  const modeValue = mode === 'prog' ? 0 : 1;
  const progSelect = mode === 'prog' ? 1 : 2;
  const out = activeDevice.device.output;
  sendModeSelect(out, modeValue);
  sendMidiProgramSelect(out, progSelect);
  currentMode = mode;
  currentBank = saved ? saved.bank : 0;
  currentPatch = saved ? saved.patch : 0;
  updateModeButtons();
  updateBankPatchUI();
  sendBankAndPatch();
  fetchPatchName();
}

function populateDevices() {
  devices = getDevices();
  deviceSelect.innerHTML = '';

  if (devices.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'No MIDI devices found';
    opt.disabled = true;
    deviceSelect.appendChild(opt);
    identifyBtn.disabled = true;
    return;
  }

  devices.forEach((device, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = device.name;
    deviceSelect.appendChild(opt);
  });

  identifyBtn.disabled = false;
}

async function autoScan() {
  devices = getDevices();
  populateDevices();

  if (devices.length === 0) {
    setStatus('No MIDI devices found', 'error');
    rescanBtn.disabled = true;
    return;
  }

  rescanBtn.disabled = true;
  setStatus('Scanning devices...', 'info');

  const result = await scanForQSDevice(devices);

  if (result) {
    activeDevice = result;
    const matchIndex = devices.indexOf(result.device);
    if (matchIndex !== -1) {
      deviceSelect.value = matchIndex;
    }
    // Disable General MIDI (func=0, page=0, pot=1, value=0) so that
    // CC#0 bank select works and mode switching behaves correctly.
    sendGlobalParam(activeDevice.device.output, 0, 0, 1, 0);
    restoreOrDefaultState();
  } else {
    activeDevice = null;
    updateModeButtons();
    updateBankPatchUI();
    setStatus('No QS device found', 'error');
  }

  rescanBtn.disabled = false;
}

async function handleIdentify() {
  const index = deviceSelect.value;
  const device = devices[index];
  if (!device) {
    setStatus('No device selected', 'error');
    return;
  }

  identifyBtn.disabled = true;
  setStatus('Querying device identity...', 'info');

  try {
    const identity = await queryDeviceIdentity(device.output, device.input);
    activeDevice = { device, identity };
    sendGlobalParam(activeDevice.device.output, 0, 0, 1, 0); // GM off
    restoreOrDefaultState();
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    identifyBtn.disabled = false;
  }
}

async function init() {
  try {
    const access = await requestMIDIAccess();
    await autoScan();

    access.addEventListener('statechange', () => {
      autoScan();
    });
  } catch (err) {
    setStatus(err.message, 'error');
    rescanBtn.disabled = true;
  }
}

progBtn.addEventListener('click', () => {
  if (activeDevice) activateMode('prog');
});
mixBtn.addEventListener('click', () => {
  if (activeDevice) activateMode('mix');
});
bankSelect.addEventListener('change', () => {
  if (activeDevice) selectBank(Number(bankSelect.value));
});
patchPrev.addEventListener('click', () => {
  if (activeDevice) selectPatch(currentPatch - 1);
});
patchNext.addEventListener('click', () => {
  if (activeDevice) selectPatch(currentPatch + 1);
});
rescanBtn.addEventListener('click', () => autoScan());
advancedBtn.addEventListener('click', () => {
  advancedPanel.classList.toggle('hidden');
});
identifyBtn.addEventListener('click', handleIdentify);

// --- Search ---

function openSearch() {
  searchModal.classList.remove('hidden');
  searchInput.value = '';
  searchHighlight = -1;
  renderSearchResults('');
  searchInput.focus();
}

function closeSearch() {
  searchModal.classList.add('hidden');
}

function renderSearchResults(query) {
  searchResults.innerHTML = '';
  searchHighlight = -1;
  const lower = query.toLowerCase();
  const showProg = filterProg.checked;
  const showMix = filterMix.checked;
  const matches = allPresets.filter(p => {
    if (p.mode === 'prog' && !showProg) return false;
    if (p.mode === 'mix' && !showMix) return false;
    if (lower && !p.name.toLowerCase().includes(lower)) return false;
    return true;
  });
  const bankNames = ['', 'Preset 1', 'Preset 2', 'Preset 3', 'GenMIDI'];
  let lastGroup = '';
  for (const p of matches) {
    const modeName = p.mode === 'prog' ? 'PROG' : 'MIX';
    const bankName = bankNames[p.bank] || `Bank ${p.bank}`;
    const group = `${modeName} — ${bankName}`;
    if (group !== lastGroup) {
      lastGroup = group;
      const header = document.createElement('li');
      header.className = 'search-group-header';
      header.textContent = group;
      searchResults.appendChild(header);
    }
    const patchNum = String(p.patch).padStart(3, '0');
    const li = document.createElement('li');
    li.className = 'search-result-item';
    li.innerHTML =
      `<span class="search-result-name">${escapeHTML(p.name)}</span>` +
      `<span class="search-result-meta">#${patchNum}</span>`;
    li.addEventListener('click', () => selectSearchResult(p));
    searchResults.appendChild(li);
  }
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function selectSearchResult(p) {
  closeSearch();
  if (!activeDevice) return;
  if (p.mode !== currentMode) {
    activateMode(p.mode);
  }
  if (p.bank !== currentBank) {
    currentBank = p.bank;
  }
  currentPatch = p.patch;
  updateBankPatchUI();
  sendBankAndPatch();
  fetchPatchName();
  saveState();
}

function updateSearchHighlight() {
  const items = searchResults.querySelectorAll('.search-result-item');
  items.forEach((el, i) => {
    el.classList.toggle('active', i === searchHighlight);
  });
  if (searchHighlight >= 0 && items[searchHighlight]) {
    items[searchHighlight].scrollIntoView({ block: 'nearest' });
  }
}

searchBtn.addEventListener('click', openSearch);

function refreshSearch() {
  renderSearchResults(searchInput.value.trim());
}

searchInput.addEventListener('input', refreshSearch);
filterProg.addEventListener('change', refreshSearch);
filterMix.addEventListener('change', refreshSearch);

searchInput.addEventListener('keydown', (e) => {
  const items = searchResults.querySelectorAll('.search-result-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (items.length) {
      searchHighlight = (searchHighlight + 1) % items.length;
      updateSearchHighlight();
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (items.length) {
      searchHighlight = searchHighlight <= 0 ? items.length - 1 : searchHighlight - 1;
      updateSearchHighlight();
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (searchHighlight >= 0 && items[searchHighlight]) {
      items[searchHighlight].click();
    }
  } else if (e.key === 'Escape') {
    closeSearch();
  }
});

searchModal.addEventListener('click', (e) => {
  if (e.target === searchModal) closeSearch();
});

// --- Globals dialog ---

// Byte indices match the QSR Global Data Format (qs678syx.htm).
// Bytes 0 and 14 are spares and are omitted.
const GLOBAL_PARAMS = [
  { byte: 1,  name: 'Pitch Transpose', signed: true, format: v => `${v > 0 ? '+' : ''}${v}`, edit: { min: -12, max: 12, func: 0, page: 0, pot: 2 } },
  { byte: 2,  name: 'Pitch Fine Tune', signed: true, format: v => `${v > 0 ? '+' : ''}${v}`, edit: { min: -99, max: 99, func: 0, page: 0, pot: 3 } },
  { byte: 3,  name: 'Keyboard Scaling', format: v => String(v) },
  { byte: 4,  name: 'Keyboard Curve', format: v => ['Linear', 'Piano 1', 'Piano 2'][v] || String(v) },
  { byte: 5,  name: 'Keyboard Transpose', signed: true, format: v => `${v > 0 ? '+' : ''}${v}` },
  { byte: 6,  name: 'Keyboard Mode', format: v => {
    const modes = ['Normal', 'Split R', 'Split L', 'Split RL',
      'Layer', 'Layer R', 'Layer L', 'Layer RL',
      'W-Split R', 'W-Split L', 'W-Split RL',
      'W-Layer', 'W-Layer R', 'W-Layer L', 'W-Layer RL',
      '3-Split R', '3-Split L', '3-Split RL'];
    return modes[v] || String(v);
  }},
  { byte: 7,  name: 'Controller A', format: v => `CC ${v}`, edit: { min: 0, max: 120, func: 0, page: 2, pot: 0 } },
  { byte: 8,  name: 'Controller B', format: v => `CC ${v}`, edit: { min: 0, max: 120, func: 0, page: 2, pot: 1 } },
  { byte: 9,  name: 'Controller C', format: v => `CC ${v}`, edit: { min: 0, max: 120, func: 0, page: 2, pot: 2 } },
  { byte: 10, name: 'Controller D', format: v => `CC ${v}`, edit: { min: 0, max: 120, func: 0, page: 2, pot: 3 } },
  { byte: 11, name: 'Pedal 1 Controller', format: v => `CC ${v}`, edit: { min: 0, max: 120, func: 0, page: 4, pot: 0 } },
  { byte: 12, name: 'Pedal 2 Controller', format: v => `CC ${v}`, edit: { min: 0, max: 120, func: 0, page: 4, pot: 2 } },
  { byte: 13, name: 'MIDI Program Select', format: v => {
    if (v === 0) return 'Off';
    if (v === 1) return 'On';
    return `Channel ${v - 1}`;
  }, edit: { type: 'select', func: 0, page: 5, pot: 0,
    options: [{ value: 0, label: 'Off' }, { value: 1, label: 'On' },
      ...Array.from({ length: 16 }, (_, i) => ({ value: i + 2, label: `Channel ${i + 1}` }))] }},
  { byte: 15, name: 'Clock', format: v => ['Int 48kHz', 'Int 44.1kHz', 'Ext 48kHz', 'Ext 44.1kHz'][v] || String(v) },
  { byte: 16, name: 'Mix Group Channel', format: v => v === 0 ? 'Off' : String(v),
    edit: { type: 'select', func: 0, page: 6, pot: 0,
      options: [{ value: 0, label: 'Off' },
        ...Array.from({ length: 16 }, (_, i) => ({ value: i + 1, label: String(i + 1) }))] }},
  { byte: 17, name: 'General MIDI', format: v => v ? 'On' : 'Off',
    edit: { type: 'checkbox', func: 0, page: 0, pot: 1 } },
  { byte: 18, name: 'A-D Controller Reset', format: v => v ? 'On' : 'Off' },
  { byte: 19, name: 'A-D Controller Mode', format: v => ['Preset', 'User 1', 'User 2'][v] || String(v) },
];

function parseSignedByte(b) {
  return b > 127 ? b - 256 : b;
}

function renderGlobalParams(unpacked) {
  let html = '<table class="globals-table"><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>';
  for (const def of GLOBAL_PARAMS) {
    const raw = unpacked[def.byte];
    const val = def.signed ? parseSignedByte(raw) : raw;
    let valueCell;
    if (!def.edit) {
      valueCell = def.format(val);
    } else if (def.edit.type === 'select') {
      const opts = def.edit.options.map(o =>
        `<option value="${o.value}"${o.value === val ? ' selected' : ''}>${o.label}</option>`
      ).join('');
      valueCell = `<select class="global-edit" data-byte="${def.byte}">${opts}</select>`;
    } else if (def.edit.type === 'checkbox') {
      valueCell = `<input type="checkbox" class="global-edit" data-byte="${def.byte}"${val ? ' checked' : ''}>`;
    } else {
      const { min, max } = def.edit;
      valueCell = `<input type="number" class="global-edit" data-byte="${def.byte}" min="${min}" max="${max}" value="${val}">`;
    }
    html += `<tr><td>${def.name}</td><td>${valueCell}</td></tr>`;
  }
  html += '</tbody></table>';
  globalsBody.innerHTML = html;

  globalsBody.querySelectorAll('.global-edit').forEach(el => {
    el.addEventListener('change', () => {
      if (!activeDevice) return;
      const byteIdx = Number(el.dataset.byte);
      const def = GLOBAL_PARAMS.find(d => d.byte === byteIdx);
      if (!def || !def.edit) return;
      let val;
      if (def.edit.type === 'checkbox') {
        val = el.checked ? 1 : 0;
      } else if (def.edit.type === 'select') {
        val = Number(el.value);
      } else {
        val = Number(el.value);
        val = Math.max(def.edit.min, Math.min(def.edit.max, val));
        el.value = val;
      }
      const midiVal = val < 0 ? val + 256 : val;
      sendGlobalParam(activeDevice.device.output, def.edit.func, def.edit.page, def.edit.pot, midiVal);
    });
  });
}

async function openGlobals() {
  globalsModal.classList.remove('hidden');
  globalsBody.innerHTML = '<p class="globals-loading">Requesting global data...</p>';
  if (!activeDevice) return;
  try {
    const response = await requestGlobalData(
      activeDevice.device.output,
      activeDevice.device.input,
    );
    const packed = response.slice(7, response.length - 1);
    const unpacked = unpackQSData(packed);
    renderGlobalParams(unpacked);
  } catch {
    globalsBody.innerHTML = '<p class="globals-loading">Failed to read global data.</p>';
  }
}

function closeGlobals() {
  globalsModal.classList.add('hidden');
}

globalsBtn.addEventListener('click', openGlobals);
globalsClose.addEventListener('click', closeGlobals);
globalsModal.addEventListener('click', (e) => {
  if (e.target === globalsModal) closeGlobals();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !globalsModal.classList.contains('hidden')) {
    closeGlobals();
  }
});

// --- Program Info dialog ---

function extractBits(bytes, bitOffset, numBits) {
  let val = 0;
  for (let i = 0; i < numBits; i++) {
    const byteIdx = (bitOffset + i) >> 3;
    const bitIdx = (bitOffset + i) & 7;
    if (bytes[byteIdx] & (1 << bitIdx)) val |= (1 << i);
  }
  return val;
}

function extractProgName(unpacked) {
  let name = '';
  for (let i = 0; i < 10; i++) {
    name += String.fromCharCode(extractBits(unpacked, 8 + i * 7, 7) + 32);
  }
  return name.trim();
}

const PAN_LABELS = ['Left 3', 'Left 2', 'Left 1', 'Center', 'Right 1', 'Right 2', 'Right 3'];
const OUTPUT_LABELS = ['Main', 'Aux', 'Off'];
const EFFECT_BUS_LABELS = ['Bus 1', 'Bus 2', 'Bus 3', 'Bus 4'];
const PORTAMENTO_LABELS = ['Off', 'Legato', 'On'];
const KEY_MODE_LABELS = ['Mono', 'Poly', 'Poly Porta'];
const LFO_WAVE_LABELS = ['Triangle', 'Sine', 'Square', 'Saw Up', 'Saw Down', 'Random', 'Noise'];
const LFO_TRIG_LABELS = ['Off', 'Mono', 'Poly', 'Key Mono'];
const ENV_TRIG_LABELS = ['Normal', 'Freerun', 'Reset', 'Reset Freerun'];
const VEL_CURVE_LABELS = ['Linear', 'Curve 1', 'Curve 2', 'Curve 3', 'Curve 4', 'Curve 5', 'Curve 6', 'Curve 7', 'Curve 8', 'Curve 9', 'Curve 10', 'Curve 11', 'Curve 12'];

const MOD_SOURCES = [
  'Pitch Wheel', 'Mod Wheel', 'Pressure', 'Pedal 1', 'Pedal 2',
  'Controller A', 'Controller B', 'Controller C', 'Controller D',
  'Mono Pressure', 'MIDI Volume', 'MIDI Pan', 'MIDI Expression',
  'Note #', 'Velocity', 'Portamento Mod', 'LFO 1', 'LFO 2', 'LFO 3',
  'Env 1', 'Env 2', 'Env 3', 'Ramp 1', 'Ramp 2', 'Tracking'
];

const MOD_DESTS = [
  'Pitch', 'Pitch S2', 'Pitch S3', 'Pitch S4',
  'Filter', 'Filter S2', 'Filter S3', 'Filter S4',
  'Amp', 'Amp S2', 'Amp S3', 'Amp S4',
  'Effect Send', 'Pan', 'LFO1 Rate', 'LFO1 Depth',
  'LFO2 Rate', 'LFO2 Depth', 'LFO3 Rate', 'LFO3 Depth',
  'Env1 Attack', 'Env1 Decay', 'Env1 Release',
  'Env2 Attack', 'Env2 Decay', 'Env2 Release',
  'Env3 Attack', 'Env3 Decay', 'Env3 Release',
  'Portamento Rate', 'Sample Start', 'Sample Loop'
];

function fmtSigned(offset) {
  return v => { const s = v + offset; return s > 0 ? `+${s}` : String(s); };
}
function fmtLookup(arr) {
  return v => arr[v] !== undefined ? arr[v] : String(v);
}
function fmtBool(on, off) {
  return v => v ? on : off;
}
function fmtNote(v) {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  return `${names[v % 12]}${Math.floor(v / 12) - 2} (${v})`;
}

// Keyboard sound parameters — bitAddr is the LSB bit position from the spec
// (byte * 8 + bit), relative to start of the sound section.
const KEYBOARD_SOUND_PARAMS = [
  // Sample
  { name: 'Sample Group', bits: 6, bitAddr: 1, offset: 0, section: 'Sample' },
  { name: 'Sample Number', bits: 7, bitAddr: 7, offset: 0, section: 'Sample' },
  // Level
  { name: 'Volume', bits: 7, bitAddr: 14, offset: 0, section: 'Level' },
  { name: 'Pan', bits: 3, bitAddr: 21, offset: 0, section: 'Level', format: fmtLookup(PAN_LABELS) },
  { name: 'Output', bits: 2, bitAddr: 24, offset: 0, section: 'Level', format: fmtLookup(OUTPUT_LABELS) },
  { name: 'Effect Level', bits: 7, bitAddr: 26, offset: 0, section: 'Level' },
  { name: 'Effect Bus', bits: 2, bitAddr: 33, offset: 0, section: 'Level', format: fmtLookup(EFFECT_BUS_LABELS) },
  // Pitch
  { name: 'Semitone', bits: 6, bitAddr: 35, offset: -24, section: 'Pitch', format: fmtSigned(-24) },
  { name: 'Detune', bits: 8, bitAddr: 41, offset: -99, section: 'Pitch', format: fmtSigned(-99) },
  { name: 'Detune Type', bits: 1, bitAddr: 49, offset: 0, section: 'Pitch', format: fmtLookup(['Normal', 'Equal Temper']) },
  { name: 'Pitch Wheel Mod', bits: 4, bitAddr: 50, offset: 0, section: 'Pitch' },
  { name: 'Aftertouch Mod', bits: 8, bitAddr: 54, offset: -99, section: 'Pitch', format: fmtSigned(-99) },
  { name: 'LFO Mod', bits: 8, bitAddr: 62, offset: -99, section: 'Pitch', format: fmtSigned(-99) },
  { name: 'Env Mod', bits: 8, bitAddr: 70, offset: -99, section: 'Pitch', format: fmtSigned(-99) },
  { name: 'Portamento Mode', bits: 2, bitAddr: 78, offset: 0, section: 'Pitch', format: fmtLookup(PORTAMENTO_LABELS) },
  { name: 'Portamento Rate', bits: 7, bitAddr: 80, offset: 0, section: 'Pitch' },
  { name: 'Key Mode', bits: 2, bitAddr: 87, offset: 0, section: 'Pitch', format: fmtLookup(KEY_MODE_LABELS) },
  // Filter
  { name: 'Frequency', bits: 7, bitAddr: 89, offset: 0, section: 'Filter' },
  { name: 'Keyboard Track', bits: 1, bitAddr: 96, offset: 0, section: 'Filter', format: fmtBool('On', 'Off') },
  { name: 'Velocity Mod', bits: 8, bitAddr: 97, offset: -99, section: 'Filter', format: fmtSigned(-99) },
  { name: 'Pitch Wheel Mod', bits: 8, bitAddr: 105, offset: -99, section: 'Filter', format: fmtSigned(-99) },
  { name: 'Aftertouch Mod', bits: 8, bitAddr: 113, offset: -99, section: 'Filter', format: fmtSigned(-99) },
  { name: 'LFO Mod', bits: 8, bitAddr: 121, offset: -99, section: 'Filter', format: fmtSigned(-99) },
  { name: 'Env Mod', bits: 8, bitAddr: 129, offset: -99, section: 'Filter', format: fmtSigned(-99) },
  // Amp
  { name: 'Velocity Curve', bits: 4, bitAddr: 137, offset: 0, section: 'Amp', format: fmtLookup(VEL_CURVE_LABELS) },
  { name: 'Aftertouch Mod', bits: 8, bitAddr: 141, offset: -99, section: 'Amp', format: fmtSigned(-99) },
  { name: 'LFO Mod', bits: 8, bitAddr: 149, offset: -99, section: 'Amp', format: fmtSigned(-99) },
  // Note Range
  { name: 'Low Note', bits: 7, bitAddr: 157, offset: 0, section: 'Note Range', format: fmtNote },
  { name: 'High Note', bits: 7, bitAddr: 164, offset: 0, section: 'Note Range', format: fmtNote },
  { name: 'Overlap', bits: 7, bitAddr: 171, offset: 0, section: 'Note Range' },
  // Mod Routings 1-6
  ...Array.from({ length: 6 }, (_, m) => {
    const base = 178 + m * 19;
    return [
      { name: 'Source', bits: 5, bitAddr: base, offset: 0, section: `Mod ${m + 1}`, format: fmtLookup(MOD_SOURCES) },
      { name: 'Destination', bits: 5, bitAddr: base + 5, offset: 0, section: `Mod ${m + 1}`, format: fmtLookup(MOD_DESTS) },
      { name: 'Amplitude', bits: 8, bitAddr: base + 10, offset: -99, section: `Mod ${m + 1}`, format: fmtSigned(-99) },
      { name: 'Gate', bits: 1, bitAddr: base + 18, offset: 0, section: `Mod ${m + 1}`, format: fmtBool('On', 'Off') },
    ];
  }).flat(),
  // Pitch LFO
  { name: 'Waveform', bits: 3, bitAddr: 292, offset: 0, section: 'Pitch LFO', format: fmtLookup(LFO_WAVE_LABELS) },
  { name: 'Speed', bits: 7, bitAddr: 295, offset: 0, section: 'Pitch LFO' },
  { name: 'Delay', bits: 7, bitAddr: 302, offset: 0, section: 'Pitch LFO' },
  { name: 'Trigger', bits: 2, bitAddr: 309, offset: 0, section: 'Pitch LFO', format: fmtLookup(LFO_TRIG_LABELS) },
  { name: 'Level', bits: 7, bitAddr: 311, offset: 0, section: 'Pitch LFO' },
  { name: 'Mod Wheel Mod', bits: 8, bitAddr: 318, offset: -99, section: 'Pitch LFO', format: fmtSigned(-99) },
  { name: 'Aftertouch Mod', bits: 8, bitAddr: 326, offset: -99, section: 'Pitch LFO', format: fmtSigned(-99) },
  // Filter LFO
  { name: 'Waveform', bits: 3, bitAddr: 334, offset: 0, section: 'Filter LFO', format: fmtLookup(LFO_WAVE_LABELS) },
  { name: 'Speed', bits: 7, bitAddr: 337, offset: 0, section: 'Filter LFO' },
  { name: 'Delay', bits: 7, bitAddr: 344, offset: 0, section: 'Filter LFO' },
  { name: 'Trigger', bits: 2, bitAddr: 351, offset: 0, section: 'Filter LFO', format: fmtLookup(LFO_TRIG_LABELS) },
  { name: 'Level', bits: 7, bitAddr: 353, offset: 0, section: 'Filter LFO' },
  { name: 'Mod Wheel Mod', bits: 8, bitAddr: 360, offset: -99, section: 'Filter LFO', format: fmtSigned(-99) },
  { name: 'Aftertouch Mod', bits: 8, bitAddr: 368, offset: -99, section: 'Filter LFO', format: fmtSigned(-99) },
  // Amp LFO
  { name: 'Waveform', bits: 3, bitAddr: 376, offset: 0, section: 'Amp LFO', format: fmtLookup(LFO_WAVE_LABELS) },
  { name: 'Speed', bits: 7, bitAddr: 379, offset: 0, section: 'Amp LFO' },
  { name: 'Delay', bits: 7, bitAddr: 386, offset: 0, section: 'Amp LFO' },
  { name: 'Trigger', bits: 2, bitAddr: 393, offset: 0, section: 'Amp LFO', format: fmtLookup(LFO_TRIG_LABELS) },
  { name: 'Level', bits: 7, bitAddr: 395, offset: 0, section: 'Amp LFO' },
  { name: 'Mod Wheel Mod', bits: 8, bitAddr: 402, offset: -99, section: 'Amp LFO', format: fmtSigned(-99) },
  { name: 'Aftertouch Mod', bits: 8, bitAddr: 410, offset: -99, section: 'Amp LFO', format: fmtSigned(-99) },
  // Pitch Envelope
  { name: 'Attack', bits: 7, bitAddr: 418, offset: 0, section: 'Pitch Env' },
  { name: 'Decay', bits: 7, bitAddr: 425, offset: 0, section: 'Pitch Env' },
  { name: 'Sustain', bits: 7, bitAddr: 432, offset: 0, section: 'Pitch Env' },
  { name: 'Release', bits: 7, bitAddr: 439, offset: 0, section: 'Pitch Env' },
  { name: 'Delay', bits: 7, bitAddr: 446, offset: 0, section: 'Pitch Env' },
  { name: 'Sustain Decay', bits: 7, bitAddr: 453, offset: 0, section: 'Pitch Env' },
  { name: 'Trigger Type', bits: 2, bitAddr: 460, offset: 0, section: 'Pitch Env', format: fmtLookup(ENV_TRIG_LABELS) },
  { name: 'Time Track', bits: 1, bitAddr: 462, offset: 0, section: 'Pitch Env', format: fmtBool('On', 'Off') },
  { name: 'Sustain Pedal', bits: 1, bitAddr: 463, offset: 0, section: 'Pitch Env', format: fmtBool('On', 'Off') },
  { name: 'Level', bits: 7, bitAddr: 464, offset: 0, section: 'Pitch Env' },
  { name: 'Velocity Mod', bits: 8, bitAddr: 471, offset: -99, section: 'Pitch Env', format: fmtSigned(-99) },
  // Filter Envelope
  { name: 'Attack', bits: 7, bitAddr: 479, offset: 0, section: 'Filter Env' },
  { name: 'Decay', bits: 7, bitAddr: 486, offset: 0, section: 'Filter Env' },
  { name: 'Sustain', bits: 7, bitAddr: 493, offset: 0, section: 'Filter Env' },
  { name: 'Release', bits: 7, bitAddr: 500, offset: 0, section: 'Filter Env' },
  { name: 'Delay', bits: 7, bitAddr: 507, offset: 0, section: 'Filter Env' },
  { name: 'Sustain Decay', bits: 7, bitAddr: 514, offset: 0, section: 'Filter Env' },
  { name: 'Trigger Type', bits: 2, bitAddr: 521, offset: 0, section: 'Filter Env', format: fmtLookup(ENV_TRIG_LABELS) },
  { name: 'Time Track', bits: 1, bitAddr: 523, offset: 0, section: 'Filter Env', format: fmtBool('On', 'Off') },
  { name: 'Sustain Pedal', bits: 1, bitAddr: 524, offset: 0, section: 'Filter Env', format: fmtBool('On', 'Off') },
  { name: 'Level', bits: 7, bitAddr: 525, offset: 0, section: 'Filter Env' },
  { name: 'Velocity Mod', bits: 8, bitAddr: 532, offset: -99, section: 'Filter Env', format: fmtSigned(-99) },
  // Amp Envelope
  { name: 'Attack', bits: 7, bitAddr: 540, offset: 0, section: 'Amp Env' },
  { name: 'Decay', bits: 7, bitAddr: 547, offset: 0, section: 'Amp Env' },
  { name: 'Sustain', bits: 7, bitAddr: 554, offset: 0, section: 'Amp Env' },
  { name: 'Release', bits: 7, bitAddr: 561, offset: 0, section: 'Amp Env' },
  { name: 'Delay', bits: 7, bitAddr: 568, offset: 0, section: 'Amp Env' },
  { name: 'Sustain Decay', bits: 7, bitAddr: 575, offset: 0, section: 'Amp Env' },
  { name: 'Trigger Type', bits: 2, bitAddr: 582, offset: 0, section: 'Amp Env', format: fmtLookup(ENV_TRIG_LABELS) },
  { name: 'Time Track', bits: 1, bitAddr: 584, offset: 0, section: 'Amp Env', format: fmtBool('On', 'Off') },
  { name: 'Sustain Pedal', bits: 1, bitAddr: 585, offset: 0, section: 'Amp Env', format: fmtBool('On', 'Off') },
  { name: 'Level', bits: 7, bitAddr: 586, offset: 0, section: 'Amp Env' },
  // Tracking Generator
  { name: 'Input', bits: 5, bitAddr: 593, offset: 0, section: 'Tracking', format: fmtLookup(MOD_SOURCES.slice(0, 23)) },
  ...Array.from({ length: 11 }, (_, i) => ({
    name: `Point ${i}`, bits: 7, bitAddr: 598 + i * 7, offset: 0, section: 'Tracking',
  })),
];

const DRUM_PAN_LABELS = ['Left 3', 'Left 2', 'Left 1', 'Center', 'Right 1', 'Right 2', 'Right 3'];

const DRUM_PARAMS = [
  { name: 'Sample Group', bits: 4, bitAddr: 0, offset: 0 },
  { name: 'Sample Number', bits: 7, bitAddr: 4, offset: 0 },
  { name: 'Volume', bits: 5, bitAddr: 11, offset: 0 },
  { name: 'Pan', bits: 3, bitAddr: 16, offset: 0, format: fmtLookup(DRUM_PAN_LABELS) },
  { name: 'Output', bits: 2, bitAddr: 19, offset: 0, format: fmtLookup(OUTPUT_LABELS) },
  { name: 'Effect Level', bits: 6, bitAddr: 21, offset: 0 },
  { name: 'Effect Bus', bits: 2, bitAddr: 27, offset: 0, format: fmtLookup(EFFECT_BUS_LABELS) },
  { name: 'Pitch', bits: 7, bitAddr: 29, offset: -48, format: fmtSigned(-48) },
  { name: 'Pitch Vel Mod', bits: 3, bitAddr: 36, offset: 0 },
  { name: 'Filter Vel Mod', bits: 2, bitAddr: 39, offset: 0 },
  { name: 'Velocity Curve', bits: 4, bitAddr: 41, offset: 0, format: fmtLookup(VEL_CURVE_LABELS) },
  { name: 'Note Number', bits: 7, bitAddr: 45, offset: 0, format: fmtNote },
  { name: 'Amp Env Decay', bits: 7, bitAddr: 52, offset: 0 },
  { name: 'Mute Group', bits: 2, bitAddr: 59, offset: 0 },
  { name: 'Note Range', bits: 2, bitAddr: 61, offset: 0 },
];

const ROM_ID_LABELS = ['QS+/S4+', 'QS', 'Reserved', 'Reserved'];

function renderSectionBlock(label, rowsHtml) {
  return `<div class="prog-info-section-block"><table class="globals-table"><tbody>` +
    `<tr class="prog-info-subsection"><td colspan="2">${escapeHTML(label)}</td></tr>` +
    rowsHtml +
    `</tbody></table></div>`;
}

function renderKeyboardSound(unpacked, baseBitOff) {
  const sampleGroup = extractBits(unpacked, baseBitOff + 1, 6);
  const sampleNum = extractBits(unpacked, baseBitOff + 7, 7);
  const sampleName = getKeyboardSampleName(sampleGroup, sampleNum);

  let html = renderSectionBlock('Sample',
    `<tr><td>Sample</td><td>${escapeHTML(sampleName)}</td></tr>`);

  let currentSection = '';
  let rows = '';
  for (const p of KEYBOARD_SOUND_PARAMS) {
    if (p.section === 'Sample') continue;
    if (p.section !== currentSection) {
      if (currentSection) {
        html += renderSectionBlock(currentSection, rows);
      }
      currentSection = p.section;
      rows = '';
    }
    const raw = extractBits(unpacked, baseBitOff + p.bitAddr, p.bits);
    const val = p.format ? p.format(raw) : (p.offset ? String(raw + p.offset) : String(raw));
    rows += `<tr><td>${escapeHTML(p.name)}</td><td>${escapeHTML(String(val))}</td></tr>`;
  }
  if (currentSection) {
    html += renderSectionBlock(currentSection, rows);
  }
  return html;
}

function renderDrumSound(unpacked, baseBitOff) {
  let html = '';
  const drumBaseBit = baseBitOff + 8;
  for (let d = 0; d < 10; d++) {
    const dBit = drumBaseBit + d * 72;
    const drumGroup = extractBits(unpacked, dBit + 0, 4);
    const drumNum = extractBits(unpacked, dBit + 4, 7);
    const drumName = getDrumSampleName(drumGroup, drumNum);
    let rows = '';
    for (const p of DRUM_PARAMS) {
      if (p.name === 'Sample Group' || p.name === 'Sample Number') continue;
      const raw = extractBits(unpacked, dBit + p.bitAddr, p.bits);
      const val = p.format ? p.format(raw) : (p.offset ? String(raw + p.offset) : String(raw));
      rows += `<tr><td>${escapeHTML(p.name)}</td><td>${escapeHTML(String(val))}</td></tr>`;
    }
    html += renderSectionBlock(`Drum ${d + 1} — ${drumName}`, rows);
  }
  return html;
}

function renderProgInfo(unpacked) {
  const progName = extractProgName(unpacked);
  const romId = extractBits(unpacked, 78, 2);

  // Common section
  let html = '<table class="globals-table"><tbody>';
  html += `<tr><td>Program Name</td><td>${escapeHTML(progName)}</td></tr>`;
  html += `<tr><td>ROM ID</td><td>${ROM_ID_LABELS[romId] || romId}</td></tr>`;
  html += '</tbody></table>';

  // Build sound metadata
  const soundBases = [10, 95, 180, 265];
  const sounds = soundBases.map((baseByteOff, s) => {
    const baseBitOff = baseByteOff * 8;
    const isDrum = extractBits(unpacked, baseBitOff, 1);
    let enabled;
    if (isDrum) {
      enabled = extractBits(unpacked, baseBitOff + 81 * 8, 1);
    } else {
      enabled = extractBits(unpacked, baseBitOff + 84 * 8 + 3, 1);
    }
    return { index: s, baseBitOff, isDrum, enabled };
  });

  // Tab bar
  html += '<div class="prog-info-tabs">';
  for (const snd of sounds) {
    const label = `Sound ${snd.index + 1}`;
    const active = snd.index === 0 ? ' active' : '';
    const disabled = !snd.enabled ? ' disabled' : '';
    html += `<button class="prog-info-tab${active}" data-tab="${snd.index}"${disabled}>${label}</button>`;
  }
  html += '</div>';

  // Tab panels
  for (const snd of sounds) {
    const active = snd.index === 0 ? ' active' : '';
    html += `<div class="prog-info-panel${active}" data-panel="${snd.index}">`;
    if (!snd.enabled) {
      const modeLabel = snd.isDrum ? 'Drum' : 'Keyboard';
      html += `<p class="globals-loading">${modeLabel} — Disabled</p>`;
    } else {
      html += '<div class="prog-info-sections">';
      if (snd.isDrum) {
        html += renderDrumSound(unpacked, snd.baseBitOff);
      } else {
        html += renderKeyboardSound(unpacked, snd.baseBitOff);
      }
      html += '</div>';
    }
    html += '</div>';
  }

  progInfoBody.innerHTML = html;

  // Wire up tab switching
  progInfoBody.querySelectorAll('.prog-info-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      progInfoBody.querySelector('.prog-info-tab.active')?.classList.remove('active');
      progInfoBody.querySelector('.prog-info-panel.active')?.classList.remove('active');
      tab.classList.add('active');
      progInfoBody.querySelector(`.prog-info-panel[data-panel="${tab.dataset.tab}"]`)?.classList.add('active');
    });
  });
}

async function openProgInfo() {
  progInfoModal.classList.remove('hidden');
  progInfoBody.innerHTML = '<p class="globals-loading">Requesting program data...</p>';
  if (!activeDevice) return;
  try {
    const response = await requestUserProgram(
      activeDevice.device.output,
      activeDevice.device.input,
      currentPatch,
    );
    const packed = response.slice(7, response.length - 1);
    const unpacked = unpackQSData(packed);
    renderProgInfo(unpacked);
  } catch {
    progInfoBody.innerHTML = '<p class="globals-loading">Failed to read program data.</p>';
  }
}

function closeProgInfo() {
  progInfoModal.classList.add('hidden');
}

progInfoBtn.addEventListener('click', openProgInfo);
progInfoClose.addEventListener('click', closeProgInfo);
progInfoModal.addEventListener('click', (e) => {
  if (e.target === progInfoModal) closeProgInfo();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !progInfoModal.classList.contains('hidden')) {
    closeProgInfo();
  }
});

init();
