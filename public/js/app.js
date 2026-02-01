import { requestMIDIAccess, getDevices, queryDeviceIdentity, scanForQSDevice, sendModeSelect, sendBankSelect, sendProgramChange, sendMidiProgramSelect, sendGlobalParam, requestPatchName } from './midi.js';
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
}

function selectPatch(patch) {
  const max = maxPatch();
  if (patch < 0) patch = max;
  if (patch > max) patch = 0;
  currentPatch = patch;
  updateBankPatchUI();
  sendBankAndPatch();
  fetchPatchName();
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
    sendModeSelect(activeDevice.device.output, 0);
    sendMidiProgramSelect(activeDevice.device.output, 1); // On
    currentMode = 'prog';
    currentBank = 0;
    currentPatch = 0;
    updateModeButtons();
    updateBankPatchUI();
    fetchPatchName();
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
    sendModeSelect(activeDevice.device.output, 0);
    sendMidiProgramSelect(activeDevice.device.output, 1); // On
    currentMode = 'prog';
    currentBank = 0;
    currentPatch = 0;
    updateModeButtons();
    updateBankPatchUI();
    fetchPatchName();
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

init();
