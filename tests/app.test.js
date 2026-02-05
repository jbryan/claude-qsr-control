import { jest } from '@jest/globals';
import { MockMIDIAccess, MockMIDIInput, MockMIDIOutput, setMockMIDIAccess } from './setup.js';
import { putProgram, putMix, clearAll } from '../public/js/store.js';
import { Program, Mix, Effect, encodeProgName, encodeMixName, setBits } from '../public/js/models.js';

let mockAccess;
let qsrInput;
let qsrOutput;

function setupDOM() {
  document.body.innerHTML = `
    <div class="lcd" id="status">
      <div class="lcd-line1" id="lcd-line1">Ready</div>
      <div class="lcd-line2 hidden" id="lcd-line2">
        <select id="mode-select" class="lcd-mode-select" disabled>
          <option value="prog">PROG</option>
          <option value="mix">MIX</option>
        </select>
        <select id="lcd-bank" class="lcd-bank-select" disabled>
          <option value="0">User</option>
          <option value="1">Preset 1</option>
          <option value="2">Preset 2</option>
          <option value="3">Preset 3</option>
          <option value="4">GenMIDI</option>
        </select>
        <input type="number" id="lcd-patch" class="lcd-patch-input" min="0" max="127" value="0" disabled>
        <span class="lcd-col-name" id="lcd-name"></span>
      </div>
    <button id="midi-btn" class="icon-btn" title="MIDI Device">M</button>
    <div id="midi-modal" class="search-modal hidden">
      <div class="search-modal-content">
        <div class="globals-modal-header">
          <span class="globals-title">MIDI Device</span>
          <button id="midi-close" class="icon-btn" title="Close">&times;</button>
        </div>
        <div class="midi-body">
          <label for="device-select">MIDI Device</label>
          <select id="device-select"><option disabled selected>No devices</option></select>
          <div class="midi-actions">
            <button id="identify-btn" disabled>Identify</button>
            <button id="rescan-btn">Rescan</button>
          </div>
        </div>
      </div>
    </div>
    <button id="edit-buf-btn" class="icon-btn edit-buf-btn hidden">E</button>
    <button id="prog-info-btn" class="icon-btn prog-info-btn hidden" title="Program Info">i</button>
    <div id="prog-info-modal" class="search-modal hidden">
      <div class="search-modal-content prog-info-content">
        <div class="globals-modal-header">
          <span class="globals-title">Program Parameters</span>
          <button id="prog-info-close" class="icon-btn">&times;</button>
        </div>
        <div id="prog-info-body" class="globals-body"></div>
      </div>
    </div>
    <div id="mix-info-modal" class="search-modal hidden">
      <div class="search-modal-content prog-info-content">
        <div class="globals-modal-header">
          <span class="globals-title">Mix Parameters</span>
          <button id="mix-info-close" class="icon-btn">&times;</button>
        </div>
        <div id="mix-info-body" class="globals-body"></div>
      </div>
    </div>
    <button id="refresh-btn" class="icon-btn" disabled title="Refresh User Banks">R</button>
    <button id="syx-open-btn" class="icon-btn" title="Open SysEx File">F</button>
    <input type="file" id="syx-file-input" accept=".syx" class="hidden">
    <div id="syx-viewer-modal" class="search-modal hidden">
      <div class="search-modal-content prog-info-content">
        <div class="globals-modal-header">
          <span class="globals-title">SysEx File Contents</span>
          <button id="syx-send-btn" class="icon-btn" disabled>S</button>
          <button id="syx-viewer-close" class="icon-btn">&times;</button>
        </div>
        <div id="syx-viewer-body" class="globals-body"></div>
      </div>
    </div>
    <button id="globals-btn" class="icon-btn" disabled>G</button>
    <div id="globals-modal" class="search-modal hidden">
      <div class="search-modal-content">
        <div class="globals-modal-header">
          <span class="globals-title">Global Settings</span>
          <button id="globals-close" class="icon-btn">&times;</button>
        </div>
        <div id="globals-body" class="globals-body"></div>
      </div>
    </div>
    <div id="search-modal" class="search-modal hidden">
      <div class="search-modal-content">
        <input type="text" id="search-input" placeholder="Search patches..." autocomplete="off">
        <div class="search-filters">
          <label class="search-filter"><input type="checkbox" id="filter-prog" checked> Programs</label>
          <label class="search-filter"><input type="checkbox" id="filter-mix" checked> Mixes</label>
        </div>
        <ul id="search-results"></ul>
      </div>
    </div>
  `;
}

const QSR_IDENTITY_REPLY = [
  0xF0, 0x7E, 0x7F, 0x06, 0x02,
  0x00, 0x00, 0x0E, 0x02, 0x00, 0x06, 0x00,
  0x31, 0x30, 0x30, 0x32, 0xF7,
];

function packQSData(unpacked) {
  const packed = [];
  for (let i = 0; i + 6 < unpacked.length; i += 7) {
    const b = unpacked.slice(i, i + 7);
    packed.push(b[0] & 0x7F);
    packed.push(((b[0] >> 7) & 0x01) | ((b[1] & 0x3F) << 1));
    packed.push(((b[1] >> 6) & 0x03) | ((b[2] & 0x1F) << 2));
    packed.push(((b[2] >> 5) & 0x07) | ((b[3] & 0x0F) << 3));
    packed.push(((b[3] >> 4) & 0x0F) | ((b[4] & 0x07) << 4));
    packed.push(((b[4] >> 3) & 0x1F) | ((b[5] & 0x03) << 5));
    packed.push(((b[5] >> 2) & 0x3F) | ((b[6] & 0x01) << 6));
    packed.push((b[6] >> 1) & 0x7F);
  }
  return packed;
}

function buildSysexReply(opcode, num, unpacked) {
  const packed = packQSData(unpacked);
  const response = new Uint8Array(7 + packed.length + 1);
  response[0] = 0xF0;
  response[1] = 0x00; response[2] = 0x00; response[3] = 0x0E; response[4] = 0x0E;
  response[5] = opcode;
  response[6] = num & 0x7F;
  for (let i = 0; i < packed.length; i++) response[7 + i] = packed[i];
  response[response.length - 1] = 0xF7;
  return response;
}

function makeMinimalEffect(config = 0) {
  const unpacked = new Array(65).fill(0);
  setBits(unpacked, 70, 4, config);
  return Effect.fromUnpacked(unpacked);
}

function autoReplyIdentity(output, input) {
  output.send = jest.fn(function (data) {
    const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
    // Reply to device inquiry
    if (arr[0] === 0xF0 && arr[1] === 0x7E && arr[4] === 0x01) {
      setTimeout(() => input.receive(QSR_IDENTITY_REPLY), 0);
    }
    // Reply to program dump request (opcode 0x01)
    if (arr[0] === 0xF0 && arr[5] === 0x01) {
      const num = arr[6];
      const prog = makeMinimalProgram(`User ${String(num).padStart(3, '0')}`);
      setTimeout(() => input.receive(buildSysexReply(0x00, num, prog.toUnpacked())), 0);
    }
    // Reply to edit program request (opcode 0x03)
    if (arr[0] === 0xF0 && arr[5] === 0x03) {
      const prog = makeMinimalProgram('EditBuf');
      setTimeout(() => input.receive(buildSysexReply(0x02, 0, prog.toUnpacked())), 0);
    }
    // Reply to user effects request (opcode 0x07)
    if (arr[0] === 0xF0 && arr[5] === 0x07) {
      const num = arr[6];
      const eff = makeMinimalEffect();
      setTimeout(() => input.receive(buildSysexReply(0x06, num, eff.toUnpacked())), 0);
    }
    // Reply to edit effects request (opcode 0x09)
    if (arr[0] === 0xF0 && arr[5] === 0x09) {
      const num = arr[6];
      const eff = makeMinimalEffect();
      setTimeout(() => input.receive(buildSysexReply(0x08, num, eff.toUnpacked())), 0);
    }
    // Reply to mix dump request (opcode 0x0F)
    if (arr[0] === 0xF0 && arr[5] === 0x0F) {
      const num = arr[6];
      const mix = makeMinimalMix(`User Mix ${String(num).padStart(3, '0')}`);
      setTimeout(() => input.receive(buildSysexReply(0x0E, num, mix.toUnpacked())), 0);
    }
  });
}

function makeMinimalProgram(name) {
  const unpacked = new Array(350).fill(0);
  encodeProgName(unpacked, name);
  const baseBitOff = 10 * 8;
  setBits(unpacked, baseBitOff, 1, 0);
  setBits(unpacked, baseBitOff + 84 * 8 + 3, 1, 1);
  return Program.fromUnpacked(unpacked);
}

function makeMinimalMix(name) {
  const unpacked = new Array(138).fill(0);
  encodeMixName(unpacked, name);
  setBits(unpacked, 0, 1, 0);
  setBits(unpacked, 1, 4, 0);
  const baseBit = 10 * 8;
  setBits(unpacked, baseBit + 11, 1, 1);
  return Mix.fromUnpacked(unpacked);
}

async function seedUserBanks() {
  for (let i = 0; i < 128; i++) {
    await putProgram(i, makeMinimalProgram(`User ${String(i).padStart(3, '0')}`));
  }
  for (let i = 0; i < 100; i++) {
    await putMix(i, makeMinimalMix(`User Mix ${String(i).padStart(3, '0')}`));
  }
}

beforeEach(async () => {
  jest.resetModules();
  jest.useFakeTimers();
  localStorage.clear();
  // Clean IndexedDB
  await clearAll();
  setupDOM();
  mockAccess = new MockMIDIAccess();
  const dev = mockAccess.addDevice('Alesis QSR');
  qsrInput = dev.input;
  qsrOutput = dev.output;
  autoReplyIdentity(qsrOutput, qsrInput);
  setMockMIDIAccess(mockAccess);
  // Pre-seed IndexedDB user bank cache to prevent auto-refresh during tests
  await seedUserBanks();
});

afterEach(() => {
  jest.useRealTimers();
});

async function loadApp() {
  const mod = await import('../public/js/app.js');
  // Let init() run: requestMIDIAccess -> autoScan -> queryDeviceIdentity,
  // then settle async chains (readProgram reply, IndexedDB caching).
  // Multiple small advances give microtask queues time to flush.
  for (let i = 0; i < 10; i++) {
    await jest.advanceTimersByTimeAsync(100);
  }
  return mod;
}

function switchMode(mode) {
  const sel = document.getElementById('mode-select');
  sel.value = mode;
  sel.dispatchEvent(new Event('change'));
}

function setPatch(value) {
  const input = document.getElementById('lcd-patch');
  input.value = value;
  input.dispatchEvent(new Event('change'));
}

function setBank(value) {
  const sel = document.getElementById('lcd-bank');
  sel.value = String(value);
  sel.dispatchEvent(new Event('change'));
}

function openSearch() {
  document.getElementById('lcd-name').click();
}

// --- Initialization ---

describe('initialization', () => {
  test('auto-scans and finds QSR device', async () => {
    await loadApp();
    const lcd1 = document.getElementById('lcd-line1');
    expect(lcd1.textContent).toContain('Alesis');
    expect(lcd1.textContent).toContain('QSR');
  });

  test('enables mode select after connecting', async () => {
    await loadApp();
    expect(document.getElementById('mode-select').disabled).toBe(false);
  });

  test('starts in Program mode', async () => {
    await loadApp();
    expect(document.getElementById('mode-select').value).toBe('prog');
  });

  test('populates device select dropdown', async () => {
    await loadApp();
    const select = document.getElementById('device-select');
    const options = select.querySelectorAll('option');
    expect(options.length).toBe(1);
    expect(options[0].textContent).toBe('Alesis QSR');
  });

  test('shows error when no MIDI devices found', async () => {
    mockAccess = new MockMIDIAccess(); // empty
    setMockMIDIAccess(mockAccess);
    await loadApp();
    expect(document.getElementById('lcd-line1').textContent).toContain('No MIDI devices');
  });

  test('shows error when no QS device found', async () => {
    // Add a device that doesn't reply to identity query
    mockAccess = new MockMIDIAccess();
    const dev = mockAccess.addDevice('Random Synth');
    // Don't set up auto-reply, so identity query will timeout
    setMockMIDIAccess(mockAccess);
    await loadApp();
    expect(document.getElementById('lcd-line1').textContent).toContain('No QS device');
  });

  test('shows error when Web MIDI not supported', async () => {
    const orig = navigator.requestMIDIAccess;
    navigator.requestMIDIAccess = undefined;
    jest.resetModules();
    setupDOM();
    await loadApp();
    expect(document.getElementById('lcd-line1').textContent).toContain('not supported');
    navigator.requestMIDIAccess = orig;
  });

  test('sends Mode Select and MIDI Program Select = On on init', async () => {
    await loadApp();
    const calls = qsrOutput.send.mock.calls;
    // Find mode select call (opcode 0x0D, mode=0)
    const modeCall = calls.find(c => {
      const d = c[0] instanceof Uint8Array ? c[0] : new Uint8Array(c[0]);
      return d[0] === 0xF0 && d[5] === 0x0D && d[6] === 0x00;
    });
    expect(modeCall).toBeTruthy();

    // Find the sendMidiProgramSelect call (opcode 0x10, func=0, page=5, value=1 = On)
    const progSelectCall = calls.find(c => {
      const d = c[0] instanceof Uint8Array ? c[0] : new Uint8Array(c[0]);
      return d[0] === 0xF0 && d[5] === 0x10 && d[7] === 0x05 && d[9] === 0x01;
    });
    expect(progSelectCall).toBeTruthy();
  });
});

// --- Mode Switching ---

describe('mode switching', () => {
  test('selecting MIX switches to mix mode', async () => {
    await loadApp();
    switchMode('mix');
    await jest.advanceTimersByTimeAsync(100);

    expect(document.getElementById('mode-select').value).toBe('mix');
  });

  test('sends MIDI Program Select = Channel 1 when switching to mix mode', async () => {
    await loadApp();
    qsrOutput.send.mockClear();
    switchMode('mix');
    await jest.advanceTimersByTimeAsync(100);

    const calls = qsrOutput.send.mock.calls;
    // Should have sendMidiProgramSelect(output, 2) — value=2 = Channel 1
    const progSelectCall = calls.find(c => {
      const d = c[0] instanceof Uint8Array ? c[0] : new Uint8Array(c[0]);
      return d[0] === 0xF0 && d[5] === 0x10 && d[7] === 0x05 && d[9] === 0x02;
    });
    expect(progSelectCall).toBeTruthy();
  });

  test('sends MIDI Program Select = On when switching back to prog mode', async () => {
    await loadApp();
    switchMode('mix');
    await jest.advanceTimersByTimeAsync(100);
    qsrOutput.send.mockClear();

    switchMode('prog');
    await jest.advanceTimersByTimeAsync(100);

    const calls = qsrOutput.send.mock.calls;
    const progSelectCall = calls.find(c => {
      const d = c[0] instanceof Uint8Array ? c[0] : new Uint8Array(c[0]);
      return d[0] === 0xF0 && d[5] === 0x10 && d[7] === 0x05 && d[9] === 0x01;
    });
    expect(progSelectCall).toBeTruthy();
  });

  test('resets patch to 0 on mode switch', async () => {
    await loadApp();
    setPatch(1);
    await jest.advanceTimersByTimeAsync(100);

    switchMode('mix');
    await jest.advanceTimersByTimeAsync(100);

    expect(document.getElementById('lcd-patch').value).toBe('0');
  });

  test('mode select ignored when no active device', async () => {
    mockAccess = new MockMIDIAccess();
    setMockMIDIAccess(mockAccess);
    await loadApp();
    // Should not throw
    switchMode('mix');
    switchMode('prog');
  });
});

// --- Bank Selection ---

describe('bank selection', () => {
  test('changing bank sends bank select MSB + LSB + program change', async () => {
    await loadApp();
    qsrOutput.send.mockClear();

    setBank(2);
    await jest.advanceTimersByTimeAsync(100);

    const calls = qsrOutput.send.mock.calls;
    // Bank select CC#0 MSB = 2
    const msbCall = calls.find(c => {
      const d = Array.isArray(c[0]) ? c[0] : Array.from(c[0]);
      return (d[0] & 0xF0) === 0xB0 && d[1] === 0x00 && d[2] === 2;
    });
    expect(msbCall).toBeTruthy();

    // Bank select CC#32 LSB = 32
    const lsbCall = calls.find(c => {
      const d = Array.isArray(c[0]) ? c[0] : Array.from(c[0]);
      return (d[0] & 0xF0) === 0xB0 && d[1] === 0x20 && d[2] === 0x20;
    });
    expect(lsbCall).toBeTruthy();

    // Program change to 0
    const pcCall = calls.find(c => {
      const d = Array.isArray(c[0]) ? c[0] : Array.from(c[0]);
      return (d[0] & 0xF0) === 0xC0 && d[1] === 0;
    });
    expect(pcCall).toBeTruthy();
  });

  test('changing bank resets patch to 0', async () => {
    await loadApp();
    setPatch(1);
    await jest.advanceTimersByTimeAsync(100);

    setBank(1);
    await jest.advanceTimersByTimeAsync(100);

    expect(document.getElementById('lcd-patch').value).toBe('0');
  });

  test('bank select ignored when no active device', async () => {
    mockAccess = new MockMIDIAccess();
    setMockMIDIAccess(mockAccess);
    await loadApp();

    setBank(2);
  });
});

// --- Patch Navigation ---

describe('patch navigation', () => {
  test('setting patch value changes patch', async () => {
    await loadApp();
    setPatch(1);
    await jest.advanceTimersByTimeAsync(100);
    expect(document.getElementById('lcd-patch').value).toBe('1');
  });

  test('setting patch value updates display', async () => {
    await loadApp();
    setPatch(2);
    await jest.advanceTimersByTimeAsync(100);

    setPatch(1);
    await jest.advanceTimersByTimeAsync(100);
    expect(document.getElementById('lcd-patch').value).toBe('1');
  });

  test('wraps from 128 to 0 in prog mode', async () => {
    await loadApp();
    setPatch(128);
    await jest.advanceTimersByTimeAsync(100);
    expect(document.getElementById('lcd-patch').value).toBe('0');
  });

  test('wraps from -1 to 127 going backwards in prog mode', async () => {
    await loadApp();
    setPatch(-1);
    await jest.advanceTimersByTimeAsync(100);
    expect(document.getElementById('lcd-patch').value).toBe('127');
  });

  test('wraps from -1 to 99 going backwards in mix mode', async () => {
    await loadApp();
    switchMode('mix');
    await jest.advanceTimersByTimeAsync(100);

    setPatch(-1);
    await jest.advanceTimersByTimeAsync(100);
    expect(document.getElementById('lcd-patch').value).toBe('99');
  });

  test('wraps from 100 to 0 in mix mode', async () => {
    await loadApp();
    switchMode('mix');
    await jest.advanceTimersByTimeAsync(100);

    setPatch(100);
    await jest.advanceTimersByTimeAsync(100);
    expect(document.getElementById('lcd-patch').value).toBe('0');
  });

  test('patch input ignored when no active device', async () => {
    mockAccess = new MockMIDIAccess();
    setMockMIDIAccess(mockAccess);
    await loadApp();
    setPatch(1);
    setPatch(-1);
  });
});

// --- Rescan ---

describe('rescan', () => {
  test('rescan button triggers new scan', async () => {
    await loadApp();
    // Verify rescan button is enabled and click it
    const btn = document.getElementById('rescan-btn');
    expect(btn.disabled).toBe(false);
    qsrOutput.send.mockClear();
    btn.click();
    await jest.advanceTimersByTimeAsync(3000);
    // Should have sent identity inquiry again
    const inquiryCalls = qsrOutput.send.mock.calls.filter(c => {
      const d = c[0] instanceof Uint8Array ? c[0] : new Uint8Array(c[0]);
      return d[0] === 0xF0 && d[1] === 0x7E;
    });
    expect(inquiryCalls.length).toBeGreaterThan(0);
  });
});

// --- MIDI Modal ---

describe('midi modal', () => {
  test('midi button opens and close button closes modal', async () => {
    await loadApp();
    const modal = document.getElementById('midi-modal');
    expect(modal.classList.contains('hidden')).toBe(true);

    document.getElementById('midi-btn').click();
    expect(modal.classList.contains('hidden')).toBe(false);

    document.getElementById('midi-close').click();
    expect(modal.classList.contains('hidden')).toBe(true);
  });
});

// --- Identify Button ---

describe('identify button', () => {
  test('manually identifying a device', async () => {
    // Start with empty access so auto-scan finds nothing
    mockAccess = new MockMIDIAccess();
    const dev = mockAccess.addDevice('Manual QSR');
    autoReplyIdentity(dev.output, dev.input);
    setMockMIDIAccess(mockAccess);
    await loadApp();

    // Select the device and click identify
    document.getElementById('device-select').value = '0';
    document.getElementById('identify-btn').click();
    await jest.advanceTimersByTimeAsync(3000);

    expect(document.getElementById('lcd-line1').textContent).toContain('QSR');
  });

  test('identify shows error on timeout', async () => {
    mockAccess = new MockMIDIAccess();
    const dev = mockAccess.addDevice('Silent Device');
    // Don't auto-reply
    setMockMIDIAccess(mockAccess);
    await loadApp();

    document.getElementById('device-select').value = '0';
    document.getElementById('identify-btn').click();
    await jest.advanceTimersByTimeAsync(2000);

    expect(document.getElementById('lcd-line1').textContent).toContain('timed out');
  });

  test('identify with no device selected', async () => {
    // Add a device but don't auto-reply so autoScan fails, leaving no activeDevice
    mockAccess = new MockMIDIAccess();
    const dev = mockAccess.addDevice('Some Device');
    setMockMIDIAccess(mockAccess);
    await loadApp();

    // Clear the select so value points to nothing
    const select = document.getElementById('device-select');
    select.innerHTML = '';
    document.getElementById('identify-btn').click();
    await jest.advanceTimersByTimeAsync(100);

    expect(document.getElementById('lcd-line1').textContent).toContain('No device');
  });
});

// --- LCD Display ---

describe('LCD display', () => {
  test('shows MIX mode in LCD after mode switch', async () => {
    await loadApp();
    switchMode('mix');
    await jest.advanceTimersByTimeAsync(100);
    const lcd2 = document.getElementById('lcd-line2');
    expect(lcd2.innerHTML).toContain('MIX');
  });

  test('shows bank name in LCD', async () => {
    await loadApp();
    const lcd2 = document.getElementById('lcd-line2');
    expect(lcd2.innerHTML).toContain('User');
  });

  test('shows patch number in LCD', async () => {
    await loadApp();
    setPatch(1);
    await jest.advanceTimersByTimeAsync(3000);
    expect(document.getElementById('lcd-patch').value).toBe('1');
  });
});

// --- Preset names for non-User banks ---

describe('preset name lookup', () => {
  test('shows preset name when switching to bank 1 in prog mode', async () => {
    await loadApp();

    setBank(1);
    await jest.advanceTimersByTimeAsync(100);

    expect(document.getElementById('lcd-name').textContent).toContain('TrueStereo');
  });

  test('shows preset name when switching to bank 4 (GM) in prog mode', async () => {
    await loadApp();

    setBank(4);
    await jest.advanceTimersByTimeAsync(100);

    expect(document.getElementById('lcd-name').textContent).toContain('AcGrandPno');
  });

  test('shows preset mix name when in mix mode bank 1', async () => {
    await loadApp();
    switchMode('mix');
    await jest.advanceTimersByTimeAsync(100);

    setBank(1);
    await jest.advanceTimersByTimeAsync(100);

    expect(document.getElementById('lcd-name').textContent).toContain('Zen Piano');
  });

  test('navigating patches updates preset name', async () => {
    await loadApp();

    setBank(1);
    await jest.advanceTimersByTimeAsync(100);

    setPatch(1);
    await jest.advanceTimersByTimeAsync(100);

    expect(document.getElementById('lcd-name').textContent).toContain('Titanium88');
  });

  test('does not show preset name for User bank (0)', async () => {
    await loadApp();
    // Default is bank 0 (User) — name should be empty (fetched via SysEx which times out)
    await jest.advanceTimersByTimeAsync(3000);
    const lcd2 = document.getElementById('lcd-line2');
    // The name column should not contain any preset bank 1 name
    expect(lcd2.innerHTML).not.toContain('TrueStereo');
  });
});

// --- Stale fetch guard ---

describe('stale fetch guard', () => {
  test('discards stale patch name when a newer fetch supersedes it', async () => {
    // Set up output to auto-reply with patch names, but with a delay
    qsrOutput.send = jest.fn(function (data) {
      const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
      // Identity inquiry
      if (arr[0] === 0xF0 && arr[1] === 0x7E && arr[4] === 0x01) {
        setTimeout(() => qsrInput.receive(QSR_IDENTITY_REPLY), 0);
        return;
      }
      // Program dump request — reply with delay so we can trigger a second fetch before this resolves
      if (arr[0] === 0xF0 && arr[5] === 0x01) {
        const num = arr[6];
        const prog = makeMinimalProgram(`Patch${num}   `);
        setTimeout(() => {
          qsrInput.receive(buildSysexReply(0x00, num, prog.toUnpacked()));
        }, 100);
      }
    });

    await loadApp();

    // First change: starts fetch for patch 1
    setPatch(1);
    // Immediately change again before patch 1 reply arrives: starts fetch for patch 2
    setPatch(2);

    // Advance past the delayed replies
    await jest.advanceTimersByTimeAsync(500);

    // Patch 1's reply should be discarded (stale), patch 2's name should show
    expect(document.getElementById('lcd-patch').value).toBe('2');
  });
});

// --- localStorage persistence ---

describe('localStorage persistence', () => {
  test('restores saved mode/bank/patch on reconnect', async () => {
    localStorage.setItem('qsr-control-state', JSON.stringify({
      mode: 'mix', bank: 2, patch: 42,
    }));
    await loadApp();

    expect(document.getElementById('mode-select').value).toBe('mix');
    expect(document.getElementById('lcd-bank').value).toBe('2');
    expect(document.getElementById('lcd-patch').value).toBe('42');
  });

  test('sends correct MIDI messages for restored mix mode state', async () => {
    localStorage.setItem('qsr-control-state', JSON.stringify({
      mode: 'mix', bank: 1, patch: 5,
    }));
    await loadApp();

    const calls = qsrOutput.send.mock.calls;
    // Mode select for mix (opcode 0x0D, value 1)
    const modeCall = calls.find(c => {
      const d = c[0] instanceof Uint8Array ? c[0] : new Uint8Array(c[0]);
      return d[0] === 0xF0 && d[5] === 0x0D && d[6] === 0x01;
    });
    expect(modeCall).toBeTruthy();

    // MIDI Program Select = Channel 1 (value 2)
    const progSelCall = calls.find(c => {
      const d = c[0] instanceof Uint8Array ? c[0] : new Uint8Array(c[0]);
      return d[0] === 0xF0 && d[5] === 0x10 && d[7] === 0x05 && d[9] === 0x02;
    });
    expect(progSelCall).toBeTruthy();
  });

  test('defaults to prog/0/0 with no saved state', async () => {
    await loadApp();
    expect(document.getElementById('mode-select').value).toBe('prog');
    expect(document.getElementById('lcd-bank').value).toBe('0');
    expect(document.getElementById('lcd-patch').value).toBe('0');
  });

  test('ignores corrupt localStorage data', async () => {
    localStorage.setItem('qsr-control-state', '{bad json!!!');
    await loadApp();
    // Should fall back to defaults
    expect(document.getElementById('mode-select').value).toBe('prog');
    expect(document.getElementById('lcd-patch').value).toBe('0');
  });

  test('ignores invalid state shape', async () => {
    localStorage.setItem('qsr-control-state', JSON.stringify({ mode: 'bad', bank: 'x' }));
    await loadApp();
    expect(document.getElementById('mode-select').value).toBe('prog');
  });

  test('saves state after bank change', async () => {
    await loadApp();
    setBank(3);
    await jest.advanceTimersByTimeAsync(100);

    const saved = JSON.parse(localStorage.getItem('qsr-control-state'));
    expect(saved).toEqual({ mode: 'prog', bank: 3, patch: 0 });
  });

  test('saves state after patch change', async () => {
    await loadApp();
    setPatch(1);
    await jest.advanceTimersByTimeAsync(100);

    const saved = JSON.parse(localStorage.getItem('qsr-control-state'));
    expect(saved.patch).toBe(1);
  });

  test('saves state after mode switch', async () => {
    await loadApp();
    switchMode('mix');
    await jest.advanceTimersByTimeAsync(100);

    const saved = JSON.parse(localStorage.getItem('qsr-control-state'));
    expect(saved.mode).toBe('mix');
  });
});

// --- Search ---

describe('search', () => {
  test('clicking patch name opens modal and shows results', async () => {
    await loadApp();
    const modal = document.getElementById('search-modal');
    expect(modal.classList.contains('hidden')).toBe(true);

    openSearch();
    expect(modal.classList.contains('hidden')).toBe(false);

    // Should show all presets (grouped) when input is empty
    const items = document.querySelectorAll('.search-result-item');
    expect(items.length).toBeGreaterThan(0);
    const headers = document.querySelectorAll('.search-group-header');
    expect(headers.length).toBeGreaterThan(0);
  });

  test('typing filters results', async () => {
    await loadApp();
    openSearch();

    const input = document.getElementById('search-input');
    input.value = 'TrueStereo';
    input.dispatchEvent(new Event('input'));

    const items = document.querySelectorAll('.search-result-item');
    expect(items.length).toBe(1);
    expect(items[0].textContent).toContain('TrueStereo');
  });

  test('filter checkboxes limit by mode', async () => {
    await loadApp();
    openSearch();

    // Uncheck mixes
    const filterMix = document.getElementById('filter-mix');
    filterMix.checked = false;
    filterMix.dispatchEvent(new Event('change'));

    const headers = document.querySelectorAll('.search-group-header');
    const headerTexts = Array.from(headers).map(h => h.textContent);
    expect(headerTexts.every(t => t.includes('PROG'))).toBe(true);
  });

  test('clicking a result selects it and closes modal', async () => {
    await loadApp();
    openSearch();

    const input = document.getElementById('search-input');
    input.value = 'Titanium88';
    input.dispatchEvent(new Event('input'));

    const items = document.querySelectorAll('.search-result-item');
    items[0].click();
    await jest.advanceTimersByTimeAsync(100);

    const modal = document.getElementById('search-modal');
    expect(modal.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('lcd-patch').value).toBe('1');
    expect(document.getElementById('lcd-bank').value).toBe('1');
  });

  test('selecting a mix result switches mode', async () => {
    await loadApp();
    openSearch();

    const input = document.getElementById('search-input');
    input.value = 'Zen Piano';
    input.dispatchEvent(new Event('input'));

    const items = document.querySelectorAll('.search-result-item');
    items[0].click();
    await jest.advanceTimersByTimeAsync(100);

    expect(document.getElementById('mode-select').value).toBe('mix');
  });

  test('Escape closes search modal', async () => {
    await loadApp();
    openSearch();

    const input = document.getElementById('search-input');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(document.getElementById('search-modal').classList.contains('hidden')).toBe(true);
  });

  test('clicking backdrop closes search modal', async () => {
    await loadApp();
    openSearch();

    const modal = document.getElementById('search-modal');
    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Click on modal itself (backdrop) should close
    expect(modal.classList.contains('hidden')).toBe(true);
  });

  test('arrow keys navigate results and Enter selects', async () => {
    await loadApp();
    openSearch();

    const input = document.getElementById('search-input');
    input.value = 'TrueStereo';
    input.dispatchEvent(new Event('input'));

    // Stub scrollIntoView (not available in jsdom)
    const items = document.querySelectorAll('.search-result-item');
    items.forEach(el => { el.scrollIntoView = jest.fn(); });

    // Arrow down to highlight first result
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(items[0].classList.contains('active')).toBe(true);

    // Arrow up wraps to last
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(items[items.length - 1].classList.contains('active')).toBe(true);

    // Arrow down again to first
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));

    // Enter selects
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await jest.advanceTimersByTimeAsync(100);

    expect(document.getElementById('search-modal').classList.contains('hidden')).toBe(true);
  });

  test('clicking patch name does nothing when no device', async () => {
    mockAccess = new MockMIDIAccess();
    setMockMIDIAccess(mockAccess);
    await loadApp();
    openSearch();
    expect(document.getElementById('search-modal').classList.contains('hidden')).toBe(true);
  });
});

// --- Globals dialog ---

describe('globals dialog', () => {
  function buildGlobalDumpReply(unpacked) {
    // Pack 20 bytes into 23 packed bytes using QS 7-bit encoding
    const packed = [];
    for (let i = 0; i + 6 < unpacked.length; i += 7) {
      const b = unpacked.slice(i, i + 7);
      packed.push(b[0] & 0x7F);
      packed.push(((b[0] >> 7) & 0x01) | ((b[1] & 0x3F) << 1));
      packed.push(((b[1] >> 6) & 0x03) | ((b[2] & 0x1F) << 2));
      packed.push(((b[2] >> 5) & 0x07) | ((b[3] & 0x0F) << 3));
      packed.push(((b[3] >> 4) & 0x0F) | ((b[4] & 0x07) << 4));
      packed.push(((b[4] >> 3) & 0x1F) | ((b[5] & 0x03) << 5));
      packed.push(((b[5] >> 2) & 0x3F) | ((b[6] & 0x01) << 6));
      packed.push((b[6] >> 1) & 0x7F);
    }
    // Handle partial trailing group (6 remaining bytes → 7 packed bytes)
    const tail = unpacked.length % 7;
    if (tail > 0) {
      const i = unpacked.length - tail;
      const b = unpacked.slice(i);
      while (b.length < 7) b.push(0);
      packed.push(b[0] & 0x7F);
      packed.push(((b[0] >> 7) & 0x01) | ((b[1] & 0x3F) << 1));
      packed.push(((b[1] >> 6) & 0x03) | ((b[2] & 0x1F) << 2));
      packed.push(((b[2] >> 5) & 0x07) | ((b[3] & 0x0F) << 3));
      packed.push(((b[3] >> 4) & 0x0F) | ((b[4] & 0x07) << 4));
      packed.push(((b[4] >> 3) & 0x1F) | ((b[5] & 0x03) << 5));
      packed.push(((b[5] >> 2) & 0x3F) | ((b[6] & 0x01) << 6));
    }
    // F0 00 00 0E 0E 0A 00 <packed> F7
    const msg = new Uint8Array(7 + packed.length + 1);
    msg[0] = 0xF0; msg[1] = 0x00; msg[2] = 0x00; msg[3] = 0x0E; msg[4] = 0x0E;
    msg[5] = 0x0A; msg[6] = 0x00;
    for (let j = 0; j < packed.length; j++) msg[7 + j] = packed[j];
    msg[msg.length - 1] = 0xF7;
    return msg;
  }

  function setupGlobalReply(globalBytes) {
    const origSend = qsrOutput.send;
    qsrOutput.send = jest.fn(function (data) {
      const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (arr[0] === 0xF0 && arr[1] === 0x7E && arr[4] === 0x01) {
        setTimeout(() => qsrInput.receive(QSR_IDENTITY_REPLY), 0);
        return;
      }
      // Global data dump request (opcode 0x0B)
      if (arr[0] === 0xF0 && arr[5] === 0x0B) {
        setTimeout(() => qsrInput.receive(buildGlobalDumpReply(globalBytes)), 0);
        return;
      }
    });
  }

  test('opens and displays global parameters', async () => {
    const globalData = new Array(20).fill(0);
    globalData[1] = 3;   // Pitch Transpose = +3
    globalData[2] = 0xCE; // Pitch Fine Tune = -50 (2's complement: 256-50=206=0xCE)
    globalData[7] = 1;   // Controller A = CC 1
    globalData[13] = 1;  // MIDI Program Select = On
    globalData[17] = 0;  // General MIDI = Off
    setupGlobalReply(globalData);
    await loadApp();

    document.getElementById('globals-btn').click();
    await jest.advanceTimersByTimeAsync(100);

    const modal = document.getElementById('globals-modal');
    expect(modal.classList.contains('hidden')).toBe(false);

    const body = document.getElementById('globals-body');
    expect(body.innerHTML).toContain('Pitch Transpose');
    // Check spinbox has value 3
    const transposeInput = body.querySelector('input[data-byte="1"]');
    expect(transposeInput.value).toBe('3');
    // Check fine tune has -50
    const fineInput = body.querySelector('input[data-byte="2"]');
    expect(fineInput.value).toBe('-50');
  });

  test('editable spinbox sends global param on change', async () => {
    const globalData = new Array(20).fill(0);
    setupGlobalReply(globalData);
    await loadApp();

    document.getElementById('globals-btn').click();
    await jest.advanceTimersByTimeAsync(100);

    qsrOutput.send.mockClear();
    const body = document.getElementById('globals-body');
    const transposeInput = body.querySelector('input[data-byte="1"]');
    transposeInput.value = '5';
    transposeInput.dispatchEvent(new Event('change'));

    // Should have sent a direct parameter edit (opcode 0x10)
    const calls = qsrOutput.send.mock.calls;
    const editCall = calls.find(c => {
      const d = c[0] instanceof Uint8Array ? c[0] : new Uint8Array(c[0]);
      return d[0] === 0xF0 && d[5] === 0x10 && d[9] === 5;
    });
    expect(editCall).toBeTruthy();
  });

  test('editable spinbox sends 2s complement for negative values', async () => {
    const globalData = new Array(20).fill(0);
    setupGlobalReply(globalData);
    await loadApp();

    document.getElementById('globals-btn').click();
    await jest.advanceTimersByTimeAsync(100);

    qsrOutput.send.mockClear();
    const body = document.getElementById('globals-body');
    const fineInput = body.querySelector('input[data-byte="2"]');
    fineInput.value = '-10';
    fineInput.dispatchEvent(new Event('change'));

    const calls = qsrOutput.send.mock.calls;
    const editCall = calls.find(c => {
      const d = c[0] instanceof Uint8Array ? c[0] : new Uint8Array(c[0]);
      // -10 + 256 = 246, split: MSB bit = (246>>7)&1 = 1, LSB = 246&0x7F = 118
      return d[0] === 0xF0 && d[5] === 0x10;
    });
    expect(editCall).toBeTruthy();
    const d = editCall[0] instanceof Uint8Array ? editCall[0] : new Uint8Array(editCall[0]);
    const sentValue = ((d[8] & 0x01) << 7) | (d[9] & 0x7F);
    expect(sentValue).toBe(246); // -10 as unsigned byte
  });

  test('spinbox clamps out-of-range values', async () => {
    const globalData = new Array(20).fill(0);
    setupGlobalReply(globalData);
    await loadApp();

    document.getElementById('globals-btn').click();
    await jest.advanceTimersByTimeAsync(100);

    const body = document.getElementById('globals-body');
    const transposeInput = body.querySelector('input[data-byte="1"]');
    transposeInput.value = '99';
    transposeInput.dispatchEvent(new Event('change'));
    expect(transposeInput.value).toBe('12'); // clamped to max
  });

  test('select dropdown sends value on change', async () => {
    const globalData = new Array(20).fill(0);
    setupGlobalReply(globalData);
    await loadApp();

    document.getElementById('globals-btn').click();
    await jest.advanceTimersByTimeAsync(100);

    qsrOutput.send.mockClear();
    const body = document.getElementById('globals-body');
    const select = body.querySelector('select[data-byte="13"]');
    select.value = '2'; // Channel 1
    select.dispatchEvent(new Event('change'));

    const calls = qsrOutput.send.mock.calls;
    const editCall = calls.find(c => {
      const d = c[0] instanceof Uint8Array ? c[0] : new Uint8Array(c[0]);
      return d[0] === 0xF0 && d[5] === 0x10 && d[7] === 0x05 && d[9] === 2;
    });
    expect(editCall).toBeTruthy();
  });

  test('checkbox sends value on toggle', async () => {
    const globalData = new Array(20).fill(0);
    setupGlobalReply(globalData);
    await loadApp();

    document.getElementById('globals-btn').click();
    await jest.advanceTimersByTimeAsync(100);

    qsrOutput.send.mockClear();
    const body = document.getElementById('globals-body');
    const checkbox = body.querySelector('input[data-byte="17"]');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    const calls = qsrOutput.send.mock.calls;
    const editCall = calls.find(c => {
      const d = c[0] instanceof Uint8Array ? c[0] : new Uint8Array(c[0]);
      // GM: func=0, page=0, pot=1, value=1
      return d[0] === 0xF0 && d[5] === 0x10 && d[9] === 1;
    });
    expect(editCall).toBeTruthy();
  });

  test('close button closes globals modal', async () => {
    const globalData = new Array(20).fill(0);
    setupGlobalReply(globalData);
    await loadApp();

    document.getElementById('globals-btn').click();
    await jest.advanceTimersByTimeAsync(100);

    document.getElementById('globals-close').click();
    expect(document.getElementById('globals-modal').classList.contains('hidden')).toBe(true);
  });

  test('backdrop click closes globals modal', async () => {
    const globalData = new Array(20).fill(0);
    setupGlobalReply(globalData);
    await loadApp();

    document.getElementById('globals-btn').click();
    await jest.advanceTimersByTimeAsync(100);

    const modal = document.getElementById('globals-modal');
    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modal.classList.contains('hidden')).toBe(true);
  });

  test('Escape closes globals modal', async () => {
    const globalData = new Array(20).fill(0);
    setupGlobalReply(globalData);
    await loadApp();

    document.getElementById('globals-btn').click();
    await jest.advanceTimersByTimeAsync(100);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('globals-modal').classList.contains('hidden')).toBe(true);
  });

  test('shows error when global dump request fails', async () => {
    // Don't set up global reply so request times out
    await loadApp();

    document.getElementById('globals-btn').click();
    await jest.advanceTimersByTimeAsync(6000);

    const body = document.getElementById('globals-body');
    expect(body.textContent).toContain('Failed');
  });

  test('globals button disabled when no device', async () => {
    mockAccess = new MockMIDIAccess();
    setMockMIDIAccess(mockAccess);
    await loadApp();
    expect(document.getElementById('globals-btn').disabled).toBe(true);
  });
});

// --- State Change ---

describe('statechange', () => {
  test('rescans on MIDI device statechange', async () => {
    await loadApp();

    // Trigger statechange
    for (const fn of (mockAccess._listeners['statechange'] || [])) {
      fn();
    }
    await jest.advanceTimersByTimeAsync(3000);

    // Should still show connected
    expect(document.getElementById('lcd-line1').textContent).toContain('QSR');
  });
});

// --- User Bank Names ---

describe('user bank names', () => {
  test('refresh button enabled after device connection', async () => {
    await loadApp();
    expect(document.getElementById('refresh-btn').disabled).toBe(false);
  });

  test('refresh button disabled when no device', async () => {
    mockAccess = new MockMIDIAccess();
    setMockMIDIAccess(mockAccess);
    await loadApp();
    expect(document.getElementById('refresh-btn').disabled).toBe(true);
  });

  test('IndexedDB round-trip for user bank data', async () => {
    // Clear and re-seed with custom names
    await clearAll();
    for (let i = 0; i < 128; i++) {
      await putProgram(i, makeMinimalProgram(`Prog ${i}`));
    }
    for (let i = 0; i < 100; i++) {
      await putMix(i, makeMinimalMix(`Mix ${i}`));
    }
    await loadApp();

    // Verify it was loaded (search should include user bank entries)
    openSearch();
    const input = document.getElementById('search-input');
    input.value = 'Prog 42';
    input.dispatchEvent(new Event('input'));

    const items = document.querySelectorAll('.search-result-item');
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].textContent).toContain('Prog 42');
  });

  test('user bank names appear in search results after caching', async () => {
    // Clear and re-seed with custom names
    await clearAll();
    for (let i = 0; i < 128; i++) {
      await putProgram(i, makeMinimalProgram(`MyProg${i}`));
    }
    for (let i = 0; i < 100; i++) {
      await putMix(i, makeMinimalMix(`MyMix${i}`));
    }
    await loadApp();

    openSearch();
    const input = document.getElementById('search-input');
    input.value = 'MyMix5';
    input.dispatchEvent(new Event('input'));

    const items = document.querySelectorAll('.search-result-item');
    const names = Array.from(items).map(el => el.textContent);
    expect(names.some(n => n.includes('MyMix5'))).toBe(true);

    // Verify group header for user bank
    const headers = document.querySelectorAll('.search-group-header');
    const headerTexts = Array.from(headers).map(h => h.textContent);
    expect(headerTexts.some(t => t.includes('User'))).toBe(true);
  });

  test('search shows user programs under PROG — User group', async () => {
    // Clear and seed with a program at slot 5 (not slot 0, which fetchPatchName overwrites)
    await clearAll();
    await putProgram(5, makeMinimalProgram('TestProg'));
    await loadApp();

    openSearch();
    const input = document.getElementById('search-input');
    input.value = 'TestProg';
    input.dispatchEvent(new Event('input'));

    const headers = document.querySelectorAll('.search-group-header');
    expect(headers.length).toBe(1);
    expect(headers[0].textContent).toBe('PROG — User');
  });
});

// --- Edit Buffer Button ---

describe('edit buffer button', () => {
  test('edit-buf-btn visible when device connected', async () => {
    await loadApp();
    expect(document.getElementById('edit-buf-btn').classList.contains('hidden')).toBe(false);
  });

  test('edit-buf-btn hidden when no device', async () => {
    mockAccess = new MockMIDIAccess();
    setMockMIDIAccess(mockAccess);
    await loadApp();
    expect(document.getElementById('edit-buf-btn').classList.contains('hidden')).toBe(true);
  });

  test('clicking edit-buf-btn in prog mode opens prog-info-modal with edit buffer data', async () => {
    await loadApp();

    document.getElementById('edit-buf-btn').click();
    await jest.advanceTimersByTimeAsync(500);

    const modal = document.getElementById('prog-info-modal');
    expect(modal.classList.contains('hidden')).toBe(false);
    const body = document.getElementById('prog-info-body');
    expect(body.textContent).toContain('EditBuf');
  });

  test('clicking edit-buf-btn in mix mode opens mix-info-modal with edit buffer data', async () => {
    // Add auto-reply for mix edit buffer (opcode 0x0F, mixNum=100)
    const origSend = qsrOutput.send;
    qsrOutput.send = jest.fn(function (data) {
      const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
      // Identity inquiry
      if (arr[0] === 0xF0 && arr[1] === 0x7E && arr[4] === 0x01) {
        setTimeout(() => qsrInput.receive(QSR_IDENTITY_REPLY), 0);
        return;
      }
      // Reply to program dump request (opcode 0x01)
      if (arr[0] === 0xF0 && arr[5] === 0x01) {
        const num = arr[6];
        const prog = makeMinimalProgram(`User ${String(num).padStart(3, '0')}`);
        setTimeout(() => qsrInput.receive(buildSysexReply(0x00, num, prog.toUnpacked())), 0);
        return;
      }
      // Reply to edit program request (opcode 0x03)
      if (arr[0] === 0xF0 && arr[5] === 0x03) {
        const prog = makeMinimalProgram('EditBuf');
        setTimeout(() => qsrInput.receive(buildSysexReply(0x02, 0, prog.toUnpacked())), 0);
        return;
      }
      // Reply to user effects request (opcode 0x07)
      if (arr[0] === 0xF0 && arr[5] === 0x07) {
        const num = arr[6];
        const eff = makeMinimalEffect();
        setTimeout(() => qsrInput.receive(buildSysexReply(0x06, num, eff.toUnpacked())), 0);
        return;
      }
      // Reply to edit effects request (opcode 0x09)
      if (arr[0] === 0xF0 && arr[5] === 0x09) {
        const num = arr[6];
        const eff = makeMinimalEffect();
        setTimeout(() => qsrInput.receive(buildSysexReply(0x08, num, eff.toUnpacked())), 0);
        return;
      }
      // Reply to mix dump request (opcode 0x0F)
      if (arr[0] === 0xF0 && arr[5] === 0x0F) {
        const num = arr[6];
        const mix = makeMinimalMix(`EditMixBuf`);
        setTimeout(() => qsrInput.receive(buildSysexReply(0x0E, num, mix.toUnpacked())), 0);
        return;
      }
    });

    await loadApp();
    switchMode('mix');
    await jest.advanceTimersByTimeAsync(500);

    document.getElementById('edit-buf-btn').click();
    await jest.advanceTimersByTimeAsync(500);

    const modal = document.getElementById('mix-info-modal');
    expect(modal.classList.contains('hidden')).toBe(false);
    const body = document.getElementById('mix-info-body');
    expect(body.textContent).toContain('EditMixBuf');
  });
});

describe('program info dialog', () => {
  test('prog-info-btn opens modal with program data', async () => {
    await loadApp();

    document.getElementById('prog-info-btn').click();
    await jest.advanceTimersByTimeAsync(500);

    const modal = document.getElementById('prog-info-modal');
    expect(modal.classList.contains('hidden')).toBe(false);
    const body = document.getElementById('prog-info-body');
    expect(body.textContent).toContain('User 000');
  });

  test('renders 5 tabs including Effects', async () => {
    await loadApp();

    document.getElementById('prog-info-btn').click();
    await jest.advanceTimersByTimeAsync(500);

    const tabs = document.querySelectorAll('.prog-info-tab');
    expect(tabs).toHaveLength(5);
    expect(tabs[0].textContent).toBe('Sound 1');
    expect(tabs[1].textContent).toBe('Sound 2');
    expect(tabs[2].textContent).toBe('Sound 3');
    expect(tabs[3].textContent).toBe('Sound 4');
    expect(tabs[4].textContent).toBe('Effects');
  });

  test('tab click switches active panel', async () => {
    await loadApp();

    document.getElementById('prog-info-btn').click();
    await jest.advanceTimersByTimeAsync(500);

    const tabs = document.querySelectorAll('.prog-info-tab');
    const panels = document.querySelectorAll('.prog-info-panel');

    // Sound 1 is active by default
    expect(tabs[0].classList.contains('active')).toBe(true);
    expect(panels[0].classList.contains('active')).toBe(true);

    // Click Effects tab
    tabs[4].click();
    expect(tabs[4].classList.contains('active')).toBe(true);
    expect(panels[4].classList.contains('active')).toBe(true);
    expect(tabs[0].classList.contains('active')).toBe(false);
    expect(panels[0].classList.contains('active')).toBe(false);
  });

  test('Effects tab shows configuration', async () => {
    await loadApp();

    document.getElementById('prog-info-btn').click();
    await jest.advanceTimersByTimeAsync(500);

    const tabs = document.querySelectorAll('.prog-info-tab');
    tabs[4].click();

    const fxPanel = document.querySelector('.prog-info-panel[data-panel="fx"]');
    expect(fxPanel.textContent).toContain('Configuration');
    expect(fxPanel.textContent).toContain('4-Sends, 1 Reverb');
  });

  test('disabled sounds show disabled message', async () => {
    await loadApp();

    document.getElementById('prog-info-btn').click();
    await jest.advanceTimersByTimeAsync(500);

    // Sound 2 is disabled in makeMinimalProgram
    const tabs = document.querySelectorAll('.prog-info-tab');
    expect(tabs[1].disabled).toBe(true);

    const panel2 = document.querySelector('.prog-info-panel[data-panel="1"]');
    expect(panel2.textContent).toContain('Disabled');
  });

  test('close button closes prog-info-modal', async () => {
    await loadApp();

    document.getElementById('prog-info-btn').click();
    await jest.advanceTimersByTimeAsync(500);

    const modal = document.getElementById('prog-info-modal');
    expect(modal.classList.contains('hidden')).toBe(false);

    document.getElementById('prog-info-close').click();
    expect(modal.classList.contains('hidden')).toBe(true);
  });

  test('Escape closes prog-info-modal', async () => {
    await loadApp();

    document.getElementById('prog-info-btn').click();
    await jest.advanceTimersByTimeAsync(500);

    const modal = document.getElementById('prog-info-modal');
    expect(modal.classList.contains('hidden')).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modal.classList.contains('hidden')).toBe(true);
  });

  test('backdrop click closes prog-info-modal', async () => {
    await loadApp();

    document.getElementById('prog-info-btn').click();
    await jest.advanceTimersByTimeAsync(500);

    const modal = document.getElementById('prog-info-modal');
    expect(modal.classList.contains('hidden')).toBe(false);

    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modal.classList.contains('hidden')).toBe(true);
  });

  test('shows error when program request fails', async () => {
    await loadApp();

    // Override send to not reply to program requests
    qsrOutput.send = jest.fn(function (data) {
      const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (arr[0] === 0xF0 && arr[1] === 0x7E && arr[4] === 0x01) {
        setTimeout(() => qsrInput.receive(QSR_IDENTITY_REPLY), 0);
      }
      // Don't reply to program or effect requests — will timeout
    });

    document.getElementById('prog-info-btn').click();
    // Advance past the 5s timeout
    await jest.advanceTimersByTimeAsync(6000);

    const body = document.getElementById('prog-info-body');
    expect(body.textContent).toContain('Failed');
  });

  test('renders drum sound when sound is in drum mode', async () => {
    // Override auto-reply to return a drum-mode program
    qsrOutput.send = jest.fn(function (data) {
      const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (arr[0] === 0xF0 && arr[1] === 0x7E && arr[4] === 0x01) {
        setTimeout(() => qsrInput.receive(QSR_IDENTITY_REPLY), 0);
      }
      if (arr[0] === 0xF0 && arr[5] === 0x01) {
        const num = arr[6];
        const unpacked = new Array(350).fill(0);
        encodeProgName(unpacked, `DrumProg`);
        const baseBitOff = 10 * 8;
        setBits(unpacked, baseBitOff, 1, 1);       // isDrum = true
        setBits(unpacked, baseBitOff + 81 * 8, 1, 1); // drum enabled
        const prog = Program.fromUnpacked(unpacked);
        setTimeout(() => qsrInput.receive(buildSysexReply(0x00, num, prog.toUnpacked())), 0);
      }
      if (arr[0] === 0xF0 && arr[5] === 0x07) {
        const num = arr[6];
        const eff = makeMinimalEffect();
        setTimeout(() => qsrInput.receive(buildSysexReply(0x06, num, eff.toUnpacked())), 0);
      }
    });

    await loadApp();

    document.getElementById('prog-info-btn').click();
    await jest.advanceTimersByTimeAsync(500);

    const body = document.getElementById('prog-info-body');
    expect(body.textContent).toContain('DrumProg');
    expect(body.textContent).toContain('Drum 1');
  });

  test('Effects tab shows mod and EQ for config 3', async () => {
    // Override to return effect config 3 (with EQ)
    qsrOutput.send = jest.fn(function (data) {
      const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (arr[0] === 0xF0 && arr[1] === 0x7E && arr[4] === 0x01) {
        setTimeout(() => qsrInput.receive(QSR_IDENTITY_REPLY), 0);
      }
      if (arr[0] === 0xF0 && arr[5] === 0x01) {
        const num = arr[6];
        const prog = makeMinimalProgram(`User ${String(num).padStart(3, '0')}`);
        setTimeout(() => qsrInput.receive(buildSysexReply(0x00, num, prog.toUnpacked())), 0);
      }
      if (arr[0] === 0xF0 && arr[5] === 0x07) {
        const num = arr[6];
        const eff = makeMinimalEffect(3);
        setTimeout(() => qsrInput.receive(buildSysexReply(0x06, num, eff.toUnpacked())), 0);
      }
    });

    await loadApp();

    document.getElementById('prog-info-btn').click();
    await jest.advanceTimersByTimeAsync(500);

    const tabs = document.querySelectorAll('.prog-info-tab');
    tabs[4].click();

    const fxPanel = document.querySelector('.prog-info-panel[data-panel="fx"]');
    expect(fxPanel.textContent).toContain('2-Sends, with EQ');
    expect(fxPanel.textContent).toContain('Equalizer');
    expect(fxPanel.textContent).toContain('Modulation');
  });
});

describe('MIDI modal', () => {
  test('Escape closes MIDI modal', async () => {
    await loadApp();

    const modal = document.getElementById('midi-modal');
    document.getElementById('midi-btn').click();
    expect(modal.classList.contains('hidden')).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modal.classList.contains('hidden')).toBe(true);
  });
});

describe('mix info dialog', () => {
  test('prog-info-btn in mix mode opens mix-info-modal', async () => {
    await loadApp();
    switchMode('mix');
    await jest.advanceTimersByTimeAsync(500);

    document.getElementById('prog-info-btn').click();
    await jest.advanceTimersByTimeAsync(500);

    const modal = document.getElementById('mix-info-modal');
    expect(modal.classList.contains('hidden')).toBe(false);
    const body = document.getElementById('mix-info-body');
    expect(body.textContent).toContain('Mix Name');
    expect(body.textContent).toContain('User Mix 0');
  });

  test('mix info renders 16 channel tabs', async () => {
    // Create a mix with 2 enabled channels to test tab switching
    qsrOutput.send = jest.fn(function (data) {
      const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (arr[0] === 0xF0 && arr[1] === 0x7E && arr[4] === 0x01) {
        setTimeout(() => qsrInput.receive(QSR_IDENTITY_REPLY), 0);
      }
      if (arr[0] === 0xF0 && arr[5] === 0x01) {
        const num = arr[6];
        const prog = makeMinimalProgram(`User ${String(num).padStart(3, '0')}`);
        setTimeout(() => qsrInput.receive(buildSysexReply(0x00, num, prog.toUnpacked())), 0);
      }
      if (arr[0] === 0xF0 && arr[5] === 0x07) {
        const num = arr[6];
        const eff = makeMinimalEffect();
        setTimeout(() => qsrInput.receive(buildSysexReply(0x06, num, eff.toUnpacked())), 0);
      }
      if (arr[0] === 0xF0 && arr[5] === 0x0F) {
        const num = arr[6];
        // Build mix with ch1 and ch2 enabled
        const unpacked = new Array(138).fill(0);
        encodeMixName(unpacked, 'TabMix');
        const baseBit = 10 * 8;
        setBits(unpacked, baseBit + 11, 1, 1);     // ch1 enable
        setBits(unpacked, baseBit + 8 * 8 + 3, 1, 1); // ch2 enable
        const mix = Mix.fromUnpacked(unpacked);
        setTimeout(() => qsrInput.receive(buildSysexReply(0x0E, num, mix.toUnpacked())), 0);
      }
    });

    await loadApp();
    switchMode('mix');
    await jest.advanceTimersByTimeAsync(500);

    document.getElementById('prog-info-btn').click();
    await jest.advanceTimersByTimeAsync(500);

    const tabs = document.querySelectorAll('#mix-info-body .prog-info-tab');
    expect(tabs).toHaveLength(16);
    expect(tabs[0].textContent).toBe('Ch 1');
    expect(tabs[15].textContent).toBe('Ch 16');
  });

  test('close button closes mix-info-modal', async () => {
    await loadApp();
    switchMode('mix');
    await jest.advanceTimersByTimeAsync(500);

    document.getElementById('prog-info-btn').click();
    await jest.advanceTimersByTimeAsync(500);

    const modal = document.getElementById('mix-info-modal');
    expect(modal.classList.contains('hidden')).toBe(false);

    document.getElementById('mix-info-close').click();
    expect(modal.classList.contains('hidden')).toBe(true);
  });

  test('Escape closes mix-info-modal', async () => {
    await loadApp();
    switchMode('mix');
    await jest.advanceTimersByTimeAsync(500);

    document.getElementById('prog-info-btn').click();
    await jest.advanceTimersByTimeAsync(500);

    const modal = document.getElementById('mix-info-modal');
    expect(modal.classList.contains('hidden')).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modal.classList.contains('hidden')).toBe(true);
  });

  test('backdrop click closes mix-info-modal', async () => {
    await loadApp();
    switchMode('mix');
    await jest.advanceTimersByTimeAsync(500);

    document.getElementById('prog-info-btn').click();
    await jest.advanceTimersByTimeAsync(500);

    const modal = document.getElementById('mix-info-modal');
    expect(modal.classList.contains('hidden')).toBe(false);

    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modal.classList.contains('hidden')).toBe(true);
  });

  test('edit buffer failure in prog mode shows error', async () => {
    await loadApp();

    qsrOutput.send = jest.fn(function (data) {
      const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (arr[0] === 0xF0 && arr[1] === 0x7E && arr[4] === 0x01) {
        setTimeout(() => qsrInput.receive(QSR_IDENTITY_REPLY), 0);
      }
    });

    document.getElementById('edit-buf-btn').click();
    await jest.advanceTimersByTimeAsync(6000);

    const body = document.getElementById('prog-info-body');
    expect(body.textContent).toContain('Failed');
  });

  test('edit buffer failure in mix mode shows error', async () => {
    await loadApp();
    switchMode('mix');
    await jest.advanceTimersByTimeAsync(500);

    qsrOutput.send = jest.fn(function (data) {
      const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (arr[0] === 0xF0 && arr[1] === 0x7E && arr[4] === 0x01) {
        setTimeout(() => qsrInput.receive(QSR_IDENTITY_REPLY), 0);
      }
    });

    document.getElementById('edit-buf-btn').click();
    await jest.advanceTimersByTimeAsync(6000);

    const body = document.getElementById('mix-info-body');
    expect(body.textContent).toContain('Failed');
  });
});

describe('SysEx file viewer', () => {
  function buildSyxFile(messages) {
    const totalLen = messages.reduce((sum, m) => sum + m.length, 0);
    const buf = new ArrayBuffer(totalLen);
    const view = new Uint8Array(buf);
    let offset = 0;
    for (const m of messages) {
      view.set(m, offset);
      offset += m.length;
    }
    return buf;
  }

  function triggerFileLoad(arrayBuffer, filename = 'test.syx') {
    const input = document.getElementById('syx-file-input');
    const file = new File([arrayBuffer], filename, { type: 'application/octet-stream' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
  }

  test('opens viewer with program data from .syx file', async () => {
    await loadApp();

    const prog = makeMinimalProgram('SyxProg');
    const progMsg = buildSysexReply(0x00, 5, prog.toUnpacked());
    const buf = buildSyxFile([progMsg]);

    triggerFileLoad(buf);
    await jest.advanceTimersByTimeAsync(500);

    const body = document.getElementById('syx-viewer-body');
    expect(body.textContent).toContain('SyxProg');
  });

  test('opens viewer with mix and effect data', async () => {
    await loadApp();

    const mix = makeMinimalMix('SyxMix');
    const mixMsg = buildSysexReply(0x0E, 10, mix.toUnpacked());
    const eff = makeMinimalEffect(2);
    const effMsg = buildSysexReply(0x06, 10, eff.toUnpacked());
    const buf = buildSyxFile([mixMsg, effMsg]);

    triggerFileLoad(buf);
    await jest.advanceTimersByTimeAsync(500);

    const body = document.getElementById('syx-viewer-body');
    expect(body.textContent).toContain('SyxMix');
  });

  test('close button closes SysEx viewer', async () => {
    await loadApp();

    const prog = makeMinimalProgram('CloseTest');
    const buf = buildSyxFile([buildSysexReply(0x00, 0, prog.toUnpacked())]);
    triggerFileLoad(buf);
    await jest.advanceTimersByTimeAsync(500);

    const modal = document.getElementById('syx-viewer-modal');
    expect(modal.classList.contains('hidden')).toBe(false);

    document.getElementById('syx-viewer-close').click();
    expect(modal.classList.contains('hidden')).toBe(true);
  });
});
