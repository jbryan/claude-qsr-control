import { logSend, logReceive } from './midi-log.js';

let midiAccess = null;

export async function requestMIDIAccess() {
  if (!navigator.requestMIDIAccess) {
    throw new Error('Web MIDI API is not supported in this browser');
  }
  midiAccess = await navigator.requestMIDIAccess({ sysex: true });
  return midiAccess;
}

export function getMIDIAccess() {
  return midiAccess;
}

export function getDevices() {
  if (!midiAccess) return [];

  const outputs = new Map();
  for (const [id, output] of midiAccess.outputs) {
    outputs.set(output.name, { id, output });
  }

  const devices = [];
  for (const [id, input] of midiAccess.inputs) {
    const match = outputs.get(input.name);
    if (match) {
      devices.push({
        id: match.id,
        name: input.name,
        input,
        output: match.output,
      });
    }
  }

  return devices;
}

const DEVICE_INQUIRY = new Uint8Array([0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7]);

const FAMILY_MEMBER_LOOKUP = {
  0x03: 'QS6',
  0x04: 'QS8',
  0x05: 'QS7',
  0x06: 'QSR',
};

function parseIdentityReply(data) {
  // Identity Reply: F0 7E <channel> 06 02 <manufacturer...> <family> <member> <version...> F7
  if (data.length < 15 || data[3] !== 0x06 || data[4] !== 0x02) {
    return null;
  }

  const manufacturerId = data[5] === 0x00
    ? (data[5] << 16) | (data[6] << 8) | data[7]
    : data[5];

  const isThreeByte = data[5] === 0x00;
  const offset = isThreeByte ? 8 : 6;

  const familyCode = data[offset] | (data[offset + 1] << 8);
  const memberCode = data[offset + 2] | (data[offset + 3] << 8);
  const version = [
    data[offset + 4],
    data[offset + 5],
    data[offset + 6],
    data[offset + 7],
  ];

  const model = FAMILY_MEMBER_LOOKUP[memberCode] || `Unknown (0x${memberCode.toString(16).padStart(2, '0')})`;

  const manufacturerName = manufacturerId === 0x000E ? 'Alesis' : `0x${manufacturerId.toString(16).padStart(4, '0')}`;

  return {
    manufacturer: manufacturerName,
    model,
    softwareVersion: String.fromCharCode(...version.slice(0,-2)) + "." + String.fromCharCode(...version.slice(-2)),
  };
}

export async function scanForQSDevice(devices) {
  for (const device of devices) {
    try {
      const identity = await queryDeviceIdentity(device.output, device.input, 500);
      if (identity.manufacturer === 'Alesis' && !identity.model.startsWith('Unknown')) {
        return { device, identity };
      }
    } catch {
      // Timeout or parse error — try next device
    }
  }
  return null;
}

export function sendModeSelect(output, mode) {
  const sysex = new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x0D, mode, 0xF7]);
  logSend(sysex);
  output.send(sysex);
}

export function sendBankSelect(output, channel, bank) {
  // CC#0 (Bank Select MSB)
  const msg = [0xB0 | (channel & 0x0F), 0x00, bank & 0x7F];
  logSend(msg);
  output.send(msg);
}

export function sendProgramChange(output, channel, program) {
  const msg = [0xC0 | (channel & 0x0F), program & 0x7F];
  logSend(msg);
  output.send(msg);
}

// SysEx opcode 0x10 — direct parameter editing
// Byte layout: F0 00 00 0E 0E 10 <0mmfffff> <0ssppppp> <0ccccddv> <0vvvvvvv> F7
export function sendGlobalParam(output, func, page, pot, value) {
  const byte1 = func & 0x1F;                           // mm=00 (Global), fffff
  const byte2 = page & 0x1F;                           // ss=00, ppppp
  const byte3 = ((pot & 0x03) << 1) | ((value >> 7) & 0x01); // cccc=0000, dd, MSB of value
  const byte4 = value & 0x7F;                          // lower 7 bits of value
  const sysex = new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x10, byte1, byte2, byte3, byte4, 0xF7]);
  logSend(sysex);
  output.send(sysex);
}

// Set global "MIDI Program Select" (param #13) — func 0, page 5, pot 0
// Values: 0=Off, 1=On, 2=Ch1, 3=Ch2, ... 17=Ch16
export function sendMidiProgramSelect(output, value) {
  sendGlobalParam(output, 0, 5, 0, value);
}

// Unpack QS 7-bit MIDI encoding: every 8 MIDI bytes → 7 QS data bytes
// See qs678syx.htm opcode 00 for the bit layout.
function unpackQSData(packed) {
  const unpacked = [];
  for (let i = 0; i + 7 < packed.length; i += 8) {
    unpacked.push( (packed[i]          & 0x7F) | ((packed[i+1] & 0x01) << 7));
    unpacked.push(((packed[i+1] >> 1)  & 0x3F) | ((packed[i+2] & 0x03) << 6));
    unpacked.push(((packed[i+2] >> 2)  & 0x1F) | ((packed[i+3] & 0x07) << 5));
    unpacked.push(((packed[i+3] >> 3)  & 0x0F) | ((packed[i+4] & 0x0F) << 4));
    unpacked.push(((packed[i+4] >> 4)  & 0x07) | ((packed[i+5] & 0x1F) << 3));
    unpacked.push(((packed[i+5] >> 5)  & 0x03) | ((packed[i+6] & 0x3F) << 2));
    unpacked.push(((packed[i+6] >> 6)  & 0x01) | ((packed[i+7] & 0x7F) << 1));
  }
  return unpacked;
}

// Extract a 7-bit value from a byte array at an arbitrary bit offset
function extract7bits(bytes, bitOffset) {
  const byteIdx = bitOffset >> 3;
  const bitIdx = bitOffset & 7;
  if (bitIdx <= 1) {
    // Fits in one byte
    return (bytes[byteIdx] >> bitIdx) & 0x7F;
  }
  // Spans two bytes
  const lo = bytes[byteIdx] >> bitIdx;
  const hi = bytes[byteIdx + 1] & ((1 << (bitIdx - 1)) - 1);
  return lo | (hi << (8 - bitIdx));
}

// Extract 10-char name from unpacked QS data at the given bit offset.
// Each character is a 7-bit value (0-95) mapped to ASCII 32-127.
function extractName(unpacked, bitOffset) {
  let name = '';
  for (let i = 0; i < 10; i++) {
    const val = extract7bits(unpacked, bitOffset + i * 7);
    name += String.fromCharCode(val + 32);
  }
  return name;
}

// Request a stored User bank patch name by number.
// Reads directly from storage — does NOT touch the edit buffer.
// Program: opcode 0x01 (User Program Dump Request) → response 0x00, name at bit 8.
// Mix:     opcode 0x0F (New Mix Dump Request)       → response 0x0E, name at bit 5.
// Only User bank (bank 0) is accessible via SysEx.
export function requestPatchName(output, input, mode, bank, patchNum, timeoutMs = 2000) {
  if (bank !== 0) return Promise.resolve('');

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      input.removeEventListener('midimessage', onMessage);
      reject(new Error('Patch name request timed out'));
    }, timeoutMs);

    const expectOpcode = mode === 'prog' ? 0x00 : 0x0E;
    const num = patchNum & 0x7F;

    function onMessage(event) {
      const data = event.data;
      logReceive(data);
      if (data.length < 20 ||
          data[0] !== 0xF0 ||
          data[1] !== 0x00 || data[2] !== 0x00 ||
          data[3] !== 0x0E || data[4] !== 0x0E ||
          data[5] !== expectOpcode ||
          data[6] !== num ||
          data[data.length - 1] !== 0xF7) return;
      clearTimeout(timer);
      input.removeEventListener('midimessage', onMessage);
      const packed = data.slice(7, data.length - 1);
      const unpacked = unpackQSData(packed);
      const bitOffset = mode === 'prog' ? 8 : 5;
      resolve(extractName(unpacked, bitOffset).trim());
    }

    input.addEventListener('midimessage', onMessage);
    if (mode === 'prog') {
      // Opcode 0x01: User Program Dump Request
      const sysex = new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x01, num, 0xF7]);
      logSend(sysex);
      output.send(sysex);
    } else {
      // Opcode 0x0F: New Mix Dump Request (mix# 0-99)
      const sysex = new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x0F, num, 0xF7]);
      logSend(sysex);
      output.send(sysex);
    }
  });
}

export function queryDeviceIdentity(output, input, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      input.removeEventListener('midimessage', onMessage);
      reject(new Error('Device identity query timed out'));
    }, timeoutMs);

    function onMessage(event) {
      const data = event.data;
      logReceive(data);
      if (data[0] === 0xF0 && data.length >= 15 && data[3] === 0x06 && data[4] === 0x02) {
        clearTimeout(timer);
        input.removeEventListener('midimessage', onMessage);
        const result = parseIdentityReply(data);
        if (result) {
          resolve(result);
        } else {
          reject(new Error('Failed to parse identity reply'));
        }
      }
    }

    input.addEventListener('midimessage', onMessage);
    logSend(DEVICE_INQUIRY);
    output.send(DEVICE_INQUIRY);
  });
}
