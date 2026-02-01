import { jest } from '@jest/globals';
import { MockMIDIAccess, MockMIDIInput, MockMIDIOutput, setMockMIDIAccess } from './setup.js';

let mockAccess;
let qsrInput;
let qsrOutput;

function setupDOM() {
  document.body.innerHTML = `
    <div class="lcd" id="status">
      <div class="lcd-line1" id="lcd-line1">Ready</div>
      <div class="lcd-line2" id="lcd-line2"></div>
    </div>
    <button id="prog-btn" disabled>PROG</button>
    <button id="mix-btn" disabled>MIX</button>
    <select id="bank-select" disabled>
      <option value="0">User</option>
      <option value="1">Preset 1</option>
      <option value="2">Preset 2</option>
      <option value="3">Preset 3</option>
      <option value="4">GenMIDI</option>
    </select>
    <label id="patch-label">Program</label>
    <span class="patch-display" id="patch-display">000</span>
    <button id="patch-prev" disabled></button>
    <button id="patch-next" disabled></button>
    <button id="rescan-btn">Rescan</button>
    <button id="advanced-btn">Advanced</button>
    <div id="advanced-panel" class="hidden"></div>
    <select id="device-select"><option disabled selected>No devices</option></select>
    <button id="identify-btn" disabled>Identify Device</button>
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
    <button id="search-btn" disabled>Search</button>
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

function autoReplyIdentity(output, input) {
  output.send = jest.fn(function (data) {
    const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
    // Reply to device inquiry
    if (arr[0] === 0xF0 && arr[1] === 0x7E && arr[4] === 0x01) {
      setTimeout(() => input.receive(QSR_IDENTITY_REPLY), 0);
    }
  });
}

beforeEach(async () => {
  jest.resetModules();
  jest.useFakeTimers();
  localStorage.clear();
  setupDOM();
  mockAccess = new MockMIDIAccess();
  const dev = mockAccess.addDevice('Alesis QSR');
  qsrInput = dev.input;
  qsrOutput = dev.output;
  autoReplyIdentity(qsrOutput, qsrInput);
  setMockMIDIAccess(mockAccess);
});

afterEach(() => {
  jest.useRealTimers();
});

async function loadApp() {
  const mod = await import('../public/js/app.js');
  // Let init() run: requestMIDIAccess -> autoScan -> queryDeviceIdentity
  await jest.advanceTimersByTimeAsync(100);
  // Let patch name request timeout
  await jest.advanceTimersByTimeAsync(3000);
  return mod;
}

// --- Initialization ---

describe('initialization', () => {
  test('auto-scans and finds QSR device', async () => {
    await loadApp();
    const lcd1 = document.getElementById('lcd-line1');
    expect(lcd1.textContent).toContain('Alesis');
    expect(lcd1.textContent).toContain('QSR');
  });

  test('enables mode buttons after connecting', async () => {
    await loadApp();
    expect(document.getElementById('prog-btn').disabled).toBe(false);
    expect(document.getElementById('mix-btn').disabled).toBe(false);
  });

  test('starts in Program mode', async () => {
    await loadApp();
    expect(document.getElementById('prog-btn').classList.contains('active')).toBe(true);
    expect(document.getElementById('mix-btn').classList.contains('active')).toBe(false);
    expect(document.getElementById('patch-label').textContent).toBe('Program');
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
  test('clicking MIX switches to mix mode', async () => {
    await loadApp();
    document.getElementById('mix-btn').click();
    await jest.advanceTimersByTimeAsync(100);

    expect(document.getElementById('mix-btn').classList.contains('active')).toBe(true);
    expect(document.getElementById('prog-btn').classList.contains('active')).toBe(false);
    expect(document.getElementById('patch-label').textContent).toBe('Mix');
  });

  test('sends MIDI Program Select = Channel 1 when switching to mix mode', async () => {
    await loadApp();
    qsrOutput.send.mockClear();
    document.getElementById('mix-btn').click();
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
    document.getElementById('mix-btn').click();
    await jest.advanceTimersByTimeAsync(100);
    qsrOutput.send.mockClear();

    document.getElementById('prog-btn').click();
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
    document.getElementById('patch-next').click();
    await jest.advanceTimersByTimeAsync(100);

    document.getElementById('mix-btn').click();
    await jest.advanceTimersByTimeAsync(100);

    expect(document.getElementById('patch-display').textContent).toBe('000');
  });

  test('mode buttons ignored when no active device', async () => {
    mockAccess = new MockMIDIAccess();
    setMockMIDIAccess(mockAccess);
    await loadApp();
    // Should not throw
    document.getElementById('prog-btn').click();
    document.getElementById('mix-btn').click();
  });
});

// --- Bank Selection ---

describe('bank selection', () => {
  test('changing bank sends bank select MSB + LSB + program change', async () => {
    await loadApp();
    qsrOutput.send.mockClear();

    const bankSelect = document.getElementById('bank-select');
    bankSelect.value = '2';
    bankSelect.dispatchEvent(new Event('change'));
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
    document.getElementById('patch-next').click();
    await jest.advanceTimersByTimeAsync(100);

    const bankSelect = document.getElementById('bank-select');
    bankSelect.value = '1';
    bankSelect.dispatchEvent(new Event('change'));
    await jest.advanceTimersByTimeAsync(100);

    expect(document.getElementById('patch-display').textContent).toBe('000');
  });

  test('bank select ignored when no active device', async () => {
    mockAccess = new MockMIDIAccess();
    setMockMIDIAccess(mockAccess);
    await loadApp();

    const bankSelect = document.getElementById('bank-select');
    bankSelect.value = '2';
    bankSelect.dispatchEvent(new Event('change'));
  });
});

// --- Patch Navigation ---

describe('patch navigation', () => {
  test('next button increments patch', async () => {
    await loadApp();
    document.getElementById('patch-next').click();
    await jest.advanceTimersByTimeAsync(100);
    expect(document.getElementById('patch-display').textContent).toBe('001');
  });

  test('prev button decrements patch', async () => {
    await loadApp();
    document.getElementById('patch-next').click();
    document.getElementById('patch-next').click();
    await jest.advanceTimersByTimeAsync(100);

    document.getElementById('patch-prev').click();
    await jest.advanceTimersByTimeAsync(100);
    expect(document.getElementById('patch-display').textContent).toBe('001');
  });

  test('wraps from 127 to 0 in prog mode', async () => {
    await loadApp();
    // Click next 128 times to go from 0 to 127, then wrap to 0
    for (let i = 0; i < 128; i++) {
      document.getElementById('patch-next').click();
    }
    await jest.advanceTimersByTimeAsync(100);
    expect(document.getElementById('patch-display').textContent).toBe('000');
  });

  test('wraps from 0 to 127 going backwards in prog mode', async () => {
    await loadApp();
    document.getElementById('patch-prev').click();
    await jest.advanceTimersByTimeAsync(100);
    expect(document.getElementById('patch-display').textContent).toBe('127');
  });

  test('wraps from 0 to 99 going backwards in mix mode', async () => {
    await loadApp();
    document.getElementById('mix-btn').click();
    await jest.advanceTimersByTimeAsync(100);

    document.getElementById('patch-prev').click();
    await jest.advanceTimersByTimeAsync(100);
    expect(document.getElementById('patch-display').textContent).toBe('099');
  });

  test('wraps from 99 to 0 in mix mode', async () => {
    await loadApp();
    document.getElementById('mix-btn').click();
    await jest.advanceTimersByTimeAsync(100);

    for (let i = 0; i < 100; i++) {
      document.getElementById('patch-next').click();
    }
    await jest.advanceTimersByTimeAsync(100);
    expect(document.getElementById('patch-display').textContent).toBe('000');
  });

  test('patch buttons ignored when no active device', async () => {
    mockAccess = new MockMIDIAccess();
    setMockMIDIAccess(mockAccess);
    await loadApp();
    document.getElementById('patch-next').click();
    document.getElementById('patch-prev').click();
  });
});

// --- Rescan ---

describe('rescan', () => {
  test('rescan button triggers new scan', async () => {
    await loadApp();
    qsrOutput.send.mockClear();
    document.getElementById('rescan-btn').click();
    await jest.advanceTimersByTimeAsync(3000);
    // Should have sent identity inquiry again
    const inquiryCalls = qsrOutput.send.mock.calls.filter(c => {
      const d = c[0] instanceof Uint8Array ? c[0] : new Uint8Array(c[0]);
      return d[0] === 0xF0 && d[1] === 0x7E;
    });
    expect(inquiryCalls.length).toBeGreaterThan(0);
  });
});

// --- Advanced Panel ---

describe('advanced panel', () => {
  test('toggle advanced panel visibility', async () => {
    await loadApp();
    const panel = document.getElementById('advanced-panel');
    expect(panel.classList.contains('hidden')).toBe(true);

    document.getElementById('advanced-btn').click();
    expect(panel.classList.contains('hidden')).toBe(false);

    document.getElementById('advanced-btn').click();
    expect(panel.classList.contains('hidden')).toBe(true);
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
    document.getElementById('mix-btn').click();
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
    document.getElementById('patch-next').click();
    await jest.advanceTimersByTimeAsync(3000);
    const lcd2 = document.getElementById('lcd-line2');
    expect(lcd2.innerHTML).toContain('001');
  });
});

// --- Preset names for non-User banks ---

describe('preset name lookup', () => {
  test('shows preset name when switching to bank 1 in prog mode', async () => {
    await loadApp();

    const bankSel = document.getElementById('bank-select');
    bankSel.value = '1';
    bankSel.dispatchEvent(new Event('change'));
    await jest.advanceTimersByTimeAsync(100);

    const lcd2 = document.getElementById('lcd-line2');
    expect(lcd2.innerHTML).toContain('TrueStereo');
  });

  test('shows preset name when switching to bank 4 (GM) in prog mode', async () => {
    await loadApp();

    const bankSel = document.getElementById('bank-select');
    bankSel.value = '4';
    bankSel.dispatchEvent(new Event('change'));
    await jest.advanceTimersByTimeAsync(100);

    const lcd2 = document.getElementById('lcd-line2');
    expect(lcd2.innerHTML).toContain('AcGrandPno');
  });

  test('shows preset mix name when in mix mode bank 1', async () => {
    await loadApp();
    document.getElementById('mix-btn').click();
    await jest.advanceTimersByTimeAsync(100);

    const bankSel = document.getElementById('bank-select');
    bankSel.value = '1';
    bankSel.dispatchEvent(new Event('change'));
    await jest.advanceTimersByTimeAsync(100);

    const lcd2 = document.getElementById('lcd-line2');
    expect(lcd2.innerHTML).toContain('Zen Piano');
  });

  test('navigating patches updates preset name', async () => {
    await loadApp();

    const bankSel = document.getElementById('bank-select');
    bankSel.value = '1';
    bankSel.dispatchEvent(new Event('change'));
    await jest.advanceTimersByTimeAsync(100);

    document.getElementById('patch-next').click();
    await jest.advanceTimersByTimeAsync(100);

    const lcd2 = document.getElementById('lcd-line2');
    expect(lcd2.innerHTML).toContain('Titanium88');
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

  function buildProgramDumpReply(patchNum, name) {
    const charVals = Array.from(name.padEnd(10)).map(c => c.charCodeAt(0) - 32);
    const bits = [];
    for (let i = 0; i < 8; i++) bits.push(0);
    for (const val of charVals) {
      for (let bit = 0; bit < 7; bit++) bits.push((val >> bit) & 1);
    }
    while (bits.length % 56 !== 0) bits.push(0);
    const unpackedBytes = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let b = 0; b < 8 && (i + b) < bits.length; b++) byte |= bits[i + b] << b;
      unpackedBytes.push(byte);
    }
    const packed = packQSData(unpackedBytes);
    const response = new Uint8Array(7 + packed.length + 1);
    response[0] = 0xF0;
    response[1] = 0x00; response[2] = 0x00; response[3] = 0x0E; response[4] = 0x0E;
    response[5] = 0x00;
    response[6] = patchNum & 0x7F;
    for (let i = 0; i < packed.length; i++) response[7 + i] = packed[i];
    response[response.length - 1] = 0xF7;
    return response;
  }

  test('discards stale patch name when a newer fetch supersedes it', async () => {
    // Set up output to auto-reply with patch names, but with a delay
    const origSend = qsrOutput.send;
    qsrOutput.send = jest.fn(function (data) {
      const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
      // Identity inquiry
      if (arr[0] === 0xF0 && arr[1] === 0x7E && arr[4] === 0x01) {
        setTimeout(() => qsrInput.receive(QSR_IDENTITY_REPLY), 0);
        return;
      }
      // Program dump request
      if (arr[0] === 0xF0 && arr[5] === 0x01) {
        const num = arr[6];
        // Reply with delay so we can trigger a second fetch before this resolves
        setTimeout(() => {
          qsrInput.receive(buildProgramDumpReply(num, `Patch${num}   `));
        }, 100);
      }
    });

    await loadApp();

    // First click: starts fetch for patch 1
    document.getElementById('patch-next').click();
    // Immediately click again before patch 1 reply arrives: starts fetch for patch 2
    document.getElementById('patch-next').click();

    // Advance past the delayed replies
    await jest.advanceTimersByTimeAsync(500);

    // Patch 1's reply should be discarded (stale), patch 2's name should show
    const lcd2 = document.getElementById('lcd-line2');
    expect(document.getElementById('patch-display').textContent).toBe('002');
  });
});

// --- localStorage persistence ---

describe('localStorage persistence', () => {
  test('restores saved mode/bank/patch on reconnect', async () => {
    localStorage.setItem('qsr-control-state', JSON.stringify({
      mode: 'mix', bank: 2, patch: 42,
    }));
    await loadApp();

    expect(document.getElementById('mix-btn').classList.contains('active')).toBe(true);
    expect(document.getElementById('bank-select').value).toBe('2');
    expect(document.getElementById('patch-display').textContent).toBe('042');
    expect(document.getElementById('patch-label').textContent).toBe('Mix');
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
    expect(document.getElementById('prog-btn').classList.contains('active')).toBe(true);
    expect(document.getElementById('bank-select').value).toBe('0');
    expect(document.getElementById('patch-display').textContent).toBe('000');
  });

  test('ignores corrupt localStorage data', async () => {
    localStorage.setItem('qsr-control-state', '{bad json!!!');
    await loadApp();
    // Should fall back to defaults
    expect(document.getElementById('prog-btn').classList.contains('active')).toBe(true);
    expect(document.getElementById('patch-display').textContent).toBe('000');
  });

  test('ignores invalid state shape', async () => {
    localStorage.setItem('qsr-control-state', JSON.stringify({ mode: 'bad', bank: 'x' }));
    await loadApp();
    expect(document.getElementById('prog-btn').classList.contains('active')).toBe(true);
  });

  test('saves state after bank change', async () => {
    await loadApp();
    const bankSel = document.getElementById('bank-select');
    bankSel.value = '3';
    bankSel.dispatchEvent(new Event('change'));
    await jest.advanceTimersByTimeAsync(100);

    const saved = JSON.parse(localStorage.getItem('qsr-control-state'));
    expect(saved).toEqual({ mode: 'prog', bank: 3, patch: 0 });
  });

  test('saves state after patch change', async () => {
    await loadApp();
    document.getElementById('patch-next').click();
    await jest.advanceTimersByTimeAsync(100);

    const saved = JSON.parse(localStorage.getItem('qsr-control-state'));
    expect(saved.patch).toBe(1);
  });

  test('saves state after mode switch', async () => {
    await loadApp();
    document.getElementById('mix-btn').click();
    await jest.advanceTimersByTimeAsync(100);

    const saved = JSON.parse(localStorage.getItem('qsr-control-state'));
    expect(saved.mode).toBe('mix');
  });
});

// --- Search ---

describe('search', () => {
  test('search button opens modal and shows results', async () => {
    await loadApp();
    const modal = document.getElementById('search-modal');
    expect(modal.classList.contains('hidden')).toBe(true);

    document.getElementById('search-btn').click();
    expect(modal.classList.contains('hidden')).toBe(false);

    // Should show all presets (grouped) when input is empty
    const items = document.querySelectorAll('.search-result-item');
    expect(items.length).toBeGreaterThan(0);
    const headers = document.querySelectorAll('.search-group-header');
    expect(headers.length).toBeGreaterThan(0);
  });

  test('typing filters results', async () => {
    await loadApp();
    document.getElementById('search-btn').click();

    const input = document.getElementById('search-input');
    input.value = 'TrueStereo';
    input.dispatchEvent(new Event('input'));

    const items = document.querySelectorAll('.search-result-item');
    expect(items.length).toBe(1);
    expect(items[0].textContent).toContain('TrueStereo');
  });

  test('filter checkboxes limit by mode', async () => {
    await loadApp();
    document.getElementById('search-btn').click();

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
    document.getElementById('search-btn').click();

    const input = document.getElementById('search-input');
    input.value = 'Titanium88';
    input.dispatchEvent(new Event('input'));

    const items = document.querySelectorAll('.search-result-item');
    items[0].click();
    await jest.advanceTimersByTimeAsync(100);

    const modal = document.getElementById('search-modal');
    expect(modal.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('patch-display').textContent).toBe('001');
    expect(document.getElementById('bank-select').value).toBe('1');
  });

  test('selecting a mix result switches mode', async () => {
    await loadApp();
    document.getElementById('search-btn').click();

    const input = document.getElementById('search-input');
    input.value = 'Zen Piano';
    input.dispatchEvent(new Event('input'));

    const items = document.querySelectorAll('.search-result-item');
    items[0].click();
    await jest.advanceTimersByTimeAsync(100);

    expect(document.getElementById('mix-btn').classList.contains('active')).toBe(true);
    expect(document.getElementById('patch-label').textContent).toBe('Mix');
  });

  test('Escape closes search modal', async () => {
    await loadApp();
    document.getElementById('search-btn').click();

    const input = document.getElementById('search-input');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(document.getElementById('search-modal').classList.contains('hidden')).toBe(true);
  });

  test('clicking backdrop closes search modal', async () => {
    await loadApp();
    document.getElementById('search-btn').click();

    const modal = document.getElementById('search-modal');
    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Click on modal itself (backdrop) should close
    expect(modal.classList.contains('hidden')).toBe(true);
  });

  test('arrow keys navigate results and Enter selects', async () => {
    await loadApp();
    document.getElementById('search-btn').click();

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

  test('search button disabled when no device', async () => {
    mockAccess = new MockMIDIAccess();
    setMockMIDIAccess(mockAccess);
    await loadApp();
    expect(document.getElementById('search-btn').disabled).toBe(true);
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
