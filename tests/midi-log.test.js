import { jest } from '@jest/globals';
import { logSend, logReceive } from '../public/js/midi-log.js';

let logSpy;

beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

function lastLog() {
  return logSpy.mock.calls[logSpy.mock.calls.length - 1][0];
}

// --- logSend ---

describe('logSend', () => {
  test('Universal Device Inquiry', () => {
    logSend(new Uint8Array([0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7]));
    expect(lastLog()).toContain('Universal Device Identity Inquiry');
    expect(lastLog()).toContain('F0 7E 7F 06 01 F7');
  });

  test('QS Mode Select -> Program', () => {
    logSend(new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x0D, 0x00, 0xF7]));
    expect(lastLog()).toContain('QS Mode Select -> Program');
  });

  test('QS Mode Select -> Mix', () => {
    logSend(new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x0D, 0x01, 0xF7]));
    expect(lastLog()).toContain('QS Mode Select -> Mix');
  });

  test('QS Mode Select -> unknown mode', () => {
    logSend(new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x0D, 0x05, 0xF7]));
    expect(lastLog()).toContain('unknown (5)');
  });

  test('QS Program Dump Request', () => {
    logSend(new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x01, 0x03, 0xF7]));
    expect(lastLog()).toContain('QS Program Dump Request -> User program #3');
  });

  test('QS Mix Dump Request', () => {
    logSend(new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x0F, 0x07, 0xF7]));
    expect(lastLog()).toContain('QS Mix Dump Request -> User mix #7');
  });

  test('QS Direct Parameter Edit (MIDI Program Select = Off)', () => {
    // func=0, page=5, pot=0, value=0
    logSend(new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x10, 0x00, 0x05, 0x00, 0x00, 0xF7]));
    expect(lastLog()).toContain('MIDI Program Select = Off');
  });

  test('QS Direct Parameter Edit (MIDI Program Select = On)', () => {
    // func=0, page=5, pot=0, value=1
    logSend(new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x10, 0x00, 0x05, 0x00, 0x01, 0xF7]));
    expect(lastLog()).toContain('MIDI Program Select = On');
  });

  test('QS Direct Parameter Edit (MIDI Program Select = Channel 1)', () => {
    // func=0, page=5, pot=0, value=2
    logSend(new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x10, 0x00, 0x05, 0x00, 0x02, 0xF7]));
    expect(lastLog()).toContain('MIDI Program Select = Channel 1');
  });

  test('QS Direct Parameter Edit (non-ProgSelect param)', () => {
    // func=1, page=2, pot=0, value=10
    logSend(new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x10, 0x01, 0x02, 0x00, 0x0A, 0xF7]));
    const log = lastLog();
    expect(log).toContain('func=1');
    expect(log).toContain('page=2');
    expect(log).not.toContain('MIDI Program Select');
  });

  test('QS SysEx with unknown opcode', () => {
    logSend(new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x02, 0x00, 0xF7]));
    expect(lastLog()).toContain('QS SysEx:');
    expect(lastLog()).toContain('8 bytes');
  });

  test('Unknown SysEx message', () => {
    logSend(new Uint8Array([0xF0, 0x43, 0x10, 0x00, 0xF7]));
    expect(lastLog()).toContain('SysEx message (5 bytes)');
  });

  test('Bank Select MSB (User bank)', () => {
    logSend([0xB0, 0x00, 0x00]);
    expect(lastLog()).toContain('Bank Select MSB -> User (bank 0) on channel 1');
  });

  test('Bank Select MSB (Preset 1)', () => {
    logSend([0xB0, 0x00, 0x01]);
    expect(lastLog()).toContain('Bank Select MSB -> Preset 1 (bank 1) on channel 1');
  });

  test('Bank Select MSB (unknown bank number)', () => {
    logSend([0xB0, 0x00, 0x10]);
    expect(lastLog()).toContain('Bank Select MSB -> #16 (bank 16) on channel 1');
  });

  test('Generic CC message', () => {
    logSend([0xB1, 0x07, 0x64]);
    expect(lastLog()).toContain('Control Change CC#7 = 100 on channel 2');
  });

  test('Program Change', () => {
    logSend([0xC0, 0x05]);
    expect(lastLog()).toContain('Program Change -> #5 on channel 1');
  });

  test('Unknown channel message', () => {
    logSend([0x90, 0x3C, 0x7F]);
    expect(lastLog()).toContain('MIDI message (status 0x90) on channel 1');
  });

  test('accepts plain array', () => {
    logSend([0xC0, 0x00]);
    expect(lastLog()).toContain('Program Change');
  });
});

// --- logReceive ---

describe('logReceive', () => {
  test('Device Identity Reply (3-byte manufacturer)', () => {
    // F0 7E 7F 06 02 00 00 0E  familyLo familyHi memberLo memberHi v1 v2 v3 v4 F7
    const reply = new Uint8Array([
      0xF0, 0x7E, 0x7F, 0x06, 0x02,
      0x00, 0x00, 0x0E,         // manufacturer (3-byte)
      0x02, 0x00,               // family code
      0x06, 0x00,               // member code (QSR)
      0x31, 0x30, 0x30, 0x32,   // version
      0xF7,
    ]);
    logReceive(reply);
    expect(lastLog()).toContain('Device Identity Reply');
    expect(lastLog()).toContain('QSR');
  });

  test('Device Identity Reply (1-byte manufacturer)', () => {
    const reply = new Uint8Array([
      0xF0, 0x7E, 0x7F, 0x06, 0x02,
      0x43,                     // 1-byte manufacturer (Yamaha)
      0x00, 0x00,               // family
      0x01, 0x00,               // member
      0x00, 0x00, 0x00, 0x00,   // version
      0xF7,
    ]);
    logReceive(reply);
    expect(lastLog()).toContain('Device Identity Reply');
    expect(lastLog()).toContain('0x43');
    expect(lastLog()).toContain('member 0x1');
  });

  test('QS Program Dump response', () => {
    const data = new Uint8Array(30);
    data[0] = 0xF0;
    data[1] = 0x00; data[2] = 0x00; data[3] = 0x0E; data[4] = 0x0E;
    data[5] = 0x00; data[6] = 0x05;
    data[29] = 0xF7;
    logReceive(data);
    expect(lastLog()).toContain('QS Program Dump <- program #5');
  });

  test('QS Mix Dump response', () => {
    const data = new Uint8Array(30);
    data[0] = 0xF0;
    data[1] = 0x00; data[2] = 0x00; data[3] = 0x0E; data[4] = 0x0E;
    data[5] = 0x0E; data[6] = 0x02;
    data[29] = 0xF7;
    logReceive(data);
    expect(lastLog()).toContain('QS Mix Dump <- mix #2');
  });

  test('QS SysEx unknown opcode response', () => {
    const data = new Uint8Array(10);
    data[0] = 0xF0;
    data[1] = 0x00; data[2] = 0x00; data[3] = 0x0E; data[4] = 0x0E;
    data[5] = 0x03;
    data[9] = 0xF7;
    logReceive(data);
    expect(lastLog()).toContain('QS SysEx Response');
  });

  test('Unknown SysEx received', () => {
    logReceive(new Uint8Array([0xF0, 0x43, 0x10, 0xF7]));
    expect(lastLog()).toContain('SysEx message received (4 bytes)');
  });

  test('Non-SysEx message falls through to describeSend', () => {
    logReceive([0xC0, 0x05]);
    expect(lastLog()).toContain('Program Change -> #5 on channel 1');
  });

  test('Large SysEx is truncated in hex output', () => {
    const big = new Uint8Array(100);
    big[0] = 0xF0;
    big[1] = 0x00; big[2] = 0x00; big[3] = 0x0E; big[4] = 0x0E;
    big[5] = 0x00; big[6] = 0x01;
    big[99] = 0xF7;
    logReceive(big);
    expect(lastLog()).toContain('100 bytes total');
  });

  test('Small SysEx is not truncated', () => {
    const small = new Uint8Array(20);
    small[0] = 0xF0;
    small[1] = 0x00; small[2] = 0x00; small[3] = 0x0E; small[4] = 0x0E;
    small[5] = 0x00; small[6] = 0x00;
    small[19] = 0xF7;
    logReceive(small);
    expect(lastLog()).not.toContain('bytes total');
  });
});
