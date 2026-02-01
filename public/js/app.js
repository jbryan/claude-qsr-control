import { requestMIDIAccess, getDevices, queryDeviceIdentity, scanForQSDevice, sendModeSelect, sendBankSelect, sendProgramChange, sendMidiProgramSelect, sendGlobalParam, requestPatchName, requestGlobalData, unpackQSData } from './midi.js';
import { getPresetName, getAllPresets } from './presets.js';

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

init();
