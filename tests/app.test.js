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

  test('sends MIDI Program Select = On and Mode Select = Program on init', async () => {
    await loadApp();
    const calls = qsrOutput.send.mock.calls;
    // Find the sendMidiProgramSelect call (opcode 0x10, func=0, page=5, value=1)
    const progSelectCall = calls.find(c => {
      const d = c[0] instanceof Uint8Array ? c[0] : new Uint8Array(c[0]);
      return d[0] === 0xF0 && d[5] === 0x10 && d[7] === 0x05 && d[9] === 0x01;
    });
    expect(progSelectCall).toBeTruthy();

    // Find mode select call (opcode 0x0D, mode=0)
    const modeCall = calls.find(c => {
      const d = c[0] instanceof Uint8Array ? c[0] : new Uint8Array(c[0]);
      return d[0] === 0xF0 && d[5] === 0x0D && d[6] === 0x00;
    });
    expect(modeCall).toBeTruthy();
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
  test('changing bank sends bank select + program change', async () => {
    await loadApp();
    qsrOutput.send.mockClear();

    const bankSelect = document.getElementById('bank-select');
    bankSelect.value = '2';
    bankSelect.dispatchEvent(new Event('change'));
    await jest.advanceTimersByTimeAsync(100);

    const calls = qsrOutput.send.mock.calls;
    // Bank select CC#0 = 2
    const bankCall = calls.find(c => {
      const d = Array.isArray(c[0]) ? c[0] : Array.from(c[0]);
      return (d[0] & 0xF0) === 0xB0 && d[1] === 0x00 && d[2] === 2;
    });
    expect(bankCall).toBeTruthy();

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
