import { logSend, logReceive } from './midi-log.js';

let midiAccess = null;

/**
 * Request Web MIDI API access with SysEx enabled.
 * Must be called before any other MIDI functions.
 * @returns {Promise<MIDIAccess>} The MIDIAccess object.
 */
export async function requestMIDIAccess() {
  if (!navigator.requestMIDIAccess) {
    throw new Error('Web MIDI API is not supported in this browser');
  }
  midiAccess = await navigator.requestMIDIAccess({ sysex: true });
  return midiAccess;
}

/**
 * Return the cached MIDIAccess object, or null if not yet requested.
 */
export function getMIDIAccess() {
  return midiAccess;
}

/**
 * Enumerate paired MIDI devices (input+output sharing the same name).
 * @returns {Array<{id: string, name: string, input: MIDIInput, output: MIDIOutput}>}
 */
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

/**
 * Parse a Universal Device Identity Reply message.
 *
 * Expected format (per MIDI spec + Alesis extension):
 *   F0 7E <channel> 06 02 00 00 0E  <family LSB> <family MSB>
 *   <member LSB> <member MSB>  <ver0> <ver1> <ver2> <ver3>  F7
 *
 * Family members: 0x03=QS6, 0x04=QS8, 0x05=QS7, 0x06=QSR.
 * Version is 4 ASCII chars, e.g. "0100" → v1.00.
 *
 * @param {Uint8Array} data - Raw MIDI message bytes.
 * @returns {{manufacturer: string, model: string, softwareVersion: string}|null}
 */
function parseIdentityReply(data) {
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

/**
 * Scan a list of MIDI devices for an Alesis QS-series synth by sending
 * a Universal Device Inquiry (F0 7E 7F 06 01 F7) to each device.
 * Returns the first device that replies as an Alesis QS6/7/8/R.
 *
 * @param {Array} devices - Devices from getDevices().
 * @returns {Promise<{device: object, identity: object}|null>}
 */
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

/**
 * Opcode 0x0D — Mode Select.
 * SysEx: F0 00 00 0E 0E 0D <mode> F7
 *
 * Switches the QS between Program and Mix modes. Settings are
 * retained from the last time each mode was exited.
 *
 * @param {MIDIOutput} output
 * @param {number} mode - 0 = Program mode, 1 = Mix mode.
 */
export function sendModeSelect(output, mode) {
  const sysex = new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x0D, mode, 0xF7]);
  logSend(sysex);
  output.send(sysex);
}

/**
 * Send MIDI Bank Select (CC#0 MSB + CC#32 LSB) to choose a patch bank.
 *
 * Banks: 0 = User, 1 = Preset 1, 2 = Preset 2, 3 = Preset 3, 4 = GenMIDI.
 * The QSR requires CC#32 (LSB) = 32 for all banks. Follow with
 * sendProgramChange() to load a specific patch within the bank.
 *
 * @param {MIDIOutput} output
 * @param {number} channel - MIDI channel 0-15.
 * @param {number} bank - Bank number 0-4.
 */
export function sendBankSelect(output, channel, bank) {
  const msb = [0xB0 | (channel & 0x0F), 0x00, bank & 0x7F];
  logSend(msb);
  output.send(msb);
  const lsb = [0xB0 | (channel & 0x0F), 0x20, 0x20];
  logSend(lsb);
  output.send(lsb);
}

/**
 * Send a MIDI Program Change message to select a patch within the
 * currently selected bank.
 *
 * @param {MIDIOutput} output
 * @param {number} channel - MIDI channel 0-15.
 * @param {number} program - Program number 0-127.
 */
export function sendProgramChange(output, channel, program) {
  const msg = [0xC0 | (channel & 0x0F), program & 0x7F];
  logSend(msg);
  output.send(msg);
}

/**
 * Opcode 0x10 — Direct Parameter Edit (Global mode shorthand).
 * SysEx: F0 00 00 0E 0E 10 <0mmfffff> <0ssppppp> <0ccccddv> <0vvvvvvv> F7
 *
 * Convenience wrapper for sendParamEdit() with mm=0 (Global), ss=0, channel=0.
 * Value is the display value in 8-bit 2's complement. Signed parameters
 * (e.g. Master Tune -12..+12) must be sent as display values, not raw
 * storage offsets. Negative values: send (value + 256) & 0xFF.
 *
 * @param {MIDIOutput} output
 * @param {number} func - Function number (0-16).
 * @param {number} page - Page number (0-23).
 * @param {number} pot - Data pot number (0-3).
 * @param {number} value - Parameter display value, 8-bit 2's complement.
 */
export function sendGlobalParam(output, func, page, pot, value) {
  const byte1 = func & 0x1F;                           // mm=00 (Global), fffff
  const byte2 = page & 0x1F;                           // ss=00, ppppp
  const byte3 = ((pot & 0x03) << 1) | ((value >> 7) & 0x01); // cccc=0000, dd, MSB of value
  const byte4 = value & 0x7F;                          // lower 7 bits of value
  const sysex = new Uint8Array([0xF0, 0x00, 0x00, 0x0E, 0x0E, 0x10, byte1, byte2, byte3, byte4, 0xF7]);
  logSend(sysex);
  output.send(sysex);
}

/**
 * Set global "MIDI Program Select" (param #13) — func 0, page 5, pot 0.
 * Controls whether MIDI Program Change messages are processed.
 * Values: 0=Off, 1=On, 2=Ch1, 3=Ch2, ... 17=Ch16.
 *
 * @param {MIDIOutput} output
 * @param {number} value - 0=Off, 1=On, 2-17=Channel 1-16 only.
 */
export function sendMidiProgramSelect(output, value) {
  sendGlobalParam(output, 0, 5, 0, value);
}

// --- SysEx dump send/request helpers ---
//
// All QS SysEx messages share a common header: F0 00 00 0E 0E <opcode> ...
// Alesis manufacturer ID = 00 00 0E, Quadrasynth family ID = 0E.

const QS_HEADER = [0xF0, 0x00, 0x00, 0x0E, 0x0E];

/** Build a complete QS SysEx message: header + payload + F7. */
function qsSysex(...payload) {
  return new Uint8Array([...QS_HEADER, ...payload, 0xF7]);
}

/**
 * Send a QS SysEx request and wait for a response with the expected opcode.
 * Returns the full raw response (Uint8Array) including F0/F7 framing.
 * Rejects on timeout.
 *
 * @param {MIDIOutput} output
 * @param {MIDIInput} input
 * @param {Uint8Array} requestMsg - Complete SysEx message to send.
 * @param {number} expectOpcode - Response opcode byte to match (byte[5]).
 * @param {number} timeoutMs
 * @returns {Promise<Uint8Array>}
 */
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

/**
 * Wait for a FLASH ACK (opcode 0x14) or NACK (opcode 0x15).
 * Resolves on ACK, rejects with a descriptive error on NACK or timeout.
 *
 * NACK error codes:
 *   0 = No card present / not a FLASH card
 *   1 = Card is write protected
 *   2 = Erase failed (FLASH chip timeout)
 *   3 = Checksum mismatch
 *   4 = Programming failed (block not erased first)
 */
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

/**
 * Opcode 0x00 — Send a User Program dump to the QSR.
 * SysEx: F0 00 00 0E 0E 00 <program#> <data...> F7
 *
 * Data is 400 packed MIDI bytes (7-to-8 encoding of 350 unpacked bytes).
 * Total message: 408 bytes. Writes directly to user program storage.
 *
 * @param {MIDIOutput} output
 * @param {number} programNum - User program slot 0-127.
 * @param {Uint8Array} packedData - 400 packed MIDI bytes.
 */
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

/**
 * Opcode 0x01 — Request a User Program dump.
 * SysEx: F0 00 00 0E 0E 01 <program#> F7
 *
 * The QS responds with opcode 0x00 containing the program data.
 *
 * @param {MIDIOutput} output
 * @param {MIDIInput} input
 * @param {number} programNum - User program slot 0-127.
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<Uint8Array>} Full SysEx response including framing.
 */
export function requestUserProgram(output, input, programNum, timeoutMs = 5000) {
  return qsRequest(output, input, qsSysex(0x01, programNum & 0x7F), 0x00, timeoutMs);
}

// --- Opcode 0x02 / 0x03: Edit Program Dump ---

/**
 * Opcode 0x02 — Send a program to the edit buffer.
 * SysEx: F0 00 00 0E 0E 02 <edit#> <data...> F7
 *
 * Data format is the same as opcode 0x00 (400 packed bytes / 350 unpacked).
 * Loading a program into the edit buffer does NOT change the current
 * effect edit buffer, even if the program's effect number differs.
 *
 * @param {MIDIOutput} output
 * @param {number} editNum - 0 = program mode edit, 1-16 = mix channel edits.
 * @param {Uint8Array} packedData - 400 packed MIDI bytes.
 */
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

/**
 * Opcode 0x03 — Request the edit program buffer.
 * SysEx: F0 00 00 0E 0E 03 <edit#> F7
 *
 * The QS responds with opcode 0x02 containing the edit buffer data.
 *
 * @param {MIDIOutput} output
 * @param {MIDIInput} input
 * @param {number} editNum - 0 = program mode edit, 1-16 = mix channel edits.
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<Uint8Array>} Full SysEx response.
 */
export function requestEditProgram(output, input, editNum, timeoutMs = 5000) {
  return qsRequest(output, input, qsSysex(0x03, editNum & 0x7F), 0x02, timeoutMs);
}

// --- Opcode 0x04 / 0x05: Old Mix Dump (legacy, pre-v2.00) ---

/**
 * Opcode 0x04 — Send an old-format mix dump (pre-v2.00 compatibility).
 * SysEx: F0 00 00 0E 0E 04 <mix#> <data...> F7
 *
 * Data is 141 packed bytes (123 unpacked). Total message: 149 bytes.
 * Prefer opcode 0x0E (New Mix Dump) for v2.00+ firmware.
 * Loading a mix does NOT change the 16 program edit buffers or effect buffer.
 *
 * @param {MIDIOutput} output
 * @param {number} mixNum - 0-99 (stored mixes), 100 (edit buffer).
 * @param {Uint8Array} packedData - 141 packed MIDI bytes.
 */
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

/**
 * Opcode 0x05 — Request an old-format mix dump.
 * SysEx: F0 00 00 0E 0E 05 <mix#> F7
 *
 * The QS responds with opcode 0x04. Prefer opcode 0x0F (New Mix Dump
 * Request) for v2.00+ firmware, which includes additional parameters.
 *
 * @param {MIDIOutput} output
 * @param {MIDIInput} input
 * @param {number} mixNum - 0-99 (stored mixes), 100 (edit buffer).
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<Uint8Array>} Full SysEx response.
 */
export function requestOldMix(output, input, mixNum, timeoutMs = 5000) {
  return qsRequest(output, input, qsSysex(0x05, mixNum & 0x7F), 0x04, timeoutMs);
}

// --- Opcode 0x06 / 0x07: User Effects Dump ---

/**
 * Opcode 0x06 — Send a User Effects dump.
 * SysEx: F0 00 00 0E 0E 06 <effect#> <data...> F7
 *
 * Data is 75 packed bytes (65 unpacked). Total message: 83 bytes.
 * Although a Program is stored along with its Effects, they are
 * dealt with independently via MIDI.
 *
 * @param {MIDIOutput} output
 * @param {number} effectNum - User effect slot 0-127.
 * @param {Uint8Array} packedData - 75 packed MIDI bytes.
 */
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

/**
 * Opcode 0x07 — Request a User Effects dump.
 * SysEx: F0 00 00 0E 0E 07 <effect#> F7
 *
 * The QS responds with opcode 0x06 containing the effect data.
 *
 * @param {MIDIOutput} output
 * @param {MIDIInput} input
 * @param {number} effectNum - User effect slot 0-127.
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<Uint8Array>} Full SysEx response.
 */
export function requestUserEffects(output, input, effectNum, timeoutMs = 5000) {
  return qsRequest(output, input, qsSysex(0x07, effectNum & 0x7F), 0x06, timeoutMs);
}

// --- Opcode 0x08 / 0x09: Edit Effects Dump ---

/**
 * Opcode 0x08 — Send an effects patch to the edit buffer.
 * SysEx: F0 00 00 0E 0E 08 <edit#> <data...> F7
 *
 * Data format is the same as opcode 0x06 (75 packed bytes / 65 unpacked).
 *
 * @param {MIDIOutput} output
 * @param {number} editNum - 0 = program mode effects, 1 = mix mode effects.
 * @param {Uint8Array} packedData - 75 packed MIDI bytes.
 */
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

/**
 * Opcode 0x09 — Request the edit effects buffer.
 * SysEx: F0 00 00 0E 0E 09 <edit#> F7
 *
 * The QS responds with opcode 0x08 containing the edit effect data.
 *
 * @param {MIDIOutput} output
 * @param {MIDIInput} input
 * @param {number} editNum - 0 = program mode effects, 1 = mix mode effects.
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<Uint8Array>} Full SysEx response.
 */
export function requestEditEffects(output, input, editNum, timeoutMs = 5000) {
  return qsRequest(output, input, qsSysex(0x09, editNum & 0x7F), 0x08, timeoutMs);
}

// --- Opcode 0x0A / 0x0B: Global Data Dump ---

/**
 * Opcode 0x0A — Send global data to the QSR.
 * SysEx: F0 00 00 0E 0E 0A 00 <data...> F7
 *
 * Data is 23 packed bytes (20 unpacked). Total message: 31 bytes.
 * Note: with firmware prior to v2.00, the last 3 bytes are not
 * transmitted as they did not exist in earlier versions.
 *
 * @param {MIDIOutput} output
 * @param {Uint8Array} packedData - 23 packed MIDI bytes.
 */
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

/**
 * Opcode 0x0B — Request a global data dump.
 * SysEx: F0 00 00 0E 0E 0B F7
 *
 * The QS responds with opcode 0x0A containing the global data.
 *
 * @param {MIDIOutput} output
 * @param {MIDIInput} input
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<Uint8Array>} Full SysEx response.
 */
export function requestGlobalData(output, input, timeoutMs = 5000) {
  return qsRequest(output, input, qsSysex(0x0B), 0x0A, timeoutMs);
}

// --- Opcode 0x0C: All Dump Request ---

/**
 * Opcode 0x0C — Request a full dump of all user data.
 * SysEx: F0 00 00 0E 0E 0C F7
 *
 * The QS responds with 128 User Program dumps (0x00), 100 New Mix
 * dumps (0x0E), 128 User Effects dumps (0x06), and 1 Global dump (0x0A).
 * Total: 79,478 MIDI bytes with 4.25ms delay between each dump (~27s).
 * This function only sends the request — caller must listen for responses.
 *
 * @param {MIDIOutput} output
 */
export function requestAllDump(output) {
  const msg = qsSysex(0x0C);
  logSend(msg);
  output.send(msg);
}

// --- Opcode 0x0E / 0x0F: New Mix Dump (v2.00+) ---

/**
 * Opcode 0x0E — Send a new-format mix dump (v2.00+ firmware only).
 * SysEx: F0 00 00 0E 0E 0E <mix#> <data...> F7
 *
 * Data is 158 packed bytes (138 unpacked). Total message: 166 bytes.
 * Loading a mix does NOT change the 16 program edit buffers or the
 * effect buffer, even if the mix references different programs.
 *
 * @param {MIDIOutput} output
 * @param {number} mixNum - 0-99 (stored mixes), 100 (edit buffer).
 * @param {Uint8Array} packedData - 158 packed MIDI bytes.
 */
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

/**
 * Opcode 0x0F — Request a new-format mix dump (v2.00+ firmware).
 * SysEx: F0 00 00 0E 0E 0F <mix#> F7
 *
 * The QS responds with opcode 0x0E containing the mix data.
 *
 * @param {MIDIOutput} output
 * @param {MIDIInput} input
 * @param {number} mixNum - 0-99 (stored mixes), 100 (edit buffer).
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<Uint8Array>} Full SysEx response.
 */
export function requestNewMix(output, input, mixNum, timeoutMs = 5000) {
  return qsRequest(output, input, qsSysex(0x0F, mixNum & 0x7F), 0x0E, timeoutMs);
}

// --- Opcode 0x10: Direct Parameter Edit (extended) ---

/**
 * Opcode 0x10 — Direct Parameter Edit.
 * SysEx: F0 00 00 0E 0E 10 <0mmfffff> <0ssppppp> <0ccccddv> <0vvvvvvv> F7
 *
 * Edits a single parameter and displays it on the QS front panel.
 * Total message: 11 bytes (always fixed size regardless of parameter).
 *
 * IMPORTANT — Value encoding:
 *   The value is the DISPLAY value, not the raw storage offset.
 *   For signed parameters (e.g. Detune -99..+100), send the display value
 *   in 8-bit 2's complement: negative values as (value + 256) & 0xFF.
 *   Example: Detune = -10 → send 246 (0xF6), Detune = 0 → send 0.
 *   Do NOT add storage offsets — the QS interprets values as display values.
 *
 * Behavior notes (from spec):
 *   - If func/page doesn't exist, the nearest legal page is selected
 *     but no edit occurs.
 *   - Mix edits are ignored while in Program mode (and vice versa).
 *   - Ignored while in Compare mode.
 *   - Receiving a Program edit puts the QS into Edit mode.
 *   - Out-of-range values are clamped to the nearest legal value.
 *
 * @param {MIDIOutput} output
 * @param {number} mm - Mode: 0=Global, 1=Mix, 2=Program, 3=Effects.
 * @param {number} func - Function number (0-16, mode-dependent).
 * @param {number} ss - Sound 0-3 (Program mode) or effect bus 0-3 (Effects mode).
 * @param {number} page - Page number (0-23, mode/func-dependent).
 * @param {number} channel - MIDI channel 0-15 (only used when mm=1 or mm=2 in Mix mode).
 * @param {number} pot - Data pot number (0-3).
 * @param {number} value - Display value, 8-bit 2's complement (0-255).
 */
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

/**
 * Opcode 0x11 — Erase a FLASH card sector.
 * SysEx: F0 00 00 0E 0E 11 <sector#> F7
 *
 * Sets all bytes in a 128KB sector to 0xFF. The QS responds with
 * ACK (0x14) on success or NACK (0x15) on failure. Up to 10 seconds
 * may be needed for the erase to complete.
 *
 * @param {MIDIOutput} output
 * @param {MIDIInput} input
 * @param {number} sectorNum - Sector 0-63 (128KB each, up to 8MB total).
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<void>} Resolves on ACK, rejects on NACK or timeout.
 */
export function flashSectorErase(output, input, sectorNum, timeoutMs = 10000) {
  const ack = awaitFlashAck(input, timeoutMs);
  const msg = qsSysex(0x11, sectorNum & 0x3F);
  logSend(msg);
  output.send(msg);
  return ack;
}

// --- Opcode 0x12: FLASH Sector Write ---

/**
 * Opcode 0x12 — Write a 1024-byte block to FLASH card.
 * SysEx: F0 00 00 0E 0E 12 <sector#> <block#> <data...> <checksum> F7
 *
 * Data is 1171 packed MIDI bytes (1024 unpacked). Total message: 1181 bytes
 * (~378ms minimum transmit time). A 7-bit checksum of (sector# + block# +
 * all data bytes) is appended. Writes should only target blocks known to
 * contain all 0xFF (verify by reading first or erasing the sector).
 *
 * The QS responds with ACK (0x14) or NACK (0x15). On checksum mismatch
 * the sender should retry at least once before aborting.
 *
 * @param {MIDIOutput} output
 * @param {MIDIInput} input
 * @param {number} sectorNum - Sector 0-63.
 * @param {number} blockNum - Block 0-127 within the sector.
 * @param {Uint8Array} packedData - 1171 packed MIDI bytes.
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<void>} Resolves on ACK, rejects on NACK or timeout.
 */
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

/**
 * Opcode 0x13 — Request a FLASH card sector block.
 * SysEx: F0 00 00 0E 0E 13 <sector#> <block#> F7
 *
 * The QS responds with opcode 0x12 (sector write format) containing the
 * block data, or NACK (0x15) if no card is present.
 *
 * @param {MIDIOutput} output
 * @param {MIDIInput} input
 * @param {number} sectorNum - Sector 0-63.
 * @param {number} blockNum - Block 0-127 within the sector.
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<Uint8Array>} Full SysEx response (opcode 0x12 format).
 */
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
//
// The QS uses a 7-to-8 bit encoding for SysEx data transfer. Every 7 QS
// data bytes (56 bits) are transmitted as 8 MIDI-safe 7-bit bytes.
// The bit layout is documented under opcode 0x00 in the spec.

/**
 * Pack QS data bytes for SysEx transmission.
 * Encodes every 7 data bytes into 8 MIDI-safe 7-bit bytes.
 * This is the inverse of unpackQSData().
 *
 * @param {number[]|Uint8Array} unpacked - Raw QS data bytes (8-bit).
 * @returns {number[]} Packed 7-bit MIDI bytes.
 */
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

/**
 * Unpack QS 7-bit MIDI encoding back to 8-bit data bytes.
 * Every 8 packed MIDI bytes yield 7 QS data bytes.
 * Handles partial trailing groups (e.g. global data: 23 packed → 20 unpacked).
 *
 * See opcode 0x00 in the spec for the bit layout diagram.
 *
 * @param {Uint8Array|number[]} packed - 7-bit MIDI bytes from SysEx dump.
 * @returns {number[]} Unpacked 8-bit QS data bytes.
 */
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

/**
 * Extract a 7-bit value from a byte array at an arbitrary bit offset.
 * Used internally for reading name characters from unpacked dump data.
 */
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

/**
 * Extract a 10-character name from unpacked QS data at the given bit offset.
 * Each character is a 7-bit value (0-95) mapped to ASCII 32-127.
 *
 * @param {number[]} unpacked - Unpacked QS data bytes.
 * @param {number} bitOffset - Starting bit position of the name field.
 * @returns {string} Trimmed 10-character name.
 */
function extractName(unpacked, bitOffset) {
  let name = '';
  for (let i = 0; i < 10; i++) {
    const val = extract7bits(unpacked, bitOffset + i * 7);
    name += String.fromCharCode(val + 32);
  }
  return name;
}

/**
 * Request a stored User bank patch name by number.
 *
 * Reads directly from storage via a full dump — does NOT touch the
 * edit buffer. Only User bank (bank 0) is accessible via SysEx;
 * returns empty string for other banks.
 *
 * Internally requests the full dump and extracts just the name:
 *   Program: opcode 0x01 → response 0x00, name at bit offset 8.
 *   Mix:     opcode 0x0F → response 0x0E, name at bit offset 5.
 *
 * @param {MIDIOutput} output
 * @param {MIDIInput} input
 * @param {string} mode - 'prog' or 'mix'.
 * @param {number} bank - Bank number (only 0 = User is supported).
 * @param {number} patchNum - Patch number (0-127 for programs, 0-99 for mixes).
 * @param {number} [timeoutMs=2000]
 * @returns {Promise<string>} Trimmed patch name, or empty string if not User bank.
 */
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

/**
 * Send a Universal Device Inquiry (F0 7E 7F 06 01 F7) and wait for an
 * Identity Reply. Parses the Alesis-specific fields to identify the
 * QS model and firmware version.
 *
 * @param {MIDIOutput} output
 * @param {MIDIInput} input
 * @param {number} [timeoutMs=1000]
 * @returns {Promise<{manufacturer: string, model: string, softwareVersion: string}>}
 */
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
