import { unpackQSData, packQSData, requestUserProgram, requestEditProgram, requestNewMix, sendUserProgram, sendNewMix } from './midi.js';

// --- Bit helpers ---

export function extractBits(bytes, bitOffset, numBits) {
  let val = 0;
  for (let i = 0; i < numBits; i++) {
    const byteIdx = (bitOffset + i) >> 3;
    const bitIdx = (bitOffset + i) & 7;
    if (bytes[byteIdx] & (1 << bitIdx)) val |= (1 << i);
  }
  return val;
}

export function setBits(bytes, bitOffset, numBits, value) {
  for (let i = 0; i < numBits; i++) {
    const byteIdx = (bitOffset + i) >> 3;
    const bitIdx = (bitOffset + i) & 7;
    if ((value >> i) & 1) {
      bytes[byteIdx] |= (1 << bitIdx);
    } else {
      bytes[byteIdx] &= ~(1 << bitIdx);
    }
  }
}

// --- Name helpers ---

export function extractProgName(unpacked) {
  let name = '';
  for (let i = 0; i < 10; i++) {
    name += String.fromCharCode(extractBits(unpacked, 8 + i * 7, 7) + 32);
  }
  return name.trim();
}

export function extractMixName(unpacked) {
  let name = '';
  for (let i = 0; i < 10; i++) {
    name += String.fromCharCode(extractBits(unpacked, 5 + i * 7, 7) + 32);
  }
  return name.trim();
}

export function encodeProgName(unpacked, name) {
  const padded = name.padEnd(10).slice(0, 10);
  for (let i = 0; i < 10; i++) {
    const val = padded.charCodeAt(i) - 32;
    setBits(unpacked, 8 + i * 7, 7, val);
  }
}

export function encodeMixName(unpacked, name) {
  const padded = name.padEnd(10).slice(0, 10);
  for (let i = 0; i < 10; i++) {
    const val = padded.charCodeAt(i) - 32;
    setBits(unpacked, 5 + i * 7, 7, val);
  }
}

// --- Program class ---

// Keyboard sound field definitions: [fieldPath, bitAddr, numBits]
// bitAddr is relative to the start of the sound section.
const KB_FIELDS = [
  ['sample.group', 1, 6],
  ['sample.number', 7, 7],
  ['level.volume', 14, 7],
  ['level.pan', 21, 3],
  ['level.output', 24, 2],
  ['level.effectLevel', 26, 7],
  ['level.effectBus', 33, 2],
  ['pitch.semitone', 35, 6],
  ['pitch.detune', 41, 8],
  ['pitch.detuneType', 49, 1],
  ['pitch.pitchWheelMod', 50, 4],
  ['pitch.aftertouchMod', 54, 8],
  ['pitch.lfoMod', 62, 8],
  ['pitch.envMod', 70, 8],
  ['pitch.portamentoMode', 78, 2],
  ['pitch.portamentoRate', 80, 7],
  ['pitch.keyMode', 87, 2],
  ['filter.frequency', 89, 7],
  ['filter.keyboardTrack', 96, 1],
  ['filter.velocityMod', 97, 8],
  ['filter.pitchWheelMod', 105, 8],
  ['filter.aftertouchMod', 113, 8],
  ['filter.lfoMod', 121, 8],
  ['filter.envMod', 129, 8],
  ['amp.velocityCurve', 137, 4],
  ['amp.aftertouchMod', 141, 8],
  ['amp.lfoMod', 149, 8],
  ['noteRange.lowNote', 157, 7],
  ['noteRange.highNote', 164, 7],
  ['noteRange.overlap', 171, 7],
];

// Mod routings: 6 entries, each has 4 fields at base 178 + m*19
function buildModFields() {
  const fields = [];
  for (let m = 0; m < 6; m++) {
    const base = 178 + m * 19;
    fields.push([`mods.${m}.source`, base, 5]);
    fields.push([`mods.${m}.destination`, base + 5, 5]);
    fields.push([`mods.${m}.amplitude`, base + 10, 8]);
    fields.push([`mods.${m}.gate`, base + 18, 1]);
  }
  return fields;
}

const MOD_FIELDS = buildModFields();

// LFO fields template (waveform, speed, delay, trigger, level, modWheelMod, aftertouchMod)
function buildLfoFields(prefix, baseAddr) {
  return [
    [`${prefix}.waveform`, baseAddr, 3],
    [`${prefix}.speed`, baseAddr + 3, 7],
    [`${prefix}.delay`, baseAddr + 10, 7],
    [`${prefix}.trigger`, baseAddr + 17, 2],
    [`${prefix}.level`, baseAddr + 19, 7],
    [`${prefix}.modWheelMod`, baseAddr + 26, 8],
    [`${prefix}.aftertouchMod`, baseAddr + 34, 8],
  ];
}

// Envelope fields template
function buildEnvFields(prefix, baseAddr, hasVelocityMod) {
  const fields = [
    [`${prefix}.attack`, baseAddr, 7],
    [`${prefix}.decay`, baseAddr + 7, 7],
    [`${prefix}.sustain`, baseAddr + 14, 7],
    [`${prefix}.release`, baseAddr + 21, 7],
    [`${prefix}.delay`, baseAddr + 28, 7],
    [`${prefix}.sustainDecay`, baseAddr + 35, 7],
    [`${prefix}.triggerType`, baseAddr + 42, 2],
    [`${prefix}.timeTrack`, baseAddr + 44, 1],
    [`${prefix}.sustainPedal`, baseAddr + 45, 1],
    [`${prefix}.level`, baseAddr + 46, 7],
  ];
  if (hasVelocityMod) {
    fields.push([`${prefix}.velocityMod`, baseAddr + 53, 8]);
  }
  return fields;
}

// Tracking fields
function buildTrackingFields() {
  const fields = [['tracking.input', 593, 5]];
  for (let i = 0; i < 11; i++) {
    fields.push([`tracking.points.${i}`, 598 + i * 7, 7]);
  }
  return fields;
}

const ALL_KB_FIELDS = [
  ...KB_FIELDS,
  ...MOD_FIELDS,
  ...buildLfoFields('pitchLfo', 292),
  ...buildLfoFields('filterLfo', 334),
  ...buildLfoFields('ampLfo', 376),
  ...buildEnvFields('pitchEnv', 418, true),
  ...buildEnvFields('filterEnv', 479, true),
  ...buildEnvFields('ampEnv', 540, false),
  ...buildTrackingFields(),
];

// Drum sound fields: 10 entries, each 72 bits, starting at baseBitOff + 8
const DRUM_ENTRY_FIELDS = [
  ['sampleGroup', 0, 4],
  ['sampleNumber', 4, 7],
  ['volume', 11, 5],
  ['pan', 16, 3],
  ['output', 19, 2],
  ['effectLevel', 21, 6],
  ['effectBus', 27, 2],
  ['pitch', 29, 7],
  ['pitchVelMod', 36, 3],
  ['filterVelMod', 39, 2],
  ['velocityCurve', 41, 4],
  ['noteNumber', 45, 7],
  ['ampEnvDecay', 52, 7],
  ['muteGroup', 59, 2],
  ['noteRange', 61, 2],
];

function setNestedField(obj, path, value) {
  const parts = path.split('.');
  let target = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    // Numeric keys index into arrays
    const idx = Number(key);
    if (!isNaN(idx)) {
      target = target[idx];
    } else {
      if (!(key in target)) target[key] = {};
      target = target[key];
    }
  }
  const lastKey = parts[parts.length - 1];
  const lastIdx = Number(lastKey);
  if (!isNaN(lastIdx)) {
    target[lastIdx] = value;
  } else {
    target[lastKey] = value;
  }
}

export function getNestedField(obj, path) {
  const parts = path.split('.');
  let target = obj;
  for (const key of parts) {
    const idx = Number(key);
    if (!isNaN(idx)) {
      target = target[idx];
    } else {
      target = target[key];
    }
  }
  return target;
}

function parseKeyboardSound(unpacked, baseBitOff) {
  const sound = {
    sample: {},
    level: {},
    pitch: {},
    filter: {},
    amp: {},
    noteRange: {},
    mods: Array.from({ length: 6 }, () => ({})),
    pitchLfo: {},
    filterLfo: {},
    ampLfo: {},
    pitchEnv: {},
    filterEnv: {},
    ampEnv: {},
    tracking: { points: new Array(11).fill(0) },
  };
  for (const [path, bitAddr, numBits] of ALL_KB_FIELDS) {
    const val = extractBits(unpacked, baseBitOff + bitAddr, numBits);
    setNestedField(sound, path, val);
  }
  return sound;
}

function serializeKeyboardSound(sound, unpacked, baseBitOff) {
  for (const [path, bitAddr, numBits] of ALL_KB_FIELDS) {
    const val = getNestedField(sound, path);
    setBits(unpacked, baseBitOff + bitAddr, numBits, val);
  }
}

function parseDrumSound(unpacked, baseBitOff) {
  const drums = [];
  const drumBaseBit = baseBitOff + 8;
  for (let d = 0; d < 10; d++) {
    const dBit = drumBaseBit + d * 72;
    const drum = {};
    for (const [name, addr, bits] of DRUM_ENTRY_FIELDS) {
      drum[name] = extractBits(unpacked, dBit + addr, bits);
    }
    drums.push(drum);
  }
  return drums;
}

function serializeDrumSound(drums, unpacked, baseBitOff) {
  const drumBaseBit = baseBitOff + 8;
  for (let d = 0; d < 10; d++) {
    const dBit = drumBaseBit + d * 72;
    for (const [name, addr, bits] of DRUM_ENTRY_FIELDS) {
      setBits(unpacked, dBit + addr, bits, drums[d][name]);
    }
  }
}

// Sound byte offsets from start of unpacked program data
const SOUND_BYTE_OFFSETS = [10, 95, 180, 265];

export class Program {
  constructor() {
    this.name = '';
    this.romId = 0;
    this.sounds = [];
  }

  static fromUnpacked(unpacked) {
    const prog = new Program();
    prog.name = extractProgName(unpacked);
    prog.romId = extractBits(unpacked, 78, 2);

    for (let s = 0; s < 4; s++) {
      const baseBitOff = SOUND_BYTE_OFFSETS[s] * 8;
      const isDrumBit = extractBits(unpacked, baseBitOff, 1);
      const isDrum = !!isDrumBit;

      let enabled;
      if (isDrum) {
        enabled = !!extractBits(unpacked, baseBitOff + 81 * 8, 1);
      } else {
        enabled = !!extractBits(unpacked, baseBitOff + 84 * 8 + 3, 1);
      }

      const sound = { isDrum, enabled };
      if (isDrum) {
        sound.drums = parseDrumSound(unpacked, baseBitOff);
      } else {
        sound.keyboard = parseKeyboardSound(unpacked, baseBitOff);
      }
      prog.sounds.push(sound);
    }

    return prog;
  }

  static fromSysex(response) {
    const packed = response.slice(7, response.length - 1);
    const unpacked = unpackQSData(packed);
    return Program.fromUnpacked(unpacked);
  }

  toUnpacked() {
    // Program unpacked size: 350 bytes (based on QS spec)
    const unpacked = new Array(350).fill(0);

    encodeProgName(unpacked, this.name);
    setBits(unpacked, 78, 2, this.romId);

    for (let s = 0; s < 4; s++) {
      const baseBitOff = SOUND_BYTE_OFFSETS[s] * 8;
      const sound = this.sounds[s];
      setBits(unpacked, baseBitOff, 1, sound.isDrum ? 1 : 0);

      if (sound.isDrum) {
        setBits(unpacked, baseBitOff + 81 * 8, 1, sound.enabled ? 1 : 0);
        serializeDrumSound(sound.drums, unpacked, baseBitOff);
      } else {
        setBits(unpacked, baseBitOff + 84 * 8 + 3, 1, sound.enabled ? 1 : 0);
        serializeKeyboardSound(sound.keyboard, unpacked, baseBitOff);
      }
    }

    return unpacked;
  }
}

// --- Mix class ---

const MIX_CHANNEL_FIELDS = [
  ['programNumber', 0, 7],
  ['programType', 7, 4],
  ['enable', 11, 1],
  ['volume', 12, 7],
  ['pan', 19, 3],
  ['output', 22, 2],
  ['effectLevel', 24, 7],
  ['effectBus', 31, 3],
  ['pitchOctave', 34, 3],
  ['pitchSemitone', 37, 5],
  ['lowNote', 42, 7],
  ['highNote', 49, 7],
  ['midiIn', 56, 1],
  ['midiOut', 57, 1],
  ['midiGroup', 58, 1],
  ['wheels', 59, 1],
  ['aftertouch', 60, 1],
  ['sustainPedal', 61, 1],
  ['pedalsControllers', 62, 1],
];

export class Mix {
  constructor() {
    this.name = '';
    this.effectMidiPC = false;
    this.effectChannel = 0;
    this.channels = [];
  }

  static fromUnpacked(unpacked) {
    const mix = new Mix();
    mix.name = extractMixName(unpacked);
    mix.effectMidiPC = !!extractBits(unpacked, 0, 1);
    mix.effectChannel = extractBits(unpacked, 1, 4);

    for (let ch = 0; ch < 16; ch++) {
      const baseBit = (10 + ch * 8) * 8;
      const channel = {};
      for (const [name, addr, bits] of MIX_CHANNEL_FIELDS) {
        const raw = extractBits(unpacked, baseBit + addr, bits);
        // Boolean fields (1-bit)
        if (bits === 1) {
          channel[name] = !!raw;
        } else {
          channel[name] = raw;
        }
      }
      mix.channels.push(channel);
    }

    return mix;
  }

  static fromSysex(response) {
    const packed = response.slice(7, response.length - 1);
    const unpacked = unpackQSData(packed);
    return Mix.fromUnpacked(unpacked);
  }

  toUnpacked() {
    // Mix unpacked size: 138 bytes (10 header + 16 channels * 8 bytes each)
    const unpacked = new Array(138).fill(0);

    encodeMixName(unpacked, this.name);
    setBits(unpacked, 0, 1, this.effectMidiPC ? 1 : 0);
    setBits(unpacked, 1, 4, this.effectChannel);

    for (let ch = 0; ch < 16; ch++) {
      const baseBit = (10 + ch * 8) * 8;
      const channel = this.channels[ch];
      for (const [name, addr, bits] of MIX_CHANNEL_FIELDS) {
        let val = channel[name];
        if (typeof val === 'boolean') val = val ? 1 : 0;
        setBits(unpacked, baseBit + addr, bits, val);
      }
    }

    return unpacked;
  }
}

// --- Device I/O functions ---

export async function readProgram(output, input, programNum) {
  const response = await requestUserProgram(output, input, programNum);
  return Program.fromSysex(response);
}

export async function writeProgram(output, programNum, program) {
  const unpacked = program.toUnpacked();
  const packed = packQSData(unpacked);
  sendUserProgram(output, programNum, new Uint8Array(packed));
}

export async function readMix(output, input, mixNum) {
  const response = await requestNewMix(output, input, mixNum);
  return Mix.fromSysex(response);
}

export async function writeMix(output, mixNum, mix) {
  const unpacked = mix.toUnpacked();
  const packed = packQSData(unpacked);
  sendNewMix(output, mixNum, new Uint8Array(packed));
}

export async function readEditProgram(output, input) {
  const response = await requestEditProgram(output, input, 0);
  return Program.fromSysex(response);
}

export async function readEditMix(output, input) {
  const response = await requestNewMix(output, input, 100);
  return Mix.fromSysex(response);
}
