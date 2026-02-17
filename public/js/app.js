import { requestMIDIAccess, getDevices, queryDeviceIdentity, scanForQSDevice, sendModeSelect, sendBankSelect, sendProgramChange, sendMidiProgramSelect, sendGlobalParam, sendParamEdit, requestGlobalData, unpackQSData } from './midi.js';
import { logSend } from './midi-log.js';
import { getKeyboardSampleName, getDrumSampleName, KEYBOARD_GROUPS, KEYBOARD_VOICES, DRUM_GROUPS, DRUM_VOICES } from './samples.js';
import { getNestedField, setNestedField, Program, Mix, Effect, readProgram, readMix, readEditProgram, readEditMix, writeEditProgram, writeEditMix } from './models.js';
import { putProgram, putMix, getAllNames, hasData, getAllPatchEntries, getProgramByHash, getMixByHash } from './store.js';

const deviceSelect = document.getElementById('device-select');
const identifyBtn = document.getElementById('identify-btn');
const statusArea = document.getElementById('status');
const lcdLine1 = document.getElementById('lcd-line1');
const lcdLine2 = document.getElementById('lcd-line2');
const rescanBtn = document.getElementById('rescan-btn');
const midiBtn = document.getElementById('midi-btn');
const midiModal = document.getElementById('midi-modal');
const midiClose = document.getElementById('midi-close');
const modeSelect = document.getElementById('mode-select');
const lcdBankSelect = document.getElementById('lcd-bank');
const lcdPatchInput = document.getElementById('lcd-patch');
const lcdName = document.getElementById('lcd-name');
const searchModal = document.getElementById('search-modal');
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
const filterProg = document.getElementById('filter-prog');
const filterMix = document.getElementById('filter-mix');
const globalsBtn = document.getElementById('globals-btn');
const globalsModal = document.getElementById('globals-modal');
const globalsBody = document.getElementById('globals-body');
const globalsClose = document.getElementById('globals-close');
const editBufBtn = document.getElementById('edit-buf-btn');
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

let searchHighlight = -1;

const STORAGE_KEY = 'qsr-control-state';
let userBankCache = null;
let fullPatchCache = null;
const filterStored = document.getElementById('filter-stored');
const sortOrder = document.getElementById('sort-order');

async function loadUserBankCache() {
  userBankCache = await getAllNames();
  fullPatchCache = await getAllPatchEntries();
}

// Migration: discard old localStorage name-only cache
try { localStorage.removeItem('qsr-user-banks'); } catch { /* ignore */ }

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getAllSearchablePatches() {
  if (!fullPatchCache) return [];
  const filter = filterStored.value;
  const results = [];

  for (const p of fullPatchCache.programs) {
    const stored = p.assignments.length > 0;
    if (filter === 'stored' && !stored) continue;
    if (filter === 'unstored' && stored) continue;

    if (stored) {
      for (const a of p.assignments) {
        results.push({ mode: 'prog', bank: a.bank, patch: a.number, name: p.name, hash: p.hash, stored: true });
      }
    } else {
      results.push({ mode: 'prog', name: p.name, hash: p.hash, stored: false });
    }
  }

  for (const m of fullPatchCache.mixes) {
    const stored = m.assignments.length > 0;
    if (filter === 'stored' && !stored) continue;
    if (filter === 'unstored' && stored) continue;

    if (stored) {
      for (const a of m.assignments) {
        results.push({ mode: 'mix', bank: a.bank, patch: a.number, name: m.name, hash: m.hash, stored: true });
      }
    } else {
      results.push({ mode: 'mix', name: m.name, hash: m.hash, stored: false });
    }
  }
  return results;
}

async function refreshAllBanks() {
  if (!activeDevice) return;
  refreshBtn.disabled = true;
  const out = activeDevice.device.output;
  const inp = activeDevice.device.input;
  const total = 5 * 128 + 5 * 100; // 1140
  let done = 0;

  // Phase 1 — User bank (bank 0): direct SysEx dump
  for (let i = 0; i < 128; i++) {
    lcdLine1.textContent = `Refreshing ${++done}/${total}...`;
    try {
      const program = await readProgram(out, inp, i);
      await putProgram(0, i, program);
    } catch { /* skip */ }
  }
  for (let i = 0; i < 100; i++) {
    lcdLine1.textContent = `Refreshing ${++done}/${total}...`;
    try {
      const mix = await readMix(out, inp, i);
      await putMix(0, i, mix);
    } catch { /* skip */ }
  }

  // Phase 2 — Preset program banks 1-4 via edit buffer
  sendModeSelect(out, 0); // prog mode
  sendMidiProgramSelect(out, 1); // On
  await delay(50);
  for (let bank = 1; bank <= 4; bank++) {
    for (let i = 0; i < 128; i++) {
      lcdLine1.textContent = `Refreshing ${++done}/${total}...`;
      try {
        sendBankSelect(out, MIDI_CHANNEL, bank);
        sendProgramChange(out, MIDI_CHANNEL, i);
        await delay(100);
        const program = await readEditProgram(out, inp);
        await putProgram(bank, i, program);
      } catch { /* skip */ }
    }
  }

  // Phase 3 — Preset mix banks 1-4 via edit buffer
  sendModeSelect(out, 1); // mix mode
  sendMidiProgramSelect(out, 2); // Channel 1
  await delay(50);
  for (let bank = 1; bank <= 4; bank++) {
    for (let i = 0; i < 100; i++) {
      lcdLine1.textContent = `Refreshing ${++done}/${total}...`;
      try {
        sendBankSelect(out, MIDI_CHANNEL, bank);
        sendProgramChange(out, MIDI_CHANNEL, i);
        await delay(50);
        const mix = await readEditMix(out, inp);
        await putMix(bank, i, mix);
      } catch { /* skip */ }
    }
  }

  // Phase 4 — Restore current state
  sendModeSelect(out, currentMode === 'prog' ? 0 : 1);
  sendMidiProgramSelect(out, currentMode === 'prog' ? 1 : 2);
  sendBankAndPatch();
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
  lcdLine2.classList.add('hidden');
  statusArea.className = `lcd ${type}`;
}

function updateLCD() {
  const id = activeDevice.identity;
  lcdLine1.textContent = `${id.manufacturer} ${id.model} — fw ${id.softwareVersion}`;
  modeSelect.value = currentMode;
  lcdBankSelect.value = currentBank;
  lcdPatchInput.max = maxPatch();
  lcdPatchInput.value = currentPatch;
  lcdName.textContent = currentPatchName;
  lcdName.classList.toggle('clickable', !!activeDevice);
  lcdLine2.classList.remove('hidden');
  statusArea.className = 'lcd success';
}

async function fetchPatchName() {
  const id = ++nameFetchId;
  currentPatchName = '';
  updateLCD();
  if (!activeDevice) return;

  // Check IndexedDB cache first (any bank)
  if (userBankCache) {
    const list = currentMode === 'prog' ? userBankCache.programs : userBankCache.mixes;
    const cached = list.find(e => e.bank === currentBank && e.number === currentPatch);
    if (cached && cached.name) {
      currentPatchName = cached.name;
      updateLCD();
      return;
    }
  }

  // Cache miss — fetch from hardware
  try {
    if (currentBank === 0) {
      // User bank: direct SysEx dump
      if (currentMode === 'prog') {
        const program = await readProgram(activeDevice.device.output, activeDevice.device.input, currentPatch);
        if (id !== nameFetchId) return;
        currentPatchName = program.name;
        updateLCD();
        await putProgram(0, currentPatch, program);
        await loadUserBankCache();
      } else {
        const mix = await readMix(activeDevice.device.output, activeDevice.device.input, currentPatch);
        if (id !== nameFetchId) return;
        currentPatchName = mix.name;
        updateLCD();
        await putMix(0, currentPatch, mix);
        await loadUserBankCache();
      }
    } else {
      // Preset banks: sendBankAndPatch already loaded the patch into the edit buffer
      if (currentMode === 'prog') {
        const program = await readEditProgram(activeDevice.device.output, activeDevice.device.input);
        if (id !== nameFetchId) return;
        currentPatchName = program.name;
        updateLCD();
        await putProgram(currentBank, currentPatch, program);
        await loadUserBankCache();
      } else {
        const mix = await readEditMix(activeDevice.device.output, activeDevice.device.input);
        if (id !== nameFetchId) return;
        currentPatchName = mix.name;
        updateLCD();
        await putMix(currentBank, currentPatch, mix);
        await loadUserBankCache();
      }
    }
  } catch {
    // Timeout — leave name blank
  }
}

function updateModeSelect() {
  const connected = !!activeDevice;
  modeSelect.disabled = !connected;
  modeSelect.value = currentMode;
  lcdBankSelect.disabled = !connected;
  lcdPatchInput.disabled = !connected;
  lcdName.classList.toggle('clickable', connected);
}


function maxPatch() {
  return currentMode === 'prog' ? 127 : 99;
}

function updateProgInfoVisibility() {
  editBufBtn.classList.toggle('hidden', !activeDevice);
}

function updateBankPatchUI() {
  const connected = activeDevice !== null;
  lcdBankSelect.disabled = !connected;
  lcdPatchInput.disabled = !connected;
  globalsBtn.disabled = !connected;
  refreshBtn.disabled = !connected;
  lcdBankSelect.value = currentBank;
  lcdPatchInput.max = maxPatch();
  lcdPatchInput.value = currentPatch;
  lcdName.classList.toggle('clickable', connected);
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
  updateModeSelect();
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
  updateModeSelect();
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
    if (!(await hasData())) refreshAllBanks();
  } else {
    activeDevice = null;
    updateModeSelect();
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
    if (!(await hasData())) refreshAllBanks();
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

modeSelect.addEventListener('change', () => {
  if (activeDevice) activateMode(modeSelect.value);
});
lcdBankSelect.addEventListener('change', () => {
  if (activeDevice) selectBank(Number(lcdBankSelect.value));
});
lcdPatchInput.addEventListener('change', () => {
  if (activeDevice) selectPatch(Number(lcdPatchInput.value));
});
lcdName.addEventListener('click', () => {
  if (activeDevice) openSearch();
});
rescanBtn.addEventListener('click', () => autoScan());
refreshBtn.addEventListener('click', () => refreshAllBanks());
midiBtn.addEventListener('click', () => {
  midiModal.classList.remove('hidden');
});
midiClose.addEventListener('click', () => {
  midiModal.classList.add('hidden');
});
midiModal.addEventListener('click', (e) => {
  if (e.target === midiModal) midiModal.classList.add('hidden');
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
  const combined = getAllSearchablePatches();
  const matches = combined.filter(p => {
    if (p.mode === 'prog' && !showProg) return false;
    if (p.mode === 'mix' && !showMix) return false;
    if (lower && !p.name.toLowerCase().includes(lower)) return false;
    return true;
  });
  const bankNames = ['User', 'Preset 1', 'Preset 2', 'Preset 3', 'GenMIDI'];
  const sort = sortOrder.value;
  if (sort === 'bank') {
    matches.sort((a, b) => {
      if (a.mode !== b.mode) return a.mode === 'prog' ? -1 : 1;
      if (a.stored !== b.stored) return a.stored ? -1 : 1;
      if (a.stored && b.stored) {
        if (a.bank !== b.bank) return a.bank - b.bank;
        return a.patch - b.patch;
      }
      return a.name.localeCompare(b.name);
    });
  } else if (sort === 'number') {
    matches.sort((a, b) => {
      if (a.mode !== b.mode) return a.mode === 'prog' ? -1 : 1;
      if (a.stored !== b.stored) return a.stored ? -1 : 1;
      if (a.stored && b.stored) {
        if (a.patch !== b.patch) return a.patch - b.patch;
        return a.bank - b.bank;
      }
      return a.name.localeCompare(b.name);
    });
  } else {
    matches.sort((a, b) => {
      if (a.mode !== b.mode) return a.mode === 'prog' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }
  let lastGroup = '';
  for (const p of matches) {
    const modeName = p.mode === 'prog' ? 'PROG' : 'MIX';
    let group;
    if (sort === 'bank') {
      group = p.stored
        ? `${modeName} — ${bankNames[p.bank] || `Bank ${p.bank}`}`
        : `${modeName} — Unassigned`;
    } else {
      group = modeName;
    }
    if (group !== lastGroup) {
      lastGroup = group;
      const header = document.createElement('li');
      header.className = 'search-group-header';
      header.textContent = group;
      searchResults.appendChild(header);
    }
    const li = document.createElement('li');
    li.className = 'search-result-item';
    if (p.stored) {
      const patchNum = String(p.patch).padStart(3, '0');
      const meta = sort === 'bank'
        ? `#${patchNum}`
        : `${bankNames[p.bank] || `Bank ${p.bank}`} #${patchNum}`;
      li.innerHTML =
        `<span class="search-result-name">${escapeHTML(p.name)}</span>` +
        `<span class="search-result-meta">${meta}</span>`;
    } else {
      li.innerHTML =
        `<span class="search-result-name">${escapeHTML(p.name)}</span>`;
    }
    li.addEventListener('click', () => selectSearchResult(p));
    searchResults.appendChild(li);
  }
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function selectSearchResult(p) {
  closeSearch();
  if (!activeDevice) return;

  if (p.stored) {
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
  } else {
    if (p.mode === 'prog') {
      const program = await getProgramByHash(p.hash);
      if (!program) return;
      if (currentMode !== 'prog') {
        sendModeSelect(activeDevice.device.output, 0);
        sendMidiProgramSelect(activeDevice.device.output, 1);
        currentMode = 'prog';
        updateModeSelect();
      }
      await writeEditProgram(activeDevice.device.output, program);
      currentPatchName = program.name;
      lcdName.textContent = currentPatchName;
    } else {
      const mix = await getMixByHash(p.hash);
      if (!mix) return;
      if (currentMode !== 'mix') {
        sendModeSelect(activeDevice.device.output, 1);
        sendMidiProgramSelect(activeDevice.device.output, 2);
        currentMode = 'mix';
        updateModeSelect();
      }
      await writeEditMix(activeDevice.device.output, mix);
      currentPatchName = mix.name;
      lcdName.textContent = currentPatchName;
    }
  }
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


function refreshSearch() {
  renderSearchResults(searchInput.value.trim());
}

searchInput.addEventListener('input', refreshSearch);
filterProg.addEventListener('change', refreshSearch);
filterMix.addEventListener('change', refreshSearch);
filterStored.addEventListener('change', refreshSearch);
sortOrder.addEventListener('change', refreshSearch);

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
  if (e.key === 'Escape' && !midiModal.classList.contains('hidden')) {
    midiModal.classList.add('hidden');
  }
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
  // Sample (combined — handled specially in render)
  { name: 'Sample', field: 'sample', offset: 0, section: 'Sample',
    edit: { type: 'sample', groupFunc: 0, groupPage: 0, groupPot: 0, numFunc: 0, numPage: 0, numPot: 2 } },
  // Level
  { name: 'Volume', field: 'level.volume', offset: 0, section: 'Level',
    edit: { type: 'number', min: 0, max: 99, func: 1, page: 0, pot: 0 } },
  { name: 'Pan', field: 'level.pan', offset: 0, section: 'Level', format: fmtLookup(PAN_LABELS),
    edit: { type: 'select', options: PAN_LABELS, func: 1, page: 0, pot: 1 } },
  { name: 'Output', field: 'level.output', offset: 0, section: 'Level', format: fmtLookup(OUTPUT_LABELS),
    edit: { type: 'select', options: OUTPUT_LABELS, func: 1, page: 0, pot: 2 } },
  { name: 'Effect Level', field: 'level.effectLevel', offset: 0, section: 'Level',
    edit: { type: 'number', min: 0, max: 99, func: 2, page: 0, pot: 0 } },
  { name: 'Effect Bus', field: 'level.effectBus', offset: 0, section: 'Level', format: fmtLookup(EFFECT_BUS_LABELS),
    edit: { type: 'select', options: EFFECT_BUS_LABELS, func: 2, page: 0, pot: 1 } },
  // Pitch
  { name: 'Semitone', field: 'pitch.semitone', offset: -24, section: 'Pitch', format: fmtSigned(-24),
    edit: { type: 'number', min: -24, max: 25, func: 3, page: 0, pot: 0 } },
  { name: 'Detune', field: 'pitch.detune', offset: -99, section: 'Pitch', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 3, page: 0, pot: 2 } },
  { name: 'Detune Type', field: 'pitch.detuneType', offset: 0, section: 'Pitch', format: fmtLookup(['Normal', 'Equal Temper']),
    edit: { type: 'select', options: ['Normal', 'Equal Temper'], func: 3, page: 0, pot: 3 } },
  { name: 'Pitch Wheel Mod', field: 'pitch.pitchWheelMod', offset: 0, section: 'Pitch',
    edit: { type: 'number', min: 0, max: 12, func: 3, page: 1, pot: 0 } },
  { name: 'Aftertouch Mod', field: 'pitch.aftertouchMod', offset: -99, section: 'Pitch', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 3, page: 1, pot: 1 } },
  { name: 'LFO Mod', field: 'pitch.lfoMod', offset: -99, section: 'Pitch', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 3, page: 1, pot: 2 } },
  { name: 'Env Mod', field: 'pitch.envMod', offset: -99, section: 'Pitch', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 3, page: 1, pot: 3 } },
  { name: 'Portamento Mode', field: 'pitch.portamentoMode', offset: 0, section: 'Pitch', format: fmtLookup(PORTAMENTO_LABELS),
    edit: { type: 'select', options: PORTAMENTO_LABELS, func: 3, page: 2, pot: 0 } },
  { name: 'Portamento Rate', field: 'pitch.portamentoRate', offset: 0, section: 'Pitch',
    edit: { type: 'number', min: 0, max: 99, func: 3, page: 2, pot: 2 } },
  { name: 'Key Mode', field: 'pitch.keyMode', offset: 0, section: 'Pitch', format: fmtLookup(KEY_MODE_LABELS),
    edit: { type: 'select', options: KEY_MODE_LABELS, func: 3, page: 2, pot: 3 } },
  // Filter
  { name: 'Frequency', field: 'filter.frequency', offset: 0, section: 'Filter',
    edit: { type: 'number', min: 0, max: 99, func: 4, page: 0, pot: 0 } },
  { name: 'Keyboard Track', field: 'filter.keyboardTrack', offset: 0, section: 'Filter', format: fmtBool('On', 'Off'),
    edit: { type: 'checkbox', func: 4, page: 0, pot: 1 } },
  { name: 'Velocity Mod', field: 'filter.velocityMod', offset: -99, section: 'Filter', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 4, page: 0, pot: 3 } },
  { name: 'Pitch Wheel Mod', field: 'filter.pitchWheelMod', offset: -99, section: 'Filter', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 4, page: 1, pot: 0 } },
  { name: 'Aftertouch Mod', field: 'filter.aftertouchMod', offset: -99, section: 'Filter', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 4, page: 1, pot: 1 } },
  { name: 'LFO Mod', field: 'filter.lfoMod', offset: -99, section: 'Filter', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 4, page: 1, pot: 2 } },
  { name: 'Env Mod', field: 'filter.envMod', offset: -99, section: 'Filter', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 4, page: 1, pot: 3 } },
  // Amp
  { name: 'Velocity Curve', field: 'amp.velocityCurve', offset: 0, section: 'Amp', format: fmtLookup(VEL_CURVE_LABELS),
    edit: { type: 'select', options: VEL_CURVE_LABELS, func: 5, page: 0, pot: 0 } },
  { name: 'Aftertouch Mod', field: 'amp.aftertouchMod', offset: -99, section: 'Amp', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 5, page: 0, pot: 1 } },
  { name: 'LFO Mod', field: 'amp.lfoMod', offset: -99, section: 'Amp', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 5, page: 0, pot: 2 } },
  // Note Range
  { name: 'Low Note', field: 'noteRange.lowNote', offset: 0, section: 'Note Range', format: fmtNote,
    edit: { type: 'note', min: 0, max: 127, func: 6, page: 0, pot: 0 } },
  { name: 'High Note', field: 'noteRange.highNote', offset: 0, section: 'Note Range', format: fmtNote,
    edit: { type: 'note', min: 0, max: 127, func: 6, page: 0, pot: 1 } },
  { name: 'Overlap', field: 'noteRange.overlap', offset: 0, section: 'Note Range',
    edit: { type: 'number', min: 0, max: 99, func: 6, page: 0, pot: 2 } },
  // Mod Routings 1-6
  ...Array.from({ length: 6 }, (_, m) => [
    { name: 'Source', field: `mods.${m}.source`, offset: 0, section: `Mod ${m + 1}`, format: fmtLookup(MOD_SOURCES),
      edit: { type: 'select', options: MOD_SOURCES, func: 7, page: m, pot: 0 } },
    { name: 'Destination', field: `mods.${m}.destination`, offset: 0, section: `Mod ${m + 1}`, format: fmtLookup(MOD_DESTS),
      edit: { type: 'select', options: MOD_DESTS, func: 7, page: m, pot: 1 } },
    { name: 'Amplitude', field: `mods.${m}.amplitude`, offset: -99, section: `Mod ${m + 1}`, format: fmtSigned(-99),
      edit: { type: 'number', min: -99, max: 100, func: 7, page: m, pot: 2 } },
    { name: 'Gate', field: `mods.${m}.gate`, offset: 0, section: `Mod ${m + 1}`, format: fmtBool('On', 'Off'),
      edit: { type: 'checkbox', func: 7, page: m, pot: 3 } },
  ]).flat(),
  // Pitch LFO
  { name: 'Waveform', field: 'pitchLfo.waveform', offset: 0, section: 'Pitch LFO', format: fmtLookup(LFO_WAVE_LABELS),
    edit: { type: 'select', options: LFO_WAVE_LABELS, func: 9, page: 0, pot: 0 } },
  { name: 'Speed', field: 'pitchLfo.speed', offset: 0, section: 'Pitch LFO',
    edit: { type: 'number', min: 0, max: 99, func: 9, page: 0, pot: 1 } },
  { name: 'Delay', field: 'pitchLfo.delay', offset: 0, section: 'Pitch LFO',
    edit: { type: 'number', min: 0, max: 99, func: 9, page: 0, pot: 2 } },
  { name: 'Trigger', field: 'pitchLfo.trigger', offset: 0, section: 'Pitch LFO', format: fmtLookup(LFO_TRIG_LABELS),
    edit: { type: 'select', options: LFO_TRIG_LABELS, func: 9, page: 0, pot: 3 } },
  { name: 'Level', field: 'pitchLfo.level', offset: 0, section: 'Pitch LFO',
    edit: { type: 'number', min: 0, max: 99, func: 9, page: 1, pot: 0 } },
  { name: 'Mod Wheel Mod', field: 'pitchLfo.modWheelMod', offset: -99, section: 'Pitch LFO', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 9, page: 1, pot: 1 } },
  { name: 'Aftertouch Mod', field: 'pitchLfo.aftertouchMod', offset: -99, section: 'Pitch LFO', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 9, page: 1, pot: 2 } },
  // Filter LFO
  { name: 'Waveform', field: 'filterLfo.waveform', offset: 0, section: 'Filter LFO', format: fmtLookup(LFO_WAVE_LABELS),
    edit: { type: 'select', options: LFO_WAVE_LABELS, func: 10, page: 0, pot: 0 } },
  { name: 'Speed', field: 'filterLfo.speed', offset: 0, section: 'Filter LFO',
    edit: { type: 'number', min: 0, max: 99, func: 10, page: 0, pot: 1 } },
  { name: 'Delay', field: 'filterLfo.delay', offset: 0, section: 'Filter LFO',
    edit: { type: 'number', min: 0, max: 99, func: 10, page: 0, pot: 2 } },
  { name: 'Trigger', field: 'filterLfo.trigger', offset: 0, section: 'Filter LFO', format: fmtLookup(LFO_TRIG_LABELS),
    edit: { type: 'select', options: LFO_TRIG_LABELS, func: 10, page: 0, pot: 3 } },
  { name: 'Level', field: 'filterLfo.level', offset: 0, section: 'Filter LFO',
    edit: { type: 'number', min: 0, max: 99, func: 10, page: 1, pot: 0 } },
  { name: 'Mod Wheel Mod', field: 'filterLfo.modWheelMod', offset: -99, section: 'Filter LFO', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 10, page: 1, pot: 1 } },
  { name: 'Aftertouch Mod', field: 'filterLfo.aftertouchMod', offset: -99, section: 'Filter LFO', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 10, page: 1, pot: 2 } },
  // Amp LFO
  { name: 'Waveform', field: 'ampLfo.waveform', offset: 0, section: 'Amp LFO', format: fmtLookup(LFO_WAVE_LABELS),
    edit: { type: 'select', options: LFO_WAVE_LABELS, func: 11, page: 0, pot: 0 } },
  { name: 'Speed', field: 'ampLfo.speed', offset: 0, section: 'Amp LFO',
    edit: { type: 'number', min: 0, max: 99, func: 11, page: 0, pot: 1 } },
  { name: 'Delay', field: 'ampLfo.delay', offset: 0, section: 'Amp LFO',
    edit: { type: 'number', min: 0, max: 99, func: 11, page: 0, pot: 2 } },
  { name: 'Trigger', field: 'ampLfo.trigger', offset: 0, section: 'Amp LFO', format: fmtLookup(LFO_TRIG_LABELS),
    edit: { type: 'select', options: LFO_TRIG_LABELS, func: 11, page: 0, pot: 3 } },
  { name: 'Level', field: 'ampLfo.level', offset: 0, section: 'Amp LFO',
    edit: { type: 'number', min: 0, max: 99, func: 11, page: 1, pot: 0 } },
  { name: 'Mod Wheel Mod', field: 'ampLfo.modWheelMod', offset: -99, section: 'Amp LFO', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 11, page: 1, pot: 1 } },
  { name: 'Aftertouch Mod', field: 'ampLfo.aftertouchMod', offset: -99, section: 'Amp LFO', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 11, page: 1, pot: 2 } },
  // Pitch Envelope
  { name: 'Attack', field: 'pitchEnv.attack', offset: 0, section: 'Pitch Env',
    edit: { type: 'number', min: 0, max: 99, func: 12, page: 0, pot: 0 } },
  { name: 'Decay', field: 'pitchEnv.decay', offset: 0, section: 'Pitch Env',
    edit: { type: 'number', min: 0, max: 100, func: 12, page: 0, pot: 1 } },
  { name: 'Sustain', field: 'pitchEnv.sustain', offset: 0, section: 'Pitch Env',
    edit: { type: 'number', min: 0, max: 99, func: 12, page: 0, pot: 2 } },
  { name: 'Release', field: 'pitchEnv.release', offset: 0, section: 'Pitch Env',
    edit: { type: 'number', min: 0, max: 99, func: 12, page: 0, pot: 3 } },
  { name: 'Delay', field: 'pitchEnv.delay', offset: 0, section: 'Pitch Env',
    edit: { type: 'number', min: 0, max: 99, func: 12, page: 1, pot: 0 } },
  { name: 'Sustain Decay', field: 'pitchEnv.sustainDecay', offset: 0, section: 'Pitch Env',
    edit: { type: 'number', min: 0, max: 99, func: 12, page: 1, pot: 1 } },
  { name: 'Trigger Type', field: 'pitchEnv.triggerType', offset: 0, section: 'Pitch Env', format: fmtLookup(ENV_TRIG_LABELS),
    edit: { type: 'select', options: ENV_TRIG_LABELS, func: 12, page: 1, pot: 3 } },
  { name: 'Time Track', field: 'pitchEnv.timeTrack', offset: 0, section: 'Pitch Env', format: fmtBool('On', 'Off'),
    edit: { type: 'checkbox', func: 12, page: 2, pot: 0 } },
  { name: 'Sustain Pedal', field: 'pitchEnv.sustainPedal', offset: 0, section: 'Pitch Env', format: fmtBool('On', 'Off'),
    edit: { type: 'checkbox', func: 12, page: 2, pot: 1 } },
  { name: 'Level', field: 'pitchEnv.level', offset: 0, section: 'Pitch Env',
    edit: { type: 'number', min: 0, max: 99, func: 12, page: 2, pot: 2 } },
  { name: 'Velocity Mod', field: 'pitchEnv.velocityMod', offset: -99, section: 'Pitch Env', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 12, page: 2, pot: 3 } },
  // Filter Envelope
  { name: 'Attack', field: 'filterEnv.attack', offset: 0, section: 'Filter Env',
    edit: { type: 'number', min: 0, max: 99, func: 13, page: 0, pot: 0 } },
  { name: 'Decay', field: 'filterEnv.decay', offset: 0, section: 'Filter Env',
    edit: { type: 'number', min: 0, max: 99, func: 13, page: 0, pot: 1 } },
  { name: 'Sustain', field: 'filterEnv.sustain', offset: 0, section: 'Filter Env',
    edit: { type: 'number', min: 0, max: 99, func: 13, page: 0, pot: 2 } },
  { name: 'Release', field: 'filterEnv.release', offset: 0, section: 'Filter Env',
    edit: { type: 'number', min: 0, max: 99, func: 13, page: 0, pot: 3 } },
  { name: 'Delay', field: 'filterEnv.delay', offset: 0, section: 'Filter Env',
    edit: { type: 'number', min: 0, max: 100, func: 13, page: 1, pot: 0 } },
  { name: 'Sustain Decay', field: 'filterEnv.sustainDecay', offset: 0, section: 'Filter Env',
    edit: { type: 'number', min: 0, max: 99, func: 13, page: 1, pot: 1 } },
  { name: 'Trigger Type', field: 'filterEnv.triggerType', offset: 0, section: 'Filter Env', format: fmtLookup(ENV_TRIG_LABELS),
    edit: { type: 'select', options: ENV_TRIG_LABELS, func: 13, page: 1, pot: 3 } },
  { name: 'Time Track', field: 'filterEnv.timeTrack', offset: 0, section: 'Filter Env', format: fmtBool('On', 'Off'),
    edit: { type: 'checkbox', func: 13, page: 2, pot: 0 } },
  { name: 'Sustain Pedal', field: 'filterEnv.sustainPedal', offset: 0, section: 'Filter Env', format: fmtBool('On', 'Off'),
    edit: { type: 'checkbox', func: 13, page: 2, pot: 1 } },
  { name: 'Level', field: 'filterEnv.level', offset: 0, section: 'Filter Env',
    edit: { type: 'number', min: 0, max: 99, func: 13, page: 2, pot: 2 } },
  { name: 'Velocity Mod', field: 'filterEnv.velocityMod', offset: -99, section: 'Filter Env', format: fmtSigned(-99),
    edit: { type: 'number', min: -99, max: 100, func: 13, page: 2, pot: 3 } },
  // Amp Envelope
  { name: 'Attack', field: 'ampEnv.attack', offset: 0, section: 'Amp Env',
    edit: { type: 'number', min: 0, max: 99, func: 14, page: 0, pot: 0 } },
  { name: 'Decay', field: 'ampEnv.decay', offset: 0, section: 'Amp Env',
    edit: { type: 'number', min: 0, max: 99, func: 14, page: 0, pot: 1 } },
  { name: 'Sustain', field: 'ampEnv.sustain', offset: 0, section: 'Amp Env',
    edit: { type: 'number', min: 0, max: 99, func: 14, page: 0, pot: 2 } },
  { name: 'Release', field: 'ampEnv.release', offset: 0, section: 'Amp Env',
    edit: { type: 'number', min: 0, max: 99, func: 14, page: 0, pot: 3 } },
  { name: 'Delay', field: 'ampEnv.delay', offset: 0, section: 'Amp Env',
    edit: { type: 'number', min: 0, max: 100, func: 14, page: 1, pot: 0 } },
  { name: 'Sustain Decay', field: 'ampEnv.sustainDecay', offset: 0, section: 'Amp Env',
    edit: { type: 'number', min: 0, max: 99, func: 14, page: 1, pot: 1 } },
  { name: 'Trigger Type', field: 'ampEnv.triggerType', offset: 0, section: 'Amp Env', format: fmtLookup(ENV_TRIG_LABELS),
    edit: { type: 'select', options: ENV_TRIG_LABELS, func: 14, page: 1, pot: 3 } },
  { name: 'Time Track', field: 'ampEnv.timeTrack', offset: 0, section: 'Amp Env', format: fmtBool('On', 'Off'),
    edit: { type: 'checkbox', func: 14, page: 2, pot: 0 } },
  { name: 'Sustain Pedal', field: 'ampEnv.sustainPedal', offset: 0, section: 'Amp Env', format: fmtBool('On', 'Off'),
    edit: { type: 'checkbox', func: 14, page: 2, pot: 1 } },
  { name: 'Level', field: 'ampEnv.level', offset: 0, section: 'Amp Env',
    edit: { type: 'number', min: 0, max: 99, func: 14, page: 2, pot: 2 } },
  // Tracking Generator
  { name: 'Input', field: 'tracking.input', offset: 0, section: 'Tracking', format: fmtLookup(MOD_SOURCES.slice(0, 23)),
    edit: { type: 'select', options: MOD_SOURCES.slice(0, 23), func: 15, page: 0, pot: 0 } },
  ...Array.from({ length: 11 }, (_, i) => ({
    name: `Point ${i}`, field: `tracking.points.${i}`, offset: 0, section: 'Tracking',
    edit: { type: 'number', min: 0, max: 100, func: 15, page: Math.floor((i + 1) / 4), pot: (i + 1) % 4 },
  })),
];

const DRUM_PAN_LABELS = ['Left 3', 'Left 2', 'Left 1', 'Center', 'Right 1', 'Right 2', 'Right 3'];

const DRUM_PARAMS = [
  { name: 'Sample', field: 'sample', offset: 0,
    edit: { type: 'drumSample', groupFunc: 0, groupPage: 0, groupPot: 0, numFunc: 0, numPage: 0, numPot: 2 } },
  { name: 'Volume', field: 'volume', offset: 0,
    edit: { type: 'number', min: 0, max: 31, func: 1, page: 0, pot: 0 } },
  { name: 'Pan', field: 'pan', offset: 0, format: fmtLookup(DRUM_PAN_LABELS),
    edit: { type: 'select', options: DRUM_PAN_LABELS, func: 1, page: 0, pot: 1 } },
  { name: 'Output', field: 'output', offset: 0, format: fmtLookup(OUTPUT_LABELS),
    edit: { type: 'select', options: OUTPUT_LABELS, func: 1, page: 0, pot: 2 } },
  { name: 'Effect Level', field: 'effectLevel', offset: 0,
    edit: { type: 'number', min: 0, max: 63, func: 2, page: 0, pot: 0 } },
  { name: 'Effect Bus', field: 'effectBus', offset: 0, format: fmtLookup(EFFECT_BUS_LABELS),
    edit: { type: 'select', options: EFFECT_BUS_LABELS, func: 2, page: 0, pot: 1 } },
  { name: 'Pitch', field: 'pitch', offset: -48, format: fmtSigned(-48),
    edit: { type: 'number', min: -48, max: 49, func: 3, page: 0, pot: 0 } },
  { name: 'Pitch Vel Mod', field: 'pitchVelMod', offset: 0,
    edit: { type: 'number', min: 0, max: 7, func: 3, page: 0, pot: 1 } },
  { name: 'Filter Vel Mod', field: 'filterVelMod', offset: 0,
    edit: { type: 'number', min: 0, max: 3, func: 4, page: 0, pot: 0 } },
  { name: 'Velocity Curve', field: 'velocityCurve', offset: 0, format: fmtLookup(VEL_CURVE_LABELS),
    edit: { type: 'select', options: VEL_CURVE_LABELS, func: 5, page: 0, pot: 0 } },
  { name: 'Note Number', field: 'noteNumber', offset: 0, format: fmtNote,
    edit: { type: 'note', min: 0, max: 127, func: 6, page: 0, pot: 0 } },
  { name: 'Amp Env Decay', field: 'ampEnvDecay', offset: 0,
    edit: { type: 'number', min: 0, max: 127, func: 8, page: 0, pot: 0 } },
  { name: 'Mute Group', field: 'muteGroup', offset: 0,
    edit: { type: 'number', min: 0, max: 3, func: 8, page: 0, pot: 1 } },
  { name: 'Note Range', field: 'noteRange', offset: 0,
    edit: { type: 'number', min: 0, max: 3, func: 6, page: 0, pot: 2 } },
];

const ROM_ID_LABELS = ['QS+/S4+', 'QS', 'Reserved', 'Reserved'];

const EFFECT_CONFIG_LABELS = [
  '0: 4-Sends, 1 Reverb',
  '1: 4-Sends, 2 Reverb',
  '2: 4-Sends, 1 Lezlie',
  '3: 2-Sends, with EQ',
  '4: Overdrive + Lezlie',
];

let currentEditProgram = null;

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function noteName(v) {
  return `${NOTE_NAMES[v % 12]}${Math.floor(v / 12) - 2}`;
}

function buildSampleOptions(groups, voices) {
  let html = '<option value="0|0">OFF</option>';
  for (let g = 0; g < groups.length; g++) {
    const vList = voices[g];
    if (!vList || !vList.length) continue;
    html += `<optgroup label="${escapeHTML(groups[g])}">`;
    for (let v = 0; v < vList.length; v++) {
      html += `<option value="${g}|${v + 1}">${escapeHTML(vList[v])}</option>`;
    }
    html += '</optgroup>';
  }
  return html;
}

function renderControl(p, raw, dataAttrs) {
  const e = p.edit;
  if (!e) {
    const val = p.format ? p.format(raw) : (p.offset ? String(raw + p.offset) : String(raw));
    return escapeHTML(String(val));
  }
  const attrs = dataAttrs || '';
  if (e.type === 'number') {
    const display = raw + (p.offset || 0);
    return `<input type="number" class="prog-edit" ${attrs} data-field="${p.field}" data-offset="${p.offset || 0}" ` +
      `data-func="${e.func}" data-page="${e.page}" data-pot="${e.pot}" ` +
      `min="${e.min}" max="${e.max}" value="${display}">`;
  }
  if (e.type === 'note') {
    return `<input type="number" class="prog-edit" ${attrs} data-field="${p.field}" data-offset="0" ` +
      `data-func="${e.func}" data-page="${e.page}" data-pot="${e.pot}" ` +
      `min="${e.min}" max="${e.max}" value="${raw}">` +
      `<span class="note-label">${noteName(raw)}</span>`;
  }
  if (e.type === 'checkbox') {
    return `<input type="checkbox" class="prog-edit" ${attrs} data-field="${p.field}" data-offset="0" ` +
      `data-func="${e.func}" data-page="${e.page}" data-pot="${e.pot}" ` +
      `${raw ? 'checked' : ''}>`;
  }
  if (e.type === 'select') {
    let html = `<select class="prog-edit" ${attrs} data-field="${p.field}" data-offset="0" ` +
      `data-func="${e.func}" data-page="${e.page}" data-pot="${e.pot}">`;
    for (let i = 0; i < e.options.length; i++) {
      html += `<option value="${i}"${i === raw ? ' selected' : ''}>${escapeHTML(e.options[i])}</option>`;
    }
    html += '</select>';
    return html;
  }
  return escapeHTML(String(raw));
}

function renderSectionBlock(label, rowsHtml) {
  return `<div class="prog-info-section-block"><table class="globals-table"><tbody>` +
    `<tr class="prog-info-subsection"><td colspan="2">${escapeHTML(label)}</td></tr>` +
    rowsHtml +
    `</tbody></table></div>`;
}

function defaultKeyboard() {
  return {
    sample: { group: 0, number: 0 },
    level: { volume: 99, pan: 0, output: 0, effectLevel: 0, effectBus: 0 },
    pitch: { semitone: 0, detune: 0, detuneType: 0, pitchWheelMod: 0, aftertouchMod: 0, lfoMod: 0, envMod: 0, portamentoMode: 0, portamentoRate: 0, keyMode: 0 },
    filter: { frequency: 0, keyboardTrack: 0, velocityMod: 0, pitchWheelMod: 0, aftertouchMod: 0, lfoMod: 0, envMod: 0 },
    amp: { velocityCurve: 0, aftertouchMod: 0, lfoMod: 0 },
    noteRange: { lowNote: 0, highNote: 127, overlap: 0 },
    mods: Array.from({ length: 6 }, () => ({ source: 0, destination: 0, amplitude: 0, gate: 0 })),
    pitchLfo: { waveform: 0, speed: 0, delay: 0, trigger: 0, level: 0, modWheelMod: 0, aftertouchMod: 0 },
    filterLfo: { waveform: 0, speed: 0, delay: 0, trigger: 0, level: 0, modWheelMod: 0, aftertouchMod: 0 },
    ampLfo: { waveform: 0, speed: 0, delay: 0, trigger: 0, level: 0, modWheelMod: 0, aftertouchMod: 0 },
    pitchEnv: { attack: 0, decay: 0, sustain: 0, release: 0, delay: 0, sustainDecay: 0, triggerType: 0, timeTrack: 0, sustainPedal: 0, level: 0, velocityMod: 0 },
    filterEnv: { attack: 0, decay: 0, sustain: 0, release: 0, delay: 0, sustainDecay: 0, triggerType: 0, timeTrack: 0, sustainPedal: 0, level: 0, velocityMod: 0 },
    ampEnv: { attack: 0, decay: 0, sustain: 99, release: 0, delay: 0, sustainDecay: 0, triggerType: 0, timeTrack: 0, sustainPedal: 0, level: 0 },
    tracking: { input: 0, points: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }
  };
}

function defaultDrums() {
  return Array.from({ length: 10 }, () => ({
    sampleGroup: 0, sampleNumber: 0, volume: 0, pan: 0, output: 0,
    effectLevel: 0, effectBus: 0, pitch: 0, pitchVelMod: 0, filterVelMod: 0,
    velocityCurve: 0, noteNumber: 0, ampEnvDecay: 0, muteGroup: 0, noteRange: 0
  }));
}

function renderKeyboardSound(keyboard, soundIndex) {
  const si = `data-sound="${soundIndex}"`;
  // Sample dropdown
  const sampleVal = `${keyboard.sample.group}|${keyboard.sample.number}`;
  const sampleOpts = buildSampleOptions(KEYBOARD_GROUPS, KEYBOARD_VOICES);
  let sampleHtml = `<select class="prog-edit" ${si} data-field="sample" data-offset="0" ` +
    `data-func="0" data-page="0" data-pot="0">${sampleOpts}</select>`;
  // Set selected via script after render (value includes pipe)
  const sampleScript = `<script-data data-sample-select="${soundIndex}" data-val="${sampleVal}"></script-data>`;

  let html = renderSectionBlock('Sample',
    `<tr><td>Sample</td><td>${sampleHtml}${sampleScript}</td></tr>`);

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
    rows += `<tr><td>${escapeHTML(p.name)}</td><td>${renderControl(p, raw, si)}</td></tr>`;
  }
  if (currentSection) {
    html += renderSectionBlock(currentSection, rows);
  }
  return html;
}

function renderDrumSound(drums, soundIndex) {
  let html = '';
  for (let d = 0; d < drums.length; d++) {
    const drum = drums[d];
    const drumName = getDrumSampleName(drum.sampleGroup, drum.sampleNumber);
    const da = `data-sound="${soundIndex}" data-drum="${d}"`;
    let rows = '';

    // Drum sample dropdown
    const sampleVal = `${drum.sampleGroup}|${drum.sampleNumber}`;
    const sampleOpts = buildSampleOptions(DRUM_GROUPS, DRUM_VOICES);
    let sampleHtml = `<select class="prog-edit" ${da} data-field="sample" data-offset="0" ` +
      `data-func="0" data-page="0" data-pot="0">${sampleOpts}</select>`;
    const sampleScript = `<script-data data-drum-sample-select="${soundIndex}-${d}" data-val="${sampleVal}"></script-data>`;
    rows += `<tr><td>Sample</td><td>${sampleHtml}${sampleScript}</td></tr>`;

    for (const p of DRUM_PARAMS) {
      if (p.edit && p.edit.type === 'drumSample') continue;
      const raw = drum[p.field];
      rows += `<tr><td>${escapeHTML(p.name)}</td><td>${renderControl(p, raw, da)}</td></tr>`;
    }
    html += renderSectionBlock(`Drum ${d + 1} — ${escapeHTML(drumName)}`, rows);
  }
  return html;
}

function camelToTitle(s) {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2')
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
          .replace(/^./, c => c.toUpperCase());
}

function renderEffect(effect) {
  let html = renderSectionBlock('Configuration',
    `<tr><td>Type</td><td>${EFFECT_CONFIG_LABELS[effect.configuration] || String(effect.configuration)}</td></tr>`);

  for (let s = 1; s <= 4; s++) {
    const send = effect[`send${s}`];
    if (!send) continue;
    for (const [blockName, block] of Object.entries(send)) {
      if (typeof block !== 'object' || block === null) continue;
      let rows = '';
      for (const [key, val] of Object.entries(block)) {
        if (val === undefined) continue;
        rows += `<tr><td>${escapeHTML(camelToTitle(key))}</td><td>${escapeHTML(String(val))}</td></tr>`;
      }
      if (rows) {
        html += renderSectionBlock(`Send ${s} ${camelToTitle(blockName)}`, rows);
      }
    }
  }

  if (effect.eq && typeof effect.eq === 'object') {
    let rows = '';
    for (const [key, val] of Object.entries(effect.eq)) {
      if (val === undefined) continue;
      rows += `<tr><td>${escapeHTML(camelToTitle(key))}</td><td>${escapeHTML(String(val))}</td></tr>`;
    }
    if (rows) html += renderSectionBlock('Equalizer', rows);
  }

  if (effect.mod && typeof effect.mod === 'object') {
    let rows = '';
    for (const [key, val] of Object.entries(effect.mod)) {
      if (val === undefined) continue;
      const displayVal = key.startsWith('level') ? fmtSigned(-99)(val) : String(val);
      rows += `<tr><td>${escapeHTML(camelToTitle(key))}</td><td>${escapeHTML(displayVal)}</td></tr>`;
    }
    if (rows) html += renderSectionBlock('Modulation', rows);
  }

  return html;
}

function renderProgInfo(program) {
  currentEditProgram = program;

  // Common section
  let html = '<table class="globals-table"><tbody>';
  html += `<tr><td>Program Name</td><td><input type="text" class="prog-edit-name" maxlength="10" value="${escapeHTML(program.name)}"></td></tr>`;
  const romOpts = ROM_ID_LABELS.map((label, i) =>
    `<option value="${i}"${i === program.romId ? ' selected' : ''}>${escapeHTML(label)}</option>`
  ).join('');
  html += `<tr><td>ROM ID</td><td><select class="prog-edit-rom">${romOpts}</select></td></tr>`;
  html += '</tbody></table>';

  // Tab bar
  html += '<div class="prog-info-tabs">';
  for (let s = 0; s < 4; s++) {
    const snd = program.sounds[s];
    const label = `Sound ${s + 1}`;
    const active = s === 0 ? ' active' : '';
    html += `<button class="prog-info-tab${active}" data-tab="${s}">${label}</button>`;
  }
  html += `<button class="prog-info-tab" data-tab="fx">Effects</button>`;
  html += '</div>';

  // Tab panels
  for (let s = 0; s < 4; s++) {
    const snd = program.sounds[s];
    const active = s === 0 ? ' active' : '';
    html += `<div class="prog-info-panel${active}" data-panel="${s}">`;
    // Sound enable checkbox + mode dropdown
    html += `<div class="sound-enable-row">` +
      `<label class="sound-enable-label"><input type="checkbox" class="prog-edit-enable" ` +
      `data-sound="${s}" ${snd.enabled ? 'checked' : ''}> Enabled</label>` +
      `<select class="prog-edit-mode" data-sound="${s}">` +
      `<option value="keyboard"${!snd.isDrum ? ' selected' : ''}>Keyboard</option>` +
      `<option value="drum"${snd.isDrum ? ' selected' : ''}>Drum</option></select>` +
      `</div>`;
    html += `<div class="prog-info-sections sound-content"${!snd.enabled ? ' style="display:none"' : ''}>`;
    if (snd.isDrum) {
      html += renderDrumSound(snd.drums, s);
    } else {
      html += renderKeyboardSound(snd.keyboard, s);
    }
    html += '</div>';
    html += '</div>';
  }

  // Effects panel
  html += `<div class="prog-info-panel" data-panel="fx">`;
  html += '<div class="prog-info-sections">';
  html += renderEffect(program.effect);
  html += '</div></div>';

  progInfoBody.innerHTML = html;

  // Set sample dropdown selected values (can't set pipe-containing values via HTML attr)
  progInfoBody.querySelectorAll('script-data[data-sample-select]').forEach(el => {
    const select = el.previousElementSibling;
    if (select) select.value = el.dataset.val;
  });
  progInfoBody.querySelectorAll('script-data[data-drum-sample-select]').forEach(el => {
    const select = el.previousElementSibling;
    if (select) select.value = el.dataset.val;
  });

  // Wire up tab switching
  progInfoBody.querySelectorAll('.prog-info-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      progInfoBody.querySelector('.prog-info-tab.active')?.classList.remove('active');
      progInfoBody.querySelector('.prog-info-panel.active')?.classList.remove('active');
      tab.classList.add('active');
      progInfoBody.querySelector(`.prog-info-panel[data-panel="${tab.dataset.tab}"]`)?.classList.add('active');
    });
  });

  // Wire up program name editing
  const nameInput = progInfoBody.querySelector('.prog-edit-name');
  if (nameInput) {
    nameInput.addEventListener('change', () => {
      if (!activeDevice || !currentEditProgram) return;
      const name = nameInput.value.padEnd(10).slice(0, 10);
      currentEditProgram.name = name.trim();
      const out = activeDevice.device.output;
      // Drum sounds use func 7 for name digits, keyboard sounds use func 8
      const nameFunc = currentEditProgram.sounds[0].isDrum ? 7 : 8;
      for (let i = 0; i < 10; i++) {
        const charVal = name.charCodeAt(i) - 32;
        sendParamEdit(out, 2, nameFunc, 0, i, 0, 0, charVal);
      }
    });
  }

  // Wire up ROM ID editing
  const romSelect = progInfoBody.querySelector('.prog-edit-rom');
  if (romSelect) {
    romSelect.addEventListener('change', () => {
      if (!currentEditProgram) return;
      currentEditProgram.romId = Number(romSelect.value);
    });
  }

  // Wire up sound enable checkboxes
  progInfoBody.querySelectorAll('.prog-edit-enable').forEach(cb => {
    cb.addEventListener('change', () => {
      if (!activeDevice || !currentEditProgram) return;
      const s = Number(cb.dataset.sound);
      const snd = currentEditProgram.sounds[s];
      snd.enabled = cb.checked;
      const out = activeDevice.device.output;
      const func = snd.isDrum ? 9 : 16;
      sendParamEdit(out, 2, func, s, 0, 0, 3, cb.checked ? 1 : 0);
      // Toggle content visibility
      const panel = cb.closest('.prog-info-panel');
      const content = panel?.querySelector('.sound-content');
      if (content) content.style.display = cb.checked ? '' : 'none';
    });
  });

  // Wire up mode dropdowns
  progInfoBody.querySelectorAll('.prog-edit-mode').forEach(sel => {
    sel.addEventListener('change', () => {
      if (!activeDevice || !currentEditProgram) return;
      const s = Number(sel.dataset.sound);
      const snd = currentEditProgram.sounds[s];
      const newIsDrum = sel.value === 'drum';
      if (newIsDrum === snd.isDrum) return;

      // Update model
      snd.isDrum = newIsDrum;
      if (newIsDrum && !snd.drums) {
        snd.drums = defaultDrums();
        delete snd.keyboard;
      } else if (!newIsDrum && !snd.keyboard) {
        snd.keyboard = defaultKeyboard();
        delete snd.drums;
      }

      // Send SysEx mode change
      const out = activeDevice.device.output;
      const func = newIsDrum ? 9 : 16;
      sendParamEdit(out, 2, func, s, 0, 0, 0, newIsDrum ? 1 : 0);

      // Re-send enable with correct func for new mode
      sendParamEdit(out, 2, func, s, 0, 0, 3, snd.enabled ? 1 : 0);

      // Re-render the sound content
      const panel = sel.closest('.prog-info-panel');
      const content = panel.querySelector('.sound-content');
      content.innerHTML = newIsDrum
        ? renderDrumSound(snd.drums, s)
        : renderKeyboardSound(snd.keyboard, s);

      // Re-set sample dropdown values (pipe workaround)
      content.querySelectorAll('script-data[data-sample-select]').forEach(el => {
        const select = el.previousElementSibling;
        if (select) select.value = el.dataset.val;
      });
      content.querySelectorAll('script-data[data-drum-sample-select]').forEach(el => {
        const select = el.previousElementSibling;
        if (select) select.value = el.dataset.val;
      });
    });
  });

  // Delegated change handler for all param controls
  progInfoBody.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.classList.contains('prog-edit')) return;
    if (!activeDevice || !currentEditProgram) return;

    const out = activeDevice.device.output;
    const soundIdx = Number(el.dataset.sound);
    const snd = currentEditProgram.sounds[soundIdx];
    const field = el.dataset.field;
    const offset = Number(el.dataset.offset) || 0;
    const func = Number(el.dataset.func);
    const page = Number(el.dataset.page);
    const pot = Number(el.dataset.pot);
    const drumIdx = el.dataset.drum !== undefined ? Number(el.dataset.drum) : -1;

    // Determine raw value based on control type
    let rawVal, displayVal;
    if (el.type === 'checkbox') {
      rawVal = el.checked ? 1 : 0;
    } else if (el.tagName === 'SELECT' && field === 'sample') {
      // Keyboard or drum sample dropdown
      const [g, n] = el.value.split('|').map(Number);
      if (drumIdx >= 0) {
        snd.drums[drumIdx].sampleGroup = g;
        snd.drums[drumIdx].sampleNumber = n;
        // For drums: set drum number first, then send group and number
        sendParamEdit(out, 2, 0, soundIdx, 0, 0, 3, drumIdx); // drum number select
        sendParamEdit(out, 2, 0, soundIdx, 0, 0, 0, g); // group
        sendParamEdit(out, 2, 0, soundIdx, 0, 0, 2, n); // number
      } else {
        setNestedField(snd.keyboard, 'sample.group', g);
        setNestedField(snd.keyboard, 'sample.number', n);
        sendParamEdit(out, 2, 0, soundIdx, 0, 0, 0, g);
        sendParamEdit(out, 2, 0, soundIdx, 0, 0, 2, n);
      }
      return; // sample is handled completely
    } else {
      displayVal = Number(el.value);
      rawVal = displayVal - offset;
    }

    // Update model
    if (drumIdx >= 0) {
      snd.drums[drumIdx][field] = rawVal;
    } else if (snd.keyboard) {
      setNestedField(snd.keyboard, field, rawVal);
    }

    // For note fields, update the label
    if (el.dataset.func !== undefined && el.nextElementSibling?.classList.contains('note-label')) {
      el.nextElementSibling.textContent = noteName(rawVal);
    }

    // SysEx parameter edit expects display values in 2's complement
    let midiVal = el.type === 'checkbox' ? rawVal : displayVal;
    if (midiVal < 0) midiVal += 256;

    // For drums: send drum number first
    if (drumIdx >= 0) {
      sendParamEdit(out, 2, 0, soundIdx, 0, 0, 3, drumIdx);
    }
    sendParamEdit(out, 2, func, soundIdx, page, 0, pot, midiVal & 0xFF);
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
    await putProgram(currentBank, currentPatch, program);
    await loadUserBankCache();
  } catch {
    progInfoBody.innerHTML = '<p class="globals-loading">Failed to read program data.</p>';
  }
}

function closeProgInfo() {
  progInfoModal.classList.add('hidden');
  currentEditProgram = null;
}

editBufBtn.addEventListener('click', async () => {
  if (!activeDevice) return;
  if (currentMode === 'mix') {
    mixInfoModal.classList.remove('hidden');
    mixInfoBody.innerHTML = '<p class="globals-loading">Requesting edit buffer...</p>';
    try {
      const mix = await readEditMix(activeDevice.device.output, activeDevice.device.input);
      renderMixInfo(mix);
      await putMix(currentBank, currentPatch, mix);
      await loadUserBankCache();
    } catch {
      mixInfoBody.innerHTML = '<p class="globals-loading">Failed to read edit buffer.</p>';
    }
  } else {
    progInfoModal.classList.remove('hidden');
    progInfoBody.innerHTML = '<p class="globals-loading">Requesting edit buffer...</p>';
    try {
      const program = await readEditProgram(activeDevice.device.output, activeDevice.device.input);
      renderProgInfo(program);
      await putProgram(currentBank, currentPatch, program);
      await loadUserBankCache();
    } catch {
      progInfoBody.innerHTML = '<p class="globals-loading">Failed to read edit buffer.</p>';
    }
  }
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
    await putMix(currentBank, currentPatch, mix);
    await loadUserBankCache();
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
        case 0x06: { // User Effects
          const eff = Effect.fromSysex(msg);
          effects.push({ num, configuration: eff.configuration, effect: eff });
          break;
        }
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
        html += '<table class="globals-table"><thead><tr><th>#</th><th>Config</th></tr></thead><tbody>';
        for (const e of parsed.effects) {
          html += `<tr><td>${String(e.num).padStart(3, '0')}</td><td>${e.configuration}</td></tr>`;
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
    logSend(msgs[i]);
    activeDevice.device.output.send(msgs[i]);
    if (i < msgs.length - 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Cache sent programs and mixes to IndexedDB (SysEx files target User bank)
  for (const p of currentSyxParsed.programs) {
    await putProgram(0, p.num, p.program);
  }
  const mixes = currentSyxParsed.newMixes.length > 0 ? currentSyxParsed.newMixes : currentSyxParsed.oldMixes;
  for (const m of mixes) {
    await putMix(0, m.num, m.mix);
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
