import { requestMIDIAccess, getDevices, queryDeviceIdentity, scanForQSDevice, sendModeSelect, sendBankSelect, sendProgramChange, sendMidiProgramSelect, sendGlobalParam, requestGlobalData, unpackQSData } from './midi.js';
import { getPresetName, getAllPresets } from './presets.js';
import { getKeyboardSampleName, getDrumSampleName } from './samples.js';
import { getNestedField, Program, Mix, readProgram, readMix } from './models.js';
import { putProgram, putMix, getAllNames, hasData } from './store.js';

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
const mixInfoModal = document.getElementById('mix-info-modal');
const mixInfoBody = document.getElementById('mix-info-body');
const mixInfoClose = document.getElementById('mix-info-close');
const syxOpenBtn = document.getElementById('syx-open-btn');
const syxFileInput = document.getElementById('syx-file-input');
const syxViewerModal = document.getElementById('syx-viewer-modal');
const syxViewerBody = document.getElementById('syx-viewer-body');
const syxViewerClose = document.getElementById('syx-viewer-close');
const syxSendBtn = document.getElementById('syx-send-btn');
const refreshBtn = document.getElementById('refresh-btn');

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
let userBankCache = null;

async function loadUserBankCache() {
  userBankCache = await getAllNames();
}

// Migration: discard old localStorage name-only cache
try { localStorage.removeItem('qsr-user-banks'); } catch { /* ignore */ }

function getUserBankPresets() {
  if (!userBankCache) return [];
  const results = [];
  for (const p of userBankCache.programs) {
    if (p.name) results.push({ mode: 'prog', bank: 0, patch: p.number, name: p.name });
  }
  for (const m of userBankCache.mixes) {
    if (m.name) results.push({ mode: 'mix', bank: 0, patch: m.number, name: m.name });
  }
  return results;
}

async function refreshUserBanks() {
  if (!activeDevice) return;
  refreshBtn.disabled = true;
  const total = 228;

  for (let i = 0; i < 128; i++) {
    lcdLine1.textContent = `Refreshing ${i + 1}/${total}...`;
    try {
      const program = await readProgram(
        activeDevice.device.output,
        activeDevice.device.input,
        i,
      );
      await putProgram(i, program);
    } catch {
      // Skip failed reads
    }
  }

  for (let i = 0; i < 100; i++) {
    lcdLine1.textContent = `Refreshing ${128 + i + 1}/${total}...`;
    try {
      const mix = await readMix(
        activeDevice.device.output,
        activeDevice.device.input,
        i,
      );
      await putMix(i, mix);
    } catch {
      // Skip failed reads
    }
  }

  await loadUserBankCache();
  refreshBtn.disabled = false;
  if (activeDevice) {
    updateLCD();
  }
}

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

  // User bank: fetch full dump, cache to IndexedDB, and extract name from model.
  if (currentBank !== 0) return;
  try {
    if (currentMode === 'prog') {
      const program = await readProgram(
        activeDevice.device.output,
        activeDevice.device.input,
        currentPatch,
      );
      if (id !== nameFetchId) return;
      currentPatchName = program.name;
      updateLCD();
      await putProgram(currentPatch, program);
      await loadUserBankCache();
    } else {
      const mix = await readMix(
        activeDevice.device.output,
        activeDevice.device.input,
        currentPatch,
      );
      if (id !== nameFetchId) return;
      currentPatchName = mix.name;
      updateLCD();
      await putMix(currentPatch, mix);
      await loadUserBankCache();
    }
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
  const show = activeDevice && ((currentMode === 'prog' && currentBank === 0) || currentMode === 'mix');
  progInfoBtn.classList.toggle('hidden', !show);
}

function updateBankPatchUI() {
  const connected = activeDevice !== null;
  bankSelect.disabled = !connected;
  patchPrev.disabled = !connected;
  patchNext.disabled = !connected;
  searchBtn.disabled = !connected;
  globalsBtn.disabled = !connected;
  refreshBtn.disabled = !connected;
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
    await loadUserBankCache();
    if (!(await hasData())) refreshUserBanks();
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
    await loadUserBankCache();
    if (!(await hasData())) refreshUserBanks();
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
refreshBtn.addEventListener('click', () => refreshUserBanks());
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
  const combined = [...getUserBankPresets(), ...allPresets];
  const matches = combined.filter(p => {
    if (p.mode === 'prog' && !showProg) return false;
    if (p.mode === 'mix' && !showMix) return false;
    if (lower && !p.name.toLowerCase().includes(lower)) return false;
    return true;
  });
  const bankNames = ['User', 'Preset 1', 'Preset 2', 'Preset 3', 'GenMIDI'];
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

const KEYBOARD_SOUND_PARAMS = [
  // Sample
  { name: 'Sample Group', field: 'sample.group', offset: 0, section: 'Sample' },
  { name: 'Sample Number', field: 'sample.number', offset: 0, section: 'Sample' },
  // Level
  { name: 'Volume', field: 'level.volume', offset: 0, section: 'Level' },
  { name: 'Pan', field: 'level.pan', offset: 0, section: 'Level', format: fmtLookup(PAN_LABELS) },
  { name: 'Output', field: 'level.output', offset: 0, section: 'Level', format: fmtLookup(OUTPUT_LABELS) },
  { name: 'Effect Level', field: 'level.effectLevel', offset: 0, section: 'Level' },
  { name: 'Effect Bus', field: 'level.effectBus', offset: 0, section: 'Level', format: fmtLookup(EFFECT_BUS_LABELS) },
  // Pitch
  { name: 'Semitone', field: 'pitch.semitone', offset: -24, section: 'Pitch', format: fmtSigned(-24) },
  { name: 'Detune', field: 'pitch.detune', offset: -99, section: 'Pitch', format: fmtSigned(-99) },
  { name: 'Detune Type', field: 'pitch.detuneType', offset: 0, section: 'Pitch', format: fmtLookup(['Normal', 'Equal Temper']) },
  { name: 'Pitch Wheel Mod', field: 'pitch.pitchWheelMod', offset: 0, section: 'Pitch' },
  { name: 'Aftertouch Mod', field: 'pitch.aftertouchMod', offset: -99, section: 'Pitch', format: fmtSigned(-99) },
  { name: 'LFO Mod', field: 'pitch.lfoMod', offset: -99, section: 'Pitch', format: fmtSigned(-99) },
  { name: 'Env Mod', field: 'pitch.envMod', offset: -99, section: 'Pitch', format: fmtSigned(-99) },
  { name: 'Portamento Mode', field: 'pitch.portamentoMode', offset: 0, section: 'Pitch', format: fmtLookup(PORTAMENTO_LABELS) },
  { name: 'Portamento Rate', field: 'pitch.portamentoRate', offset: 0, section: 'Pitch' },
  { name: 'Key Mode', field: 'pitch.keyMode', offset: 0, section: 'Pitch', format: fmtLookup(KEY_MODE_LABELS) },
  // Filter
  { name: 'Frequency', field: 'filter.frequency', offset: 0, section: 'Filter' },
  { name: 'Keyboard Track', field: 'filter.keyboardTrack', offset: 0, section: 'Filter', format: fmtBool('On', 'Off') },
  { name: 'Velocity Mod', field: 'filter.velocityMod', offset: -99, section: 'Filter', format: fmtSigned(-99) },
  { name: 'Pitch Wheel Mod', field: 'filter.pitchWheelMod', offset: -99, section: 'Filter', format: fmtSigned(-99) },
  { name: 'Aftertouch Mod', field: 'filter.aftertouchMod', offset: -99, section: 'Filter', format: fmtSigned(-99) },
  { name: 'LFO Mod', field: 'filter.lfoMod', offset: -99, section: 'Filter', format: fmtSigned(-99) },
  { name: 'Env Mod', field: 'filter.envMod', offset: -99, section: 'Filter', format: fmtSigned(-99) },
  // Amp
  { name: 'Velocity Curve', field: 'amp.velocityCurve', offset: 0, section: 'Amp', format: fmtLookup(VEL_CURVE_LABELS) },
  { name: 'Aftertouch Mod', field: 'amp.aftertouchMod', offset: -99, section: 'Amp', format: fmtSigned(-99) },
  { name: 'LFO Mod', field: 'amp.lfoMod', offset: -99, section: 'Amp', format: fmtSigned(-99) },
  // Note Range
  { name: 'Low Note', field: 'noteRange.lowNote', offset: 0, section: 'Note Range', format: fmtNote },
  { name: 'High Note', field: 'noteRange.highNote', offset: 0, section: 'Note Range', format: fmtNote },
  { name: 'Overlap', field: 'noteRange.overlap', offset: 0, section: 'Note Range' },
  // Mod Routings 1-6
  ...Array.from({ length: 6 }, (_, m) => [
    { name: 'Source', field: `mods.${m}.source`, offset: 0, section: `Mod ${m + 1}`, format: fmtLookup(MOD_SOURCES) },
    { name: 'Destination', field: `mods.${m}.destination`, offset: 0, section: `Mod ${m + 1}`, format: fmtLookup(MOD_DESTS) },
    { name: 'Amplitude', field: `mods.${m}.amplitude`, offset: -99, section: `Mod ${m + 1}`, format: fmtSigned(-99) },
    { name: 'Gate', field: `mods.${m}.gate`, offset: 0, section: `Mod ${m + 1}`, format: fmtBool('On', 'Off') },
  ]).flat(),
  // Pitch LFO
  { name: 'Waveform', field: 'pitchLfo.waveform', offset: 0, section: 'Pitch LFO', format: fmtLookup(LFO_WAVE_LABELS) },
  { name: 'Speed', field: 'pitchLfo.speed', offset: 0, section: 'Pitch LFO' },
  { name: 'Delay', field: 'pitchLfo.delay', offset: 0, section: 'Pitch LFO' },
  { name: 'Trigger', field: 'pitchLfo.trigger', offset: 0, section: 'Pitch LFO', format: fmtLookup(LFO_TRIG_LABELS) },
  { name: 'Level', field: 'pitchLfo.level', offset: 0, section: 'Pitch LFO' },
  { name: 'Mod Wheel Mod', field: 'pitchLfo.modWheelMod', offset: -99, section: 'Pitch LFO', format: fmtSigned(-99) },
  { name: 'Aftertouch Mod', field: 'pitchLfo.aftertouchMod', offset: -99, section: 'Pitch LFO', format: fmtSigned(-99) },
  // Filter LFO
  { name: 'Waveform', field: 'filterLfo.waveform', offset: 0, section: 'Filter LFO', format: fmtLookup(LFO_WAVE_LABELS) },
  { name: 'Speed', field: 'filterLfo.speed', offset: 0, section: 'Filter LFO' },
  { name: 'Delay', field: 'filterLfo.delay', offset: 0, section: 'Filter LFO' },
  { name: 'Trigger', field: 'filterLfo.trigger', offset: 0, section: 'Filter LFO', format: fmtLookup(LFO_TRIG_LABELS) },
  { name: 'Level', field: 'filterLfo.level', offset: 0, section: 'Filter LFO' },
  { name: 'Mod Wheel Mod', field: 'filterLfo.modWheelMod', offset: -99, section: 'Filter LFO', format: fmtSigned(-99) },
  { name: 'Aftertouch Mod', field: 'filterLfo.aftertouchMod', offset: -99, section: 'Filter LFO', format: fmtSigned(-99) },
  // Amp LFO
  { name: 'Waveform', field: 'ampLfo.waveform', offset: 0, section: 'Amp LFO', format: fmtLookup(LFO_WAVE_LABELS) },
  { name: 'Speed', field: 'ampLfo.speed', offset: 0, section: 'Amp LFO' },
  { name: 'Delay', field: 'ampLfo.delay', offset: 0, section: 'Amp LFO' },
  { name: 'Trigger', field: 'ampLfo.trigger', offset: 0, section: 'Amp LFO', format: fmtLookup(LFO_TRIG_LABELS) },
  { name: 'Level', field: 'ampLfo.level', offset: 0, section: 'Amp LFO' },
  { name: 'Mod Wheel Mod', field: 'ampLfo.modWheelMod', offset: -99, section: 'Amp LFO', format: fmtSigned(-99) },
  { name: 'Aftertouch Mod', field: 'ampLfo.aftertouchMod', offset: -99, section: 'Amp LFO', format: fmtSigned(-99) },
  // Pitch Envelope
  { name: 'Attack', field: 'pitchEnv.attack', offset: 0, section: 'Pitch Env' },
  { name: 'Decay', field: 'pitchEnv.decay', offset: 0, section: 'Pitch Env' },
  { name: 'Sustain', field: 'pitchEnv.sustain', offset: 0, section: 'Pitch Env' },
  { name: 'Release', field: 'pitchEnv.release', offset: 0, section: 'Pitch Env' },
  { name: 'Delay', field: 'pitchEnv.delay', offset: 0, section: 'Pitch Env' },
  { name: 'Sustain Decay', field: 'pitchEnv.sustainDecay', offset: 0, section: 'Pitch Env' },
  { name: 'Trigger Type', field: 'pitchEnv.triggerType', offset: 0, section: 'Pitch Env', format: fmtLookup(ENV_TRIG_LABELS) },
  { name: 'Time Track', field: 'pitchEnv.timeTrack', offset: 0, section: 'Pitch Env', format: fmtBool('On', 'Off') },
  { name: 'Sustain Pedal', field: 'pitchEnv.sustainPedal', offset: 0, section: 'Pitch Env', format: fmtBool('On', 'Off') },
  { name: 'Level', field: 'pitchEnv.level', offset: 0, section: 'Pitch Env' },
  { name: 'Velocity Mod', field: 'pitchEnv.velocityMod', offset: -99, section: 'Pitch Env', format: fmtSigned(-99) },
  // Filter Envelope
  { name: 'Attack', field: 'filterEnv.attack', offset: 0, section: 'Filter Env' },
  { name: 'Decay', field: 'filterEnv.decay', offset: 0, section: 'Filter Env' },
  { name: 'Sustain', field: 'filterEnv.sustain', offset: 0, section: 'Filter Env' },
  { name: 'Release', field: 'filterEnv.release', offset: 0, section: 'Filter Env' },
  { name: 'Delay', field: 'filterEnv.delay', offset: 0, section: 'Filter Env' },
  { name: 'Sustain Decay', field: 'filterEnv.sustainDecay', offset: 0, section: 'Filter Env' },
  { name: 'Trigger Type', field: 'filterEnv.triggerType', offset: 0, section: 'Filter Env', format: fmtLookup(ENV_TRIG_LABELS) },
  { name: 'Time Track', field: 'filterEnv.timeTrack', offset: 0, section: 'Filter Env', format: fmtBool('On', 'Off') },
  { name: 'Sustain Pedal', field: 'filterEnv.sustainPedal', offset: 0, section: 'Filter Env', format: fmtBool('On', 'Off') },
  { name: 'Level', field: 'filterEnv.level', offset: 0, section: 'Filter Env' },
  { name: 'Velocity Mod', field: 'filterEnv.velocityMod', offset: -99, section: 'Filter Env', format: fmtSigned(-99) },
  // Amp Envelope
  { name: 'Attack', field: 'ampEnv.attack', offset: 0, section: 'Amp Env' },
  { name: 'Decay', field: 'ampEnv.decay', offset: 0, section: 'Amp Env' },
  { name: 'Sustain', field: 'ampEnv.sustain', offset: 0, section: 'Amp Env' },
  { name: 'Release', field: 'ampEnv.release', offset: 0, section: 'Amp Env' },
  { name: 'Delay', field: 'ampEnv.delay', offset: 0, section: 'Amp Env' },
  { name: 'Sustain Decay', field: 'ampEnv.sustainDecay', offset: 0, section: 'Amp Env' },
  { name: 'Trigger Type', field: 'ampEnv.triggerType', offset: 0, section: 'Amp Env', format: fmtLookup(ENV_TRIG_LABELS) },
  { name: 'Time Track', field: 'ampEnv.timeTrack', offset: 0, section: 'Amp Env', format: fmtBool('On', 'Off') },
  { name: 'Sustain Pedal', field: 'ampEnv.sustainPedal', offset: 0, section: 'Amp Env', format: fmtBool('On', 'Off') },
  { name: 'Level', field: 'ampEnv.level', offset: 0, section: 'Amp Env' },
  // Tracking Generator
  { name: 'Input', field: 'tracking.input', offset: 0, section: 'Tracking', format: fmtLookup(MOD_SOURCES.slice(0, 23)) },
  ...Array.from({ length: 11 }, (_, i) => ({
    name: `Point ${i}`, field: `tracking.points.${i}`, offset: 0, section: 'Tracking',
  })),
];

const DRUM_PAN_LABELS = ['Left 3', 'Left 2', 'Left 1', 'Center', 'Right 1', 'Right 2', 'Right 3'];

const DRUM_PARAMS = [
  { name: 'Sample Group', field: 'sampleGroup', offset: 0 },
  { name: 'Sample Number', field: 'sampleNumber', offset: 0 },
  { name: 'Volume', field: 'volume', offset: 0 },
  { name: 'Pan', field: 'pan', offset: 0, format: fmtLookup(DRUM_PAN_LABELS) },
  { name: 'Output', field: 'output', offset: 0, format: fmtLookup(OUTPUT_LABELS) },
  { name: 'Effect Level', field: 'effectLevel', offset: 0 },
  { name: 'Effect Bus', field: 'effectBus', offset: 0, format: fmtLookup(EFFECT_BUS_LABELS) },
  { name: 'Pitch', field: 'pitch', offset: -48, format: fmtSigned(-48) },
  { name: 'Pitch Vel Mod', field: 'pitchVelMod', offset: 0 },
  { name: 'Filter Vel Mod', field: 'filterVelMod', offset: 0 },
  { name: 'Velocity Curve', field: 'velocityCurve', offset: 0, format: fmtLookup(VEL_CURVE_LABELS) },
  { name: 'Note Number', field: 'noteNumber', offset: 0, format: fmtNote },
  { name: 'Amp Env Decay', field: 'ampEnvDecay', offset: 0 },
  { name: 'Mute Group', field: 'muteGroup', offset: 0 },
  { name: 'Note Range', field: 'noteRange', offset: 0 },
];

const ROM_ID_LABELS = ['QS+/S4+', 'QS', 'Reserved', 'Reserved'];

function renderSectionBlock(label, rowsHtml) {
  return `<div class="prog-info-section-block"><table class="globals-table"><tbody>` +
    `<tr class="prog-info-subsection"><td colspan="2">${escapeHTML(label)}</td></tr>` +
    rowsHtml +
    `</tbody></table></div>`;
}

function renderKeyboardSound(keyboard) {
  const sampleName = getKeyboardSampleName(keyboard.sample.group, keyboard.sample.number);

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
    const raw = getNestedField(keyboard, p.field);
    const val = p.format ? p.format(raw) : (p.offset ? String(raw + p.offset) : String(raw));
    rows += `<tr><td>${escapeHTML(p.name)}</td><td>${escapeHTML(String(val))}</td></tr>`;
  }
  if (currentSection) {
    html += renderSectionBlock(currentSection, rows);
  }
  return html;
}

function renderDrumSound(drums) {
  let html = '';
  for (let d = 0; d < drums.length; d++) {
    const drum = drums[d];
    const drumName = getDrumSampleName(drum.sampleGroup, drum.sampleNumber);
    let rows = '';
    for (const p of DRUM_PARAMS) {
      if (p.field === 'sampleGroup' || p.field === 'sampleNumber') continue;
      const raw = drum[p.field];
      const val = p.format ? p.format(raw) : (p.offset ? String(raw + p.offset) : String(raw));
      rows += `<tr><td>${escapeHTML(p.name)}</td><td>${escapeHTML(String(val))}</td></tr>`;
    }
    html += renderSectionBlock(`Drum ${d + 1} — ${drumName}`, rows);
  }
  return html;
}

function renderProgInfo(program) {
  // Common section
  let html = '<table class="globals-table"><tbody>';
  html += `<tr><td>Program Name</td><td>${escapeHTML(program.name)}</td></tr>`;
  html += `<tr><td>ROM ID</td><td>${ROM_ID_LABELS[program.romId] || program.romId}</td></tr>`;
  html += '</tbody></table>';

  // Tab bar
  html += '<div class="prog-info-tabs">';
  for (let s = 0; s < 4; s++) {
    const snd = program.sounds[s];
    const label = `Sound ${s + 1}`;
    const active = s === 0 ? ' active' : '';
    const disabled = !snd.enabled ? ' disabled' : '';
    html += `<button class="prog-info-tab${active}" data-tab="${s}"${disabled}>${label}</button>`;
  }
  html += '</div>';

  // Tab panels
  for (let s = 0; s < 4; s++) {
    const snd = program.sounds[s];
    const active = s === 0 ? ' active' : '';
    html += `<div class="prog-info-panel${active}" data-panel="${s}">`;
    if (!snd.enabled) {
      const modeLabel = snd.isDrum ? 'Drum' : 'Keyboard';
      html += `<p class="globals-loading">${modeLabel} — Disabled</p>`;
    } else {
      html += '<div class="prog-info-sections">';
      if (snd.isDrum) {
        html += renderDrumSound(snd.drums);
      } else {
        html += renderKeyboardSound(snd.keyboard);
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
    const program = await readProgram(
      activeDevice.device.output,
      activeDevice.device.input,
      currentPatch,
    );
    renderProgInfo(program);
    if (currentBank === 0) {
      await putProgram(currentPatch, program);
      await loadUserBankCache();
    }
  } catch {
    progInfoBody.innerHTML = '<p class="globals-loading">Failed to read program data.</p>';
  }
}

function closeProgInfo() {
  progInfoModal.classList.add('hidden');
}

progInfoBtn.addEventListener('click', () => {
  if (currentMode === 'mix') openMixInfo();
  else openProgInfo();
});
progInfoClose.addEventListener('click', closeProgInfo);
progInfoModal.addEventListener('click', (e) => {
  if (e.target === progInfoModal) closeProgInfo();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !progInfoModal.classList.contains('hidden')) {
    closeProgInfo();
  }
});

// --- Mix Info dialog ---

const MIX_PROG_TYPE_LABELS = ['User', 'Preset 1', 'Preset 2', 'Preset 3', 'GenMIDI'];
const MIX_OUTPUT_LABELS = ['Main', 'Aux', 'Off', 'Spare'];

const MIX_CHANNEL_PARAMS = [
  { name: 'Program Number', field: 'programNumber', offset: 0, section: 'Program' },
  { name: 'Program Type', field: 'programType', offset: 0, section: 'Program', format: fmtLookup(MIX_PROG_TYPE_LABELS) },
  { name: 'Enable', field: 'enable', offset: 0, section: 'Program', format: fmtBool('On', 'Off') },
  { name: 'Volume', field: 'volume', offset: 0, section: 'Level' },
  { name: 'Pan', field: 'pan', offset: 0, section: 'Level', format: fmtLookup(PAN_LABELS) },
  { name: 'Output', field: 'output', offset: 0, section: 'Level', format: fmtLookup(MIX_OUTPUT_LABELS) },
  { name: 'Effect Level', field: 'effectLevel', offset: 0, section: 'Level' },
  { name: 'Effect Bus', field: 'effectBus', offset: 0, section: 'Level', format: fmtLookup(EFFECT_BUS_LABELS) },
  { name: 'Pitch Octave', field: 'pitchOctave', offset: -2, section: 'Pitch', format: fmtSigned(-2) },
  { name: 'Pitch Semitone', field: 'pitchSemitone', offset: -12, section: 'Pitch', format: fmtSigned(-12) },
  { name: 'Low Note', field: 'lowNote', offset: 0, section: 'Note Range', format: fmtNote },
  { name: 'High Note', field: 'highNote', offset: 0, section: 'Note Range', format: fmtNote },
  { name: 'MIDI In', field: 'midiIn', offset: 0, section: 'MIDI Control', format: fmtBool('On', 'Off') },
  { name: 'MIDI Out', field: 'midiOut', offset: 0, section: 'MIDI Control', format: fmtBool('On', 'Off') },
  { name: 'MIDI Group', field: 'midiGroup', offset: 0, section: 'MIDI Control', format: fmtBool('On', 'Off') },
  { name: 'Wheels', field: 'wheels', offset: 0, section: 'MIDI Control', format: fmtBool('On', 'Off') },
  { name: 'Aftertouch', field: 'aftertouch', offset: 0, section: 'MIDI Control', format: fmtBool('On', 'Off') },
  { name: 'Sustain Pedal', field: 'sustainPedal', offset: 0, section: 'MIDI Control', format: fmtBool('On', 'Off') },
  { name: 'Pedals/Controllers', field: 'pedalsControllers', offset: 0, section: 'MIDI Control', format: fmtBool('On', 'Off') },
];


function renderMixInfo(mix) {
  // Common section
  let html = '<table class="globals-table"><tbody>';
  html += `<tr><td>Mix Name</td><td>${escapeHTML(mix.name)}</td></tr>`;
  html += `<tr><td>Effect MIDI PC</td><td>${mix.effectMidiPC ? 'On' : 'Off'}</td></tr>`;
  html += `<tr><td>Effect Channel</td><td>${mix.effectChannel + 1}</td></tr>`;
  html += '</tbody></table>';

  // Tab bar
  html += '<div class="prog-info-tabs">';
  for (let ch = 0; ch < 16; ch++) {
    const label = `Ch ${ch + 1}`;
    const active = ch === 0 ? ' active' : '';
    const disabled = !mix.channels[ch].enable ? ' disabled' : '';
    html += `<button class="prog-info-tab${active}" data-tab="${ch}"${disabled}>${label}</button>`;
  }
  html += '</div>';

  // Tab panels
  for (let ch = 0; ch < 16; ch++) {
    const channel = mix.channels[ch];
    const active = ch === 0 ? ' active' : '';
    html += `<div class="prog-info-panel${active}" data-panel="${ch}">`;
    if (!channel.enable) {
      html += `<p class="globals-loading">Channel ${ch + 1} — Disabled</p>`;
    } else {
      html += '<div class="prog-info-sections">';
      let currentSection = '';
      let rows = '';
      for (const p of MIX_CHANNEL_PARAMS) {
        if (p.section !== currentSection) {
          if (currentSection) {
            html += renderSectionBlock(currentSection, rows);
          }
          currentSection = p.section;
          rows = '';
        }
        const raw = channel[p.field];
        const val = p.format ? p.format(raw) : (p.offset ? String(raw + p.offset) : String(raw));
        rows += `<tr><td>${escapeHTML(p.name)}</td><td>${escapeHTML(String(val))}</td></tr>`;
      }
      if (currentSection) {
        html += renderSectionBlock(currentSection, rows);
      }
      html += '</div>';
    }
    html += '</div>';
  }

  mixInfoBody.innerHTML = html;

  // Wire up tab switching
  mixInfoBody.querySelectorAll('.prog-info-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      mixInfoBody.querySelector('.prog-info-tab.active')?.classList.remove('active');
      mixInfoBody.querySelector('.prog-info-panel.active')?.classList.remove('active');
      tab.classList.add('active');
      mixInfoBody.querySelector(`.prog-info-panel[data-panel="${tab.dataset.tab}"]`)?.classList.add('active');
    });
  });
}

async function openMixInfo() {
  mixInfoModal.classList.remove('hidden');
  mixInfoBody.innerHTML = '<p class="globals-loading">Requesting mix data...</p>';
  if (!activeDevice) return;
  try {
    const mix = await readMix(
      activeDevice.device.output,
      activeDevice.device.input,
      currentPatch,
    );
    renderMixInfo(mix);
    if (currentBank === 0) {
      await putMix(currentPatch, mix);
      await loadUserBankCache();
    }
  } catch {
    mixInfoBody.innerHTML = '<p class="globals-loading">Failed to read mix data.</p>';
  }
}

function closeMixInfo() {
  mixInfoModal.classList.add('hidden');
}

mixInfoClose.addEventListener('click', closeMixInfo);
mixInfoModal.addEventListener('click', (e) => {
  if (e.target === mixInfoModal) closeMixInfo();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !mixInfoModal.classList.contains('hidden')) {
    closeMixInfo();
  }
});

// --- SysEx File Viewer ---

function parseSyxFile(arrayBuffer) {
  const data = new Uint8Array(arrayBuffer);
  const programs = [];
  const newMixes = [];
  const oldMixes = [];
  const effects = [];
  const messages = [];
  let global = null;

  // Split into individual SysEx messages (F0...F7)
  let i = 0;
  while (i < data.length) {
    if (data[i] !== 0xF0) { i++; continue; }
    const start = i;
    i++;
    while (i < data.length && data[i] !== 0xF7) i++;
    if (i >= data.length) break;
    i++; // include F7
    const msg = data.slice(start, i);
    messages.push(msg);

    try {
      // Validate Alesis QS header: 00 00 0E 0E at bytes 1-4
      if (msg.length < 8 || msg[1] !== 0x00 || msg[2] !== 0x00 || msg[3] !== 0x0E || msg[4] !== 0x0E) {
        continue;
      }
      const opcode = msg[5];
      const num = msg[6];

      switch (opcode) {
        case 0x00: { // User Program
          const prog = Program.fromSysex(msg);
          programs.push({ num, name: prog.name, program: prog });
          break;
        }
        case 0x0E: { // New Mix (v2+)
          const m = Mix.fromSysex(msg);
          newMixes.push({ num, name: m.name, mix: m });
          break;
        }
        case 0x04: { // Old Mix (<v2)
          const m = Mix.fromSysex(msg);
          oldMixes.push({ num, name: m.name, mix: m });
          break;
        }
        case 0x06: // User Effects
          effects.push({ num });
          break;
        case 0x0A: { // Global Data
          const packed = msg.slice(7, msg.length - 1);
          global = unpackQSData(packed);
          break;
        }
        default:
          console.warn(`Unknown QS opcode 0x${opcode.toString(16).padStart(2, '0')}`);
      }
    } catch (err) {
      console.warn('SysEx parse error:', err.message);
    }
  }

  return { programs, newMixes, oldMixes, effects, global, messages };
}

function renderSyxViewer(parsed, filename) {
  const mixes = parsed.newMixes.length > 0 ? parsed.newMixes : parsed.oldMixes;
  const mixLabel = parsed.newMixes.length > 0 ? 'new mixes' : (parsed.oldMixes.length > 0 ? 'old mixes' : 'mixes');
  const counts = [];
  if (parsed.programs.length) counts.push(`${parsed.programs.length} programs`);
  if (mixes.length) counts.push(`${mixes.length} ${mixLabel}`);
  if (parsed.effects.length) counts.push(`${parsed.effects.length} effects`);
  if (parsed.global) counts.push('1 global');

  let html = `<p class="syx-summary"><strong>${escapeHTML(filename)}</strong><br>${counts.join(', ') || 'No recognized data'}</p>`;

  // Build tabs
  const tabs = [];
  if (parsed.programs.length) tabs.push({ id: 'programs', label: 'Programs' });
  if (mixes.length) tabs.push({ id: 'mixes', label: 'Mixes' });
  if (parsed.effects.length) tabs.push({ id: 'effects', label: 'Effects' });
  if (parsed.global) tabs.push({ id: 'global', label: 'Global' });

  if (tabs.length > 0) {
    html += '<div class="prog-info-tabs">';
    for (let t = 0; t < tabs.length; t++) {
      const active = t === 0 ? ' active' : '';
      html += `<button class="prog-info-tab${active}" data-tab="${tabs[t].id}">${tabs[t].label}</button>`;
    }
    html += '</div>';

    for (let t = 0; t < tabs.length; t++) {
      const active = t === 0 ? ' active' : '';
      html += `<div class="prog-info-panel${active}" data-panel="${tabs[t].id}">`;

      if (tabs[t].id === 'programs') {
        html += '<table class="globals-table"><thead><tr><th>#</th><th>Name</th></tr></thead><tbody>';
        for (const p of parsed.programs) {
          html += `<tr><td>${String(p.num).padStart(3, '0')}</td><td>${escapeHTML(p.name)}</td></tr>`;
        }
        html += '</tbody></table>';
      } else if (tabs[t].id === 'mixes') {
        html += '<table class="globals-table"><thead><tr><th>#</th><th>Name</th></tr></thead><tbody>';
        for (const m of mixes) {
          html += `<tr><td>${String(m.num).padStart(3, '0')}</td><td>${escapeHTML(m.name)}</td></tr>`;
        }
        html += '</tbody></table>';
      } else if (tabs[t].id === 'effects') {
        html += '<table class="globals-table"><thead><tr><th>#</th></tr></thead><tbody>';
        for (const e of parsed.effects) {
          html += `<tr><td>${String(e.num).padStart(3, '0')}</td></tr>`;
        }
        html += '</tbody></table>';
      } else if (tabs[t].id === 'global') {
        html += '<table class="globals-table"><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>';
        for (const def of GLOBAL_PARAMS) {
          const raw = parsed.global[def.byte];
          const val = def.signed ? parseSignedByte(raw) : raw;
          html += `<tr><td>${escapeHTML(def.name)}</td><td>${escapeHTML(def.format(val))}</td></tr>`;
        }
        html += '</tbody></table>';
      }

      html += '</div>';
    }
  }

  syxViewerBody.innerHTML = html;

  // Wire up tab switching
  syxViewerBody.querySelectorAll('.prog-info-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      syxViewerBody.querySelector('.prog-info-tab.active')?.classList.remove('active');
      syxViewerBody.querySelector('.prog-info-panel.active')?.classList.remove('active');
      tab.classList.add('active');
      syxViewerBody.querySelector(`.prog-info-panel[data-panel="${tab.dataset.tab}"]`)?.classList.add('active');
    });
  });
}

let currentSyxParsed = null;

function updateSyxSendBtn() {
  syxSendBtn.disabled = !activeDevice || !currentSyxParsed || currentSyxParsed.messages.length === 0;
}

async function sendSyxToDevice() {
  if (!activeDevice || !currentSyxParsed) return;
  const msgs = currentSyxParsed.messages;
  const titleEl = syxViewerModal.querySelector('.globals-title');
  const originalTitle = titleEl.textContent;
  syxSendBtn.disabled = true;

  for (let i = 0; i < msgs.length; i++) {
    titleEl.textContent = `Sending ${i + 1}/${msgs.length}...`;
    activeDevice.device.output.send(msgs[i]);
    if (i < msgs.length - 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Cache sent programs and mixes to IndexedDB
  for (const p of currentSyxParsed.programs) {
    await putProgram(p.num, p.program);
  }
  const mixes = currentSyxParsed.newMixes.length > 0 ? currentSyxParsed.newMixes : currentSyxParsed.oldMixes;
  for (const m of mixes) {
    await putMix(m.num, m.mix);
  }
  if (currentSyxParsed.programs.length || mixes.length) {
    await loadUserBankCache();
  }

  titleEl.textContent = originalTitle;
  updateSyxSendBtn();
}

function closeSyxViewer() {
  syxViewerModal.classList.add('hidden');
}

syxSendBtn.addEventListener('click', sendSyxToDevice);

syxOpenBtn.addEventListener('click', () => {
  syxFileInput.click();
});

syxFileInput.addEventListener('change', () => {
  const file = syxFileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const parsed = parseSyxFile(reader.result);
    currentSyxParsed = parsed;
    renderSyxViewer(parsed, file.name);
    syxViewerModal.classList.remove('hidden');
    updateSyxSendBtn();
  };
  reader.readAsArrayBuffer(file);
  syxFileInput.value = '';
});

syxViewerClose.addEventListener('click', closeSyxViewer);
syxViewerModal.addEventListener('click', (e) => {
  if (e.target === syxViewerModal) closeSyxViewer();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !syxViewerModal.classList.contains('hidden')) {
    closeSyxViewer();
  }
});

init();
