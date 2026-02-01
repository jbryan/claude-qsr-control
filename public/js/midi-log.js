// MIDI message logger — plain English + hex wire format

const BANK_NAMES = ['User', 'Preset 1', 'Preset 2', 'Preset 3', 'GenMIDI'];
const MODE_NAMES = { 0: 'Program', 1: 'Mix' };
const QS_OPCODE_NAMES = {
  0x00: 'Program Dump',
  0x01: 'Program Dump Request',
  0x0D: 'Mode Select',
  0x0E: 'Mix Dump',
  0x0F: 'Mix Dump Request',
  0x10: 'Direct Parameter Edit',
};

function hex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function describeSend(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  // SysEx
  if (data[0] === 0xF0) {
    // Universal Device Inquiry
    if (data[1] === 0x7E && data[3] === 0x06 && data[4] === 0x01) {
      return 'Universal Device Identity Inquiry (broadcast)';
    }
    // Alesis QS SysEx: F0 00 00 0E 0E <opcode> ...
    if (data[1] === 0x00 && data[2] === 0x00 && data[3] === 0x0E && data[4] === 0x0E) {
      const opcode = data[5];
      const opName = QS_OPCODE_NAMES[opcode] || `Opcode 0x${opcode.toString(16).padStart(2, '0')}`;

      if (opcode === 0x0D) {
        const mode = MODE_NAMES[data[6]] || `unknown (${data[6]})`;
        return `QS Mode Select -> ${mode}`;
      }
      if (opcode === 0x01) {
        return `QS Program Dump Request -> User program #${data[6]}`;
      }
      if (opcode === 0x0F) {
        return `QS Mix Dump Request -> User mix #${data[6]}`;
      }
      if (opcode === 0x10) {
        const func = data[6] & 0x1F;
        const page = data[7] & 0x1F;
        const pot = (data[8] >> 1) & 0x03;
        const value = ((data[8] & 0x01) << 7) | (data[9] & 0x7F);
        let extra = '';
        if (func === 0 && page === 5 && pot === 0) {
          const valNames = ['Off', 'On'];
          extra = ` (MIDI Program Select = ${valNames[value] || `Channel ${value - 1}`})`;
        }
        return `QS Direct Parameter Edit -> func=${func} page=${page} pot=${pot} value=${value}${extra}`;
      }
      return `QS SysEx: ${opName} (${data.length} bytes)`;
    }
    return `SysEx message (${data.length} bytes)`;
  }

  const status = data[0] & 0xF0;
  const ch = (data[0] & 0x0F) + 1;

  // CC
  if (status === 0xB0) {
    const cc = data[1];
    const val = data[2];
    if (cc === 0x00) {
      const bankName = BANK_NAMES[val] || `#${val}`;
      return `Bank Select MSB -> ${bankName} (bank ${val}) on channel ${ch}`;
    }
    return `Control Change CC#${cc} = ${val} on channel ${ch}`;
  }

  // Program Change
  if (status === 0xC0) {
    return `Program Change -> #${data[1]} on channel ${ch}`;
  }

  return `MIDI message (status 0x${status.toString(16).toUpperCase()}) on channel ${ch}`;
}

function describeReceive(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  if (data[0] === 0xF0) {
    // Identity Reply
    if (data[1] === 0x7E && data.length >= 15 && data[3] === 0x06 && data[4] === 0x02) {
      const isThreeByte = data[5] === 0x00;
      const mfr = isThreeByte
        ? `0x${((data[5] << 16) | (data[6] << 8) | data[7]).toString(16).padStart(6, '0')}`
        : `0x${data[5].toString(16).padStart(2, '0')}`;
      const offset = isThreeByte ? 8 : 6;
      const member = data[offset + 2] | (data[offset + 3] << 8);
      const MODELS = { 0x03: 'QS6', 0x04: 'QS8', 0x05: 'QS7', 0x06: 'QSR' };
      const model = MODELS[member] || `member 0x${member.toString(16)}`;
      return `Device Identity Reply <- manufacturer ${mfr}, model ${model}`;
    }
    // Alesis QS SysEx response
    if (data[1] === 0x00 && data[2] === 0x00 && data[3] === 0x0E && data[4] === 0x0E) {
      const opcode = data[5];
      const opName = QS_OPCODE_NAMES[opcode] || `Opcode 0x${opcode.toString(16).padStart(2, '0')}`;
      if (opcode === 0x00) {
        return `QS Program Dump <- program #${data[6]} (${data.length} bytes)`;
      }
      if (opcode === 0x0E) {
        return `QS Mix Dump <- mix #${data[6]} (${data.length} bytes)`;
      }
      return `QS SysEx Response: ${opName} (${data.length} bytes)`;
    }
    return `SysEx message received (${data.length} bytes)`;
  }

  // Fall through to same logic as send for channel messages
  return describeSend(bytes);
}

export function logSend(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  console.log(`%c[MIDI TX] %c${describeSend(data)}%c\n         ${hex(data)}`,
    'color: #4CAF50; font-weight: bold',
    'color: #E0E0E0',
    'color: #888');
}

export function logReceive(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const hexStr = data.length > 64
    ? hex(data.slice(0, 64)) + ` ... (${data.length} bytes total)`
    : hex(data);
  console.log(`%c[MIDI RX] %c${describeReceive(data)}%c\n         ${hexStr}`,
    'color: #2196F3; font-weight: bold',
    'color: #E0E0E0',
    'color: #888');
}
