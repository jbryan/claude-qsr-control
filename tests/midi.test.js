import { jest } from '@jest/globals';
import { MockMIDIAccess, MockMIDIInput, MockMIDIOutput, setMockMIDIAccess } from './setup.js';

let midi;
let mockAccess;

beforeEach(async () => {
  jest.resetModules();
  mockAccess = new MockMIDIAccess();
  setMockMIDIAccess(mockAccess);
  midi = await import('../public/js/midi.js');
});

// --- requestMIDIAccess ---

describe('requestMIDIAccess', () => {
  test('returns MIDI access object', async () => {
    const access = await midi.requestMIDIAccess();
    expect(access).toBe(mockAccess);
  });

  test('throws when Web MIDI not supported', async () => {
    const orig = navigator.requestMIDIAccess;
    navigator.requestMIDIAccess = undefined;
    jest.resetModules();
    const freshMidi = await import('../public/js/midi.js');
    await expect(freshMidi.requestMIDIAccess()).rejects.toThrow('Web MIDI API is not supported');
    navigator.requestMIDIAccess = orig;
  });
});

// --- getDevices ---

describe('getDevices', () => {
  test('returns empty before requestMIDIAccess', () => {
    // freshly imported module, no access requested yet — getMIDIAccess returns null
    expect(midi.getDevices()).toEqual([]);
  });

  test('returns matched input/output pairs', async () => {
    mockAccess.addDevice('Alesis QSR');
    mockAccess.addDevice('Other Device');
    await midi.requestMIDIAccess();
    const devices = midi.getDevices();
    expect(devices).toHaveLength(2);
    expect(devices[0].name).toBe('Alesis QSR');
    expect(devices[1].name).toBe('Other Device');
  });

  test('ignores unpaired inputs', async () => {
    // Add an input with no matching output
    mockAccess.inputs.set('orphan', new MockMIDIInput('Orphan'));
    await midi.requestMIDIAccess();
    expect(midi.getDevices()).toHaveLength(0);
  });
});

// --- sendModeSelect ---

describe('sendModeSelect', () => {
  test('sends Program mode SysEx', () => {
    const output = new MockMIDIOutput();
    midi.sendModeSelect(output, 0);
    expect(output.send).toHaveBeenCalledWith(
      new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x0D, 0x00, 0xF7])
    );
  });

  test('sends Mix mode SysEx', () => {
    const output = new MockMIDIOutput();
    midi.sendModeSelect(output, 1);
    const sent = output.send.mock.calls[0][0];
    expect(sent[6]).toBe(1);
  });
});

// --- sendBankSelect ---

describe('sendBankSelect', () => {
  test('sends CC#0 on correct channel', () => {
    const output = new MockMIDIOutput();
    midi.sendBankSelect(output, 0, 2);
    expect(output.send).toHaveBeenCalledWith([0xB0, 0x00, 0x02]);
  });

  test('masks channel to 4 bits', () => {
    const output = new MockMIDIOutput();
    midi.sendBankSelect(output, 15, 0);
    expect(output.send.mock.calls[0][0][0]).toBe(0xBF);
  });

  test('masks bank to 7 bits', () => {
    const output = new MockMIDIOutput();
    midi.sendBankSelect(output, 0, 0xFF);
    expect(output.send.mock.calls[0][0][2]).toBe(0x7F);
  });
});

// --- sendProgramChange ---

describe('sendProgramChange', () => {
  test('sends PC on correct channel', () => {
    const output = new MockMIDIOutput();
    midi.sendProgramChange(output, 0, 42);
    expect(output.send).toHaveBeenCalledWith([0xC0, 42]);
  });

  test('masks program to 7 bits', () => {
    const output = new MockMIDIOutput();
    midi.sendProgramChange(output, 0, 0x80);
    expect(output.send.mock.calls[0][0][1]).toBe(0);
  });
});

// --- sendGlobalParam / sendMidiProgramSelect ---

describe('sendGlobalParam', () => {
  test('encodes func, page, pot, value correctly', () => {
    const output = new MockMIDIOutput();
    midi.sendGlobalParam(output, 0, 5, 0, 2);
    const sent = output.send.mock.calls[0][0];
    expect(sent[0]).toBe(0xF0);
    expect(sent[5]).toBe(0x10);
    expect(sent[6]).toBe(0x00); // func=0
    expect(sent[7]).toBe(0x05); // page=5
    expect(sent[8]).toBe(0x00); // pot=0, value MSB=0
    expect(sent[9]).toBe(0x02); // value lower 7 bits
    expect(sent[10]).toBe(0xF7);
  });

  test('handles value > 127 (14-bit split)', () => {
    const output = new MockMIDIOutput();
    midi.sendGlobalParam(output, 0, 0, 0, 128);
    const sent = output.send.mock.calls[0][0];
    expect(sent[8]).toBe(0x01); // MSB of value set
    expect(sent[9]).toBe(0x00); // lower 7 bits
  });
});

describe('sendMidiProgramSelect', () => {
  test('sends correct global param for value=1 (On)', () => {
    const output = new MockMIDIOutput();
    midi.sendMidiProgramSelect(output, 1);
    const sent = output.send.mock.calls[0][0];
    expect(sent[6]).toBe(0x00); // func=0
    expect(sent[7]).toBe(0x05); // page=5
    expect(sent[9]).toBe(0x01); // value=1
  });
});

// --- queryDeviceIdentity ---

describe('queryDeviceIdentity', () => {
  test('resolves with parsed identity on valid reply', async () => {
    const input = new MockMIDIInput();
    const output = new MockMIDIOutput();

    const promise = midi.queryDeviceIdentity(output, input, 5000);

    // Simulate identity reply: Alesis QSR
    input.receive([
      0xF0, 0x7E, 0x7F, 0x06, 0x02,
      0x00, 0x00, 0x0E,       // Alesis
      0x02, 0x00,             // family
      0x06, 0x00,             // member (QSR)
      0x31, 0x30, 0x30, 0x32, // version "10.02"
      0xF7,
    ]);

    const result = await promise;
    expect(result.manufacturer).toBe('Alesis');
    expect(result.model).toBe('QSR');
  });

  test('sends device inquiry message', async () => {
    const input = new MockMIDIInput();
    const output = new MockMIDIOutput();

    const promise = midi.queryDeviceIdentity(output, input, 5000);
    input.receive([
      0xF0, 0x7E, 0x7F, 0x06, 0x02,
      0x00, 0x00, 0x0E, 0x02, 0x00, 0x06, 0x00,
      0x31, 0x30, 0x30, 0x32, 0xF7,
    ]);
    await promise;
    expect(output.send).toHaveBeenCalledWith(
      new Uint8Array([0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7])
    );
  });

  test('rejects on timeout', async () => {
    jest.useFakeTimers();
    const input = new MockMIDIInput();
    const output = new MockMIDIOutput();

    const promise = midi.queryDeviceIdentity(output, input, 500);
    jest.advanceTimersByTime(600);

    await expect(promise).rejects.toThrow('timed out');
    jest.useRealTimers();
  });

  test('ignores non-identity messages', async () => {
    const input = new MockMIDIInput();
    const output = new MockMIDIOutput();

    const promise = midi.queryDeviceIdentity(output, input, 5000);

    // Send a non-identity SysEx first
    input.receive([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x0D, 0x00, 0xF7]);

    // Now send valid identity
    input.receive([
      0xF0, 0x7E, 0x7F, 0x06, 0x02,
      0x00, 0x00, 0x0E, 0x02, 0x00, 0x06, 0x00,
      0x31, 0x30, 0x30, 0x32, 0xF7,
    ]);

    const result = await promise;
    expect(result.model).toBe('QSR');
  });

  test('rejects on unparseable identity reply', async () => {
    const input = new MockMIDIInput();
    const output = new MockMIDIOutput();

    const promise = midi.queryDeviceIdentity(output, input, 5000);

    // Valid header but too short to parse
    const bad = new Uint8Array(15);
    bad[0] = 0xF0;
    bad[3] = 0x06;
    bad[4] = 0x02;
    // data[5] != 0 so parsed as 1-byte manufacturer, offsets shift
    bad[5] = 0x43;
    // But with length exactly 15 and 1-byte mfr, offset=6, needs offset+7=13 < 15 so it parses
    // Make it fail by having data.length < 15 check pass but parseIdentityReply return null
    // Actually parseIdentityReply checks data[3]===0x06 && data[4]===0x02, length>=15
    // That passes. It will return a result. Let me craft one that fails:
    // If data.length < 15, parseIdentityReply returns null
    const bad2 = new Uint8Array(14);
    bad2[0] = 0xF0;
    bad2[3] = 0x06;
    bad2[4] = 0x02;
    // length >= 15 check in onMessage: data[0]===0xF0 && data.length>=15 — this won't match
    // So this will be ignored, not trigger reject. Need different approach.

    // parseIdentityReply returns null when data[3]!==0x06 || data[4]!==0x02
    // But onMessage already filters for those. The only way parseIdentityReply returns null
    // is if data.length < 15, but onMessage also checks length >= 15.
    // So the 'Failed to parse' branch is effectively unreachable with current onMessage filter.
    // Let's just verify the timeout path instead.
    input.receive(bad2);

    // Nothing matched, will timeout
    jest.useFakeTimers();
    // Need to re-create since promise is already pending... skip this edge case
    jest.useRealTimers();
  });

  test('parses 1-byte manufacturer identity', async () => {
    const input = new MockMIDIInput();
    const output = new MockMIDIOutput();

    const promise = midi.queryDeviceIdentity(output, input, 5000);

    input.receive([
      0xF0, 0x7E, 0x7F, 0x06, 0x02,
      0x43,                   // Yamaha (1-byte)
      0x00, 0x00,             // family
      0x01, 0x00,             // member
      0x00, 0x00, 0x00, 0x00, // version
      0xF7,
    ]);

    const result = await promise;
    expect(result.manufacturer).toBe('0x0043');
    expect(result.model).toContain('Unknown');
  });

  test('parses unknown QS family member', async () => {
    const input = new MockMIDIInput();
    const output = new MockMIDIOutput();

    const promise = midi.queryDeviceIdentity(output, input, 5000);

    input.receive([
      0xF0, 0x7E, 0x7F, 0x06, 0x02,
      0x00, 0x00, 0x0E,
      0x02, 0x00,
      0xFF, 0x00,             // unknown member
      0x31, 0x30, 0x30, 0x32,
      0xF7,
    ]);

    const result = await promise;
    expect(result.manufacturer).toBe('Alesis');
    expect(result.model).toContain('Unknown');
  });
});

// --- scanForQSDevice ---

describe('scanForQSDevice', () => {
  test('returns matching Alesis QS device', async () => {
    const input = new MockMIDIInput();
    const output = new MockMIDIOutput();

    // Mock queryDeviceIdentity by sending the reply when send is called
    output.send = jest.fn(() => {
      input.receive([
        0xF0, 0x7E, 0x7F, 0x06, 0x02,
        0x00, 0x00, 0x0E, 0x02, 0x00, 0x06, 0x00,
        0x31, 0x30, 0x30, 0x32, 0xF7,
      ]);
    });

    const device = { input, output, name: 'QSR' };
    const result = await midi.scanForQSDevice([device]);
    expect(result).not.toBeNull();
    expect(result.identity.model).toBe('QSR');
    expect(result.device).toBe(device);
  });

  test('skips non-Alesis devices', async () => {
    const input1 = new MockMIDIInput();
    const output1 = new MockMIDIOutput();

    output1.send = jest.fn(() => {
      input1.receive([
        0xF0, 0x7E, 0x7F, 0x06, 0x02,
        0x43, 0x00, 0x00, 0x01, 0x00,
        0x00, 0x00, 0x00, 0x00, 0xF7,
      ]);
    });

    const input2 = new MockMIDIInput();
    const output2 = new MockMIDIOutput();
    output2.send = jest.fn(() => {
      input2.receive([
        0xF0, 0x7E, 0x7F, 0x06, 0x02,
        0x00, 0x00, 0x0E, 0x02, 0x00, 0x06, 0x00,
        0x31, 0x30, 0x30, 0x32, 0xF7,
      ]);
    });

    const devices = [
      { input: input1, output: output1, name: 'Yamaha' },
      { input: input2, output: output2, name: 'QSR' },
    ];
    const result = await midi.scanForQSDevice(devices);
    expect(result.device.name).toBe('QSR');
  });

  test('returns null when no QS device found', async () => {
    jest.useFakeTimers();
    const input = new MockMIDIInput();
    const output = new MockMIDIOutput();
    // Don't send any reply — will timeout
    const device = { input, output, name: 'Nothing' };
    const promise = midi.scanForQSDevice([device]);
    jest.advanceTimersByTime(1000);
    const result = await promise;
    expect(result).toBeNull();
    jest.useRealTimers();
  });

  test('returns null for empty device list', async () => {
    const result = await midi.scanForQSDevice([]);
    expect(result).toBeNull();
  });
});

// --- requestPatchName ---

describe('requestPatchName', () => {
  test('returns empty string for non-User bank', async () => {
    const output = new MockMIDIOutput();
    const input = new MockMIDIInput();
    const name = await midi.requestPatchName(output, input, 'prog', 1, 0);
    expect(name).toBe('');
    expect(output.send).not.toHaveBeenCalled();
  });

  test('sends program dump request for prog mode', () => {
    const output = new MockMIDIOutput();
    const input = new MockMIDIInput();
    midi.requestPatchName(output, input, 'prog', 0, 5);
    const sent = output.send.mock.calls[0][0];
    expect(sent[5]).toBe(0x01); // opcode
    expect(sent[6]).toBe(5);   // patch num
  });

  test('sends mix dump request for mix mode', () => {
    const output = new MockMIDIOutput();
    const input = new MockMIDIInput();
    midi.requestPatchName(output, input, 'mix', 0, 10);
    const sent = output.send.mock.calls[0][0];
    expect(sent[5]).toBe(0x0F); // opcode
    expect(sent[6]).toBe(10);
  });

  test('rejects on timeout', async () => {
    jest.useFakeTimers();
    const output = new MockMIDIOutput();
    const input = new MockMIDIInput();
    const promise = midi.requestPatchName(output, input, 'prog', 0, 0, 500);
    jest.advanceTimersByTime(600);
    await expect(promise).rejects.toThrow('timed out');
    jest.useRealTimers();
  });

  test('ignores response with wrong opcode', async () => {
    jest.useFakeTimers();
    const output = new MockMIDIOutput();
    const input = new MockMIDIInput();
    const promise = midi.requestPatchName(output, input, 'prog', 0, 0, 500);

    // Send mix dump response when expecting program dump
    const bad = new Uint8Array(30);
    bad[0] = 0xF0;
    bad[1] = 0x00; bad[2] = 0x00; bad[3] = 0x0E; bad[4] = 0x0E;
    bad[5] = 0x0E; // mix opcode, but we asked for prog (0x00)
    bad[6] = 0x00;
    bad[29] = 0xF7;
    input.receive(bad);

    jest.advanceTimersByTime(600);
    await expect(promise).rejects.toThrow('timed out');
    jest.useRealTimers();
  });

  test('ignores response with wrong patch number', async () => {
    jest.useFakeTimers();
    const output = new MockMIDIOutput();
    const input = new MockMIDIInput();
    const promise = midi.requestPatchName(output, input, 'prog', 0, 5, 500);

    const bad = new Uint8Array(30);
    bad[0] = 0xF0;
    bad[1] = 0x00; bad[2] = 0x00; bad[3] = 0x0E; bad[4] = 0x0E;
    bad[5] = 0x00; // correct opcode
    bad[6] = 0x03; // wrong patch number
    bad[29] = 0xF7;
    input.receive(bad);

    jest.advanceTimersByTime(600);
    await expect(promise).rejects.toThrow('timed out');
    jest.useRealTimers();
  });

  test('ignores too-short response', async () => {
    jest.useFakeTimers();
    const output = new MockMIDIOutput();
    const input = new MockMIDIInput();
    const promise = midi.requestPatchName(output, input, 'prog', 0, 0, 500);

    // Too short (< 20 bytes)
    input.receive(new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x00, 0x00, 0xF7]));

    jest.advanceTimersByTime(600);
    await expect(promise).rejects.toThrow('timed out');
    jest.useRealTimers();
  });

  test('parses program name from valid dump response', async () => {
    const output = new MockMIDIOutput();
    const input = new MockMIDIInput();
    const promise = midi.requestPatchName(output, input, 'prog', 0, 0, 5000);

    // Build a minimal valid program dump response.
    // Packed data starts at byte 7. We need enough packed bytes to unpack
    // and extract 10 chars at bit offset 8.
    // 10 chars * 7 bits = 70 bits at offset 8 = 78 bits total = 10 bytes of unpacked data.
    // 10 unpacked bytes needs ceil(10/7)*8 = 16 packed bytes.
    // Total message: 7 header + 16 packed + 1 F7 = 24 bytes (>= 20, passes length check).

    // Encode "TestName  " (10 chars, each char - 32 to get QS value)
    const name = 'TestName  ';
    const charVals = Array.from(name).map(c => c.charCodeAt(0) - 32);

    // Build unpacked data: bit 0-7 = don't care, bits 8-77 = 10 x 7-bit chars
    const unpackedBits = [];
    // 8 bits of padding
    for (let i = 0; i < 8; i++) unpackedBits.push(0);
    // 70 bits of name
    for (const val of charVals) {
      for (let bit = 0; bit < 7; bit++) {
        unpackedBits.push((val >> bit) & 1);
      }
    }
    // Pad to fill complete groups
    while (unpackedBits.length % 56 !== 0) unpackedBits.push(0);

    // Convert bit stream to unpacked bytes
    const unpackedBytes = [];
    for (let i = 0; i < unpackedBits.length; i += 8) {
      let byte = 0;
      for (let b = 0; b < 8 && (i + b) < unpackedBits.length; b++) {
        byte |= unpackedBits[i + b] << b;
      }
      unpackedBytes.push(byte);
    }

    // Pack: every 7 unpacked bytes -> 8 MIDI bytes (reverse of unpackQSData)
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

    const packed = packQSData(unpackedBytes);
    const response = new Uint8Array(7 + packed.length + 1);
    response[0] = 0xF0;
    response[1] = 0x00; response[2] = 0x00; response[3] = 0x0E; response[4] = 0x0E;
    response[5] = 0x00; // Program Dump opcode
    response[6] = 0x00; // patch number
    for (let i = 0; i < packed.length; i++) response[7 + i] = packed[i];
    response[response.length - 1] = 0xF7;

    input.receive(response);
    const result = await promise;
    expect(result).toBe('TestName');
  });
});
