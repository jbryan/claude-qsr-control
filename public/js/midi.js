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
  // CC#0 (Bank Select MSB) — selects User(0), Preset 1–3(1–3), GenMIDI(4)
  const msb = [0xB0 | (channel & 0x0F), 0x00, bank & 0x7F];
  logSend(msb);
  output.send(msb);
  // CC#32 (Bank Select LSB) — QSR requires LSB=32 for all banks
  const lsb = [0xB0 | (channel & 0x0F), 0x20, 0x20];
  logSend(lsb);
  output.send(lsb);
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

// --- SysEx dump send/request helpers ---

const QS_HEADER = [0xF0, 0x00, 0x00, 0x0E, 0x0E];

function qsSysex(...payload) {
  return new Uint8Array([...QS_HEADER, ...payload, 0xF7]);
}

// Generic: send a QS SysEx request, wait for a response matching the expected opcode.
// Returns the full raw response (Uint8Array) including SysEx framing.
function qsRequest(output, input, requestMsg, expectOpcode, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      input.removeEventListener('midimessage', onMessage);
      reject(new Error('SysEx request timed out'));
    }, timeoutMs);

    function onMessage(event) {
      const data = event.data;
      logReceive(data);
      if (data[0] !== 0xF0 || data[1] !== 0x00 || data[2] !== 0x00 ||
          data[3] !== 0x0E || data[4] !== 0x0E || data[5] !== expectOpcode) return;
      clearTimeout(timer);
      input.removeEventListener('midimessage', onMessage);
      resolve(data);
    }

    input.addEventListener('midimessage', onMessage);
    logSend(requestMsg);
    output.send(requestMsg);
  });
}

// Wait for a FLASH ACK (opcode 0x14) or NACK (opcode 0x15).
// Resolves on ACK, rejects with error details on NACK or timeout.
const FLASH_NACK_ERRORS = [
  'No card present / not a FLASH card',
  'Card is write protected',
  'Erase failed (chip timeout)',
  'Checksum mismatch',
  'Programming failed (block not erased)',
];

function awaitFlashAck(input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      input.removeEventListener('midimessage', onMessage);
      reject(new Error('FLASH operation timed out'));
    }, timeoutMs);

    function onMessage(event) {
      const data = event.data;
      logReceive(data);
      if (data[0] !== 0xF0 || data[1] !== 0x00 || data[2] !== 0x00 ||
          data[3] !== 0x0E || data[4] !== 0x0E) return;
      if (data[5] === 0x14) {
        clearTimeout(timer);
        input.removeEventListener('midimessage', onMessage);
        resolve();
      } else if (data[5] === 0x15) {
        clearTimeout(timer);
        input.removeEventListener('midimessage', onMessage);
        reject(new Error(FLASH_NACK_ERRORS[data[6]] || `FLASH NACK error ${data[6]}`));
      }
    }

    input.addEventListener('midimessage', onMessage);
  });
}

// --- Opcode 0x00 / 0x01: User Program Dump ---

// Send a User Program dump to the QSR (opcode 0x00).
// programNum: 0-127. packedData: Uint8Array of 400 packed MIDI bytes.
export function sendUserProgram(output, programNum, packedData) {
  const msg = new Uint8Array(7 + packedData.length + 1);
  msg.set(QS_HEADER);
  msg[5] = 0x00;
  msg[6] = programNum & 0x7F;
  msg.set(packedData, 7);
  msg[msg.length - 1] = 0xF7;
  logSend(msg);
  output.send(msg);
}

// Request a User Program dump (opcode 0x01). Returns full SysEx response.
export function requestUserProgram(output, input, programNum, timeoutMs = 5000) {
  return qsRequest(output, input, qsSysex(0x01, programNum & 0x7F), 0x00, timeoutMs);
}

// --- Opcode 0x02 / 0x03: Edit Program Dump ---

// Send a program to the edit buffer (opcode 0x02).
// editNum: 0 = program mode edit, 1-16 = mix channel edits.
export function sendEditProgram(output, editNum, packedData) {
  const msg = new Uint8Array(7 + packedData.length + 1);
  msg.set(QS_HEADER);
  msg[5] = 0x02;
  msg[6] = editNum & 0x7F;
  msg.set(packedData, 7);
  msg[msg.length - 1] = 0xF7;
  logSend(msg);
  output.send(msg);
}

// Request the edit program buffer (opcode 0x03). Returns full SysEx response.
export function requestEditProgram(output, input, editNum, timeoutMs = 5000) {
  return qsRequest(output, input, qsSysex(0x03, editNum & 0x7F), 0x02, timeoutMs);
}

// --- Opcode 0x04 / 0x05: Old Mix Dump (legacy, pre-v2.00) ---

// Send an old-format mix dump (opcode 0x04).
// mixNum: 0-99 (stored mixes), 100 (edit buffer).
export function sendOldMix(output, mixNum, packedData) {
  const msg = new Uint8Array(7 + packedData.length + 1);
  msg.set(QS_HEADER);
  msg[5] = 0x04;
  msg[6] = mixNum & 0x7F;
  msg.set(packedData, 7);
  msg[msg.length - 1] = 0xF7;
  logSend(msg);
  output.send(msg);
}

// Request an old-format mix dump (opcode 0x05). Returns full SysEx response.
export function requestOldMix(output, input, mixNum, timeoutMs = 5000) {
  return qsRequest(output, input, qsSysex(0x05, mixNum & 0x7F), 0x04, timeoutMs);
}

// --- Opcode 0x06 / 0x07: User Effects Dump ---

// Send a User Effects dump (opcode 0x06).
// effectNum: 0-127. packedData: 75 packed MIDI bytes.
export function sendUserEffects(output, effectNum, packedData) {
  const msg = new Uint8Array(7 + packedData.length + 1);
  msg.set(QS_HEADER);
  msg[5] = 0x06;
  msg[6] = effectNum & 0x7F;
  msg.set(packedData, 7);
  msg[msg.length - 1] = 0xF7;
  logSend(msg);
  output.send(msg);
}

// Request a User Effects dump (opcode 0x07). Returns full SysEx response.
export function requestUserEffects(output, input, effectNum, timeoutMs = 5000) {
  return qsRequest(output, input, qsSysex(0x07, effectNum & 0x7F), 0x06, timeoutMs);
}

// --- Opcode 0x08 / 0x09: Edit Effects Dump ---

// Send an effects patch to the edit buffer (opcode 0x08).
// editNum: 0 = program mode effects, 1 = mix mode effects.
export function sendEditEffects(output, editNum, packedData) {
  const msg = new Uint8Array(7 + packedData.length + 1);
  msg.set(QS_HEADER);
  msg[5] = 0x08;
  msg[6] = editNum & 0x7F;
  msg.set(packedData, 7);
  msg[msg.length - 1] = 0xF7;
  logSend(msg);
  output.send(msg);
}

// Request the edit effects buffer (opcode 0x09). Returns full SysEx response.
export function requestEditEffects(output, input, editNum, timeoutMs = 5000) {
  return qsRequest(output, input, qsSysex(0x09, editNum & 0x7F), 0x08, timeoutMs);
}

// --- Opcode 0x0A / 0x0B: Global Data Dump ---

// Send global data to the QSR (opcode 0x0A).
// packedData: 23 packed MIDI bytes.
export function sendGlobalData(output, packedData) {
  const msg = new Uint8Array(7 + packedData.length + 1);
  msg.set(QS_HEADER);
  msg[5] = 0x0A;
  msg[6] = 0x00; // reserved
  msg.set(packedData, 7);
  msg[msg.length - 1] = 0xF7;
  logSend(msg);
  output.send(msg);
}

// Request global data dump (opcode 0x0B). Returns full SysEx response.
export function requestGlobalData(output, input, timeoutMs = 5000) {
  return qsRequest(output, input, qsSysex(0x0B), 0x0A, timeoutMs);
}

// --- Opcode 0x0C: All Dump Request ---

// Request a full dump of all user data (opcode 0x0C).
// The QSR will respond with 128 programs, 100 mixes, 128 effects, and 1 global dump.
// This just sends the request — caller must listen for the individual dump responses.
export function requestAllDump(output) {
  const msg = qsSysex(0x0C);
  logSend(msg);
  output.send(msg);
}

// --- Opcode 0x0E / 0x0F: New Mix Dump (v2.00+) ---

// Send a new-format mix dump (opcode 0x0E).
// mixNum: 0-99 (stored mixes), 100 (edit buffer). packedData: 158 packed MIDI bytes.
export function sendNewMix(output, mixNum, packedData) {
  const msg = new Uint8Array(7 + packedData.length + 1);
  msg.set(QS_HEADER);
  msg[5] = 0x0E;
  msg[6] = mixNum & 0x7F;
  msg.set(packedData, 7);
  msg[msg.length - 1] = 0xF7;
  logSend(msg);
  output.send(msg);
}

// Request a new-format mix dump (opcode 0x0F). Returns full SysEx response.
export function requestNewMix(output, input, mixNum, timeoutMs = 5000) {
  return qsRequest(output, input, qsSysex(0x0F, mixNum & 0x7F), 0x0E, timeoutMs);
}

// --- Opcode 0x10: Direct Parameter Edit (extended) ---

// Full parameter edit with mode/sound/channel control.
// mm: 0=Global, 1=Mix, 2=Program, 3=Effects
// ss: sound 1-4 (0-3) for Program mode, effect bus 1-4 for Effects mode
// channel: 0-15 (only relevant in Mix mode)
export function sendParamEdit(output, mm, func, ss, page, channel, pot, value) {
  const byte1 = ((mm & 0x03) << 5) | (func & 0x1F);
  const byte2 = ((ss & 0x03) << 5) | (page & 0x1F);
  const byte3 = ((channel & 0x0F) << 3) | ((pot & 0x03) << 1) | ((value >> 7) & 0x01);
  const byte4 = value & 0x7F;
  const sysex = new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x10, byte1, byte2, byte3, byte4, 0xF7]);
  logSend(sysex);
  output.send(sysex);
}

// --- Opcode 0x11: FLASH Sector Erase ---

// Erase a FLASH card sector. Resolves on ACK, rejects on NACK or timeout.
// sectorNum: 0-63. Allow up to 10 seconds for erase to complete.
export function flashSectorErase(output, input, sectorNum, timeoutMs = 10000) {
  const ack = awaitFlashAck(input, timeoutMs);
  const msg = qsSysex(0x11, sectorNum & 0x3F);
  logSend(msg);
  output.send(msg);
  return ack;
}

// --- Opcode 0x12: FLASH Sector Write ---

// Write a 1024-byte block to FLASH card. packedData: 1171 packed MIDI bytes.
// A 7-bit checksum of (sectorNum + blockNum + all data bytes) must be appended.
// Resolves on ACK, rejects on NACK or timeout.
export function flashSectorWrite(output, input, sectorNum, blockNum, packedData, timeoutMs = 5000) {
  const ack = awaitFlashAck(input, timeoutMs);
  // Compute 7-bit checksum
  let sum = sectorNum + blockNum;
  for (let i = 0; i < packedData.length; i++) sum += packedData[i];
  sum &= 0x7F;
  const msg = new Uint8Array(8 + packedData.length + 2); // QS_HEADER(5) + opcode + sector + block + data + checksum + F7
  msg.set(QS_HEADER);
  msg[5] = 0x12;
  msg[6] = sectorNum & 0x3F;
  msg[7] = blockNum & 0x7F;
  msg.set(packedData, 8);
  msg[8 + packedData.length] = sum;
  msg[msg.length - 1] = 0xF7;
  logSend(msg);
  output.send(msg);
  return ack;
}

// --- Opcode 0x13: FLASH Sector Read Request ---

// Request a FLASH card sector block. Returns full SysEx response (opcode 0x12 format).
// Rejects with NACK error if no card is present.
export function requestFlashSectorRead(output, input, sectorNum, blockNum, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      input.removeEventListener('midimessage', onMessage);
      reject(new Error('FLASH read request timed out'));
    }, timeoutMs);

    function onMessage(event) {
      const data = event.data;
      logReceive(data);
      if (data[0] !== 0xF0 || data[1] !== 0x00 || data[2] !== 0x00 ||
          data[3] !== 0x0E || data[4] !== 0x0E) return;
      if (data[5] === 0x12) {
        clearTimeout(timer);
        input.removeEventListener('midimessage', onMessage);
        resolve(data);
      } else if (data[5] === 0x15) {
        clearTimeout(timer);
        input.removeEventListener('midimessage', onMessage);
        reject(new Error(FLASH_NACK_ERRORS[data[6]] || `FLASH NACK error ${data[6]}`));
      }
    }

    input.addEventListener('midimessage', onMessage);
    const msg = qsSysex(0x13, sectorNum & 0x3F, blockNum & 0x7F);
    logSend(msg);
    output.send(msg);
  });
}

// --- Data packing/unpacking ---

// Pack QS data bytes: every 7 data bytes → 8 MIDI bytes (inverse of unpackQSData).
export function packQSData(unpacked) {
  const packed = [];
  for (let i = 0; i + 6 < unpacked.length; i += 7) {
    packed.push(unpacked[i] & 0x7F);
    packed.push(((unpacked[i] >> 7) & 0x01) | ((unpacked[i+1] & 0x3F) << 1));
    packed.push(((unpacked[i+1] >> 6) & 0x03) | ((unpacked[i+2] & 0x1F) << 2));
    packed.push(((unpacked[i+2] >> 5) & 0x07) | ((unpacked[i+3] & 0x0F) << 3));
    packed.push(((unpacked[i+3] >> 4) & 0x0F) | ((unpacked[i+4] & 0x07) << 4));
    packed.push(((unpacked[i+4] >> 3) & 0x1F) | ((unpacked[i+5] & 0x03) << 5));
    packed.push(((unpacked[i+5] >> 2) & 0x3F) | ((unpacked[i+6] & 0x01) << 6));
    packed.push((unpacked[i+6] >> 1) & 0x7F);
  }
  return packed;
}

// Unpack QS 7-bit MIDI encoding: every 8 MIDI bytes → 7 QS data bytes
// See qs678syx.htm opcode 00 for the bit layout.
// Handles partial trailing groups (e.g. global data: 23 packed → 20 unpacked).
export function unpackQSData(packed) {
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
  // Partial trailing group: N remaining packed bytes yield N-1 unpacked bytes.
  const tail = packed.length % 8;
  if (tail >= 2) {
    const i = packed.length - tail;
    if (tail >= 2) unpacked.push( (packed[i]          & 0x7F) | ((packed[i+1] & 0x01) << 7));
    if (tail >= 3) unpacked.push(((packed[i+1] >> 1)  & 0x3F) | ((packed[i+2] & 0x03) << 6));
    if (tail >= 4) unpacked.push(((packed[i+2] >> 2)  & 0x1F) | ((packed[i+3] & 0x07) << 5));
    if (tail >= 5) unpacked.push(((packed[i+3] >> 3)  & 0x0F) | ((packed[i+4] & 0x0F) << 4));
    if (tail >= 6) unpacked.push(((packed[i+4] >> 4)  & 0x07) | ((packed[i+5] & 0x1F) << 3));
    if (tail >= 7) unpacked.push(((packed[i+5] >> 5)  & 0x03) | ((packed[i+6] & 0x3F) << 2));
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
