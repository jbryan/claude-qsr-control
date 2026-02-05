import { unpackQSData, packQSData, requestUserProgram, requestEditProgram, requestNewMix, sendUserProgram, sendNewMix, requestUserEffects, sendUserEffects, requestEditEffects, sendEditEffects } from './midi.js';

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

// --- Effect class ---

// Bit address conversion from the QS spec: "MSB:bit-LSB:bit" notation.
// Flat bit offset = LSB_byte * 8 + LSB_bit.
// Num bits = (MSB_byte * 8 + MSB_bit) - flat_offset + 1.

// Modulation fields: same bit positions across all 5 configurations.
const EFFECT_MOD_FIELDS = [
  ['mod.source1',      470, 4],  // 59:1-58:6
  ['mod.destination1', 474, 6],  // 59:7-59:2
  ['mod.level1',       480, 8],  // 60:7-60:0
  ['mod.source2',      488, 4],  // 61:3-61:0
  ['mod.destination2', 492, 6],  // 62:1-61:4
  ['mod.level2',       498, 8],  // 63:1-62:2
];

// --- Reusable block builders ---
// Each returns an array of [fieldPath, bitOffset, numBits] entries.

// Pitch block: 3-bit type (configs 0, 3 sends 1-2)
// Variant fields: for type 0-3 (chorus/flange): speed, shape, depth, feedback.
// For type 4 (detune): speed+shape bits form 8-bit detune value.
// For type 5 (resonator): speed=tuning, depth=decay, feedback is spare.
function buildPitchFields3(prefix, baseOff) {
  return [
    [`${prefix}.type`,     baseOff,      3],
    [`${prefix}.speed`,    baseOff + 3,  7],
    [`${prefix}.shape`,    baseOff + 10, 1],
    [`${prefix}.depth`,    baseOff + 11, 7],
    [`${prefix}.feedback`, baseOff + 18, 7],
    [`${prefix}.mix`,      baseOff + 25, 7],
  ];
}

// Full delay block with type, input, stereo params (configs 0, 3, 4 sends 1-2)
// Variant fields: for stereo delay, param1=rightTime10ms, param2=rightTime1ms,
// param3=rightFeedback, feedback=leftFeedback. For mono/ping-pong, these are spare.
function buildFullDelayFields(prefix, baseOff) {
  return [
    [`${prefix}.type`,     baseOff,      2],
    [`${prefix}.input`,    baseOff + 2,  8],
    [`${prefix}.time10ms`, baseOff + 10, 7],
    [`${prefix}.time1ms`,  baseOff + 17, 4],
    [`${prefix}.param1`,   baseOff + 21, 6],
    [`${prefix}.param2`,   baseOff + 27, 4],
    [`${prefix}.feedback`, baseOff + 31, 7],
    [`${prefix}.param3`,   baseOff + 38, 7],
    [`${prefix}.mix`,      baseOff + 45, 7],
  ];
}

// Full reverb block: type + 14 params (configs 0, 2, 3 send 1; configs 1, 4 similar)
function buildFullReverbFields(prefix, offsets) {
  return [
    [`${prefix}.type`,         offsets.type,         4],
    [`${prefix}.input1`,       offsets.input1,       1],
    [`${prefix}.input2`,       offsets.input2,       2],
    [`${prefix}.balance`,      offsets.balance,      8],
    [`${prefix}.inputLevel`,   offsets.inputLevel,   7],
    [`${prefix}.predelay10ms`, offsets.predelay10ms, 5],
    [`${prefix}.predelay1ms`,  offsets.predelay1ms,  4],
    [`${prefix}.inputPremix`,  offsets.inputPremix,  8],
    [`${prefix}.inputFilter`,  offsets.inputFilter,  7],
    [`${prefix}.decay`,        offsets.decay,        7],
    [`${prefix}.diffusion`,    offsets.diffusion,    7],
    [`${prefix}.density`,      offsets.density,      7],
    [`${prefix}.lowDecay`,     offsets.lowDecay,     7],
    [`${prefix}.highDecay`,    offsets.highDecay,    7],
    [`${prefix}.mix`,          offsets.mix,          7],
  ];
}

// Partial reverb: input routing + balance + level (config 0 sends 2-3)
function buildPartialReverbFields(prefix, offsets) {
  return [
    [`${prefix}.input1`,     offsets.input1,     1],
    [`${prefix}.input2`,     offsets.input2,     2],
    [`${prefix}.balance`,    offsets.balance,    8],
    [`${prefix}.inputLevel`, offsets.inputLevel, 7],
  ];
}

// --- Shared config 0 block fragments ---
// These are used by configs 0, 2, and 3 which share most of config 0's layout.

const CONFIG0_PITCH_SEND1 = buildPitchFields3('send1.pitch', 74);

const CONFIG0_DELAY_SEND1 = buildFullDelayFields('send1.delay', 106);

const CONFIG0_REVERB_SEND1 = buildFullReverbFields('send1.reverb', {
  type: 158, input1: 162, input2: 163, balance: 165, inputLevel: 173,
  predelay10ms: 180, predelay1ms: 185, inputPremix: 189, inputFilter: 197,
  decay: 204, diffusion: 211, density: 218, lowDecay: 225, highDecay: 232, mix: 239,
});

const CONFIG0_PITCH_SEND2 = buildPitchFields3('send2.pitch', 246);

const CONFIG0_DELAY_SEND2 = buildFullDelayFields('send2.delay', 278);

const CONFIG0_REVERB_SEND2 = buildPartialReverbFields('send2.reverb', {
  input1: 330, input2: 331, balance: 333, inputLevel: 341,
});

// Send 3 pitch: only 2-bit type (0=chorus, 1=flange, 2=resonator; no detune)
const CONFIG0_PITCH_SEND3 = [
  ['send3.pitch.type',     348, 2],
  ['send3.pitch.speed',    350, 7],
  ['send3.pitch.shape',    357, 1],
  ['send3.pitch.depth',    358, 7],
  ['send3.pitch.feedback', 365, 7],
  ['send3.pitch.mix',      372, 7],
];

// Send 3 delay: mono only (no type field)
const CONFIG0_DELAY_SEND3 = [
  ['send3.delay.input',    379, 8],
  ['send3.delay.time10ms', 387, 7],
  ['send3.delay.time1ms',  394, 4],
  ['send3.delay.feedback', 398, 7],
  ['send3.delay.mix',      405, 7],
];

const CONFIG0_REVERB_SEND3 = buildPartialReverbFields('send3.reverb', {
  input1: 412, input2: 413, balance: 415, inputLevel: 423,
});

// Send 4 delay: simplified (no type, no input)
const CONFIG0_DELAY_SEND4 = [
  ['send4.delay.time10ms', 430, 7],
  ['send4.delay.time1ms',  437, 4],
  ['send4.delay.feedback', 441, 7],
  ['send4.delay.mix',      448, 7],
];

// Send 4 reverb: minimal (balance + level only)
const CONFIG0_REVERB_SEND4 = [
  ['send4.reverb.balance',    455, 8],
  ['send4.reverb.inputLevel', 463, 7],
];

// Params 26-81 of config 0 (reverb send 1 through reverb send 4)
const CONFIG0_PARAMS_26_TO_81 = [
  ...CONFIG0_REVERB_SEND1,
  ...CONFIG0_PITCH_SEND2,
  ...CONFIG0_DELAY_SEND2,
  ...CONFIG0_REVERB_SEND2,
  ...CONFIG0_PITCH_SEND3,
  ...CONFIG0_DELAY_SEND3,
  ...CONFIG0_REVERB_SEND3,
  ...CONFIG0_DELAY_SEND4,
  ...CONFIG0_REVERB_SEND4,
];

// --- Configuration 0: 4-sends, 1 reverb ---
const EFFECT_CONFIG0_FIELDS = [
  ...CONFIG0_PITCH_SEND1,
  ...CONFIG0_DELAY_SEND1,
  ...CONFIG0_PARAMS_26_TO_81,
];

// --- Configuration 1: 4-sends, 2 reverb ---
const EFFECT_CONFIG1_FIELDS = [
  // DELAY SEND 1
  ['send1.delay.time10ms', 74,  7],  // 10:0-9:2
  ['send1.delay.time1ms',  81,  4],  // 10:4-10:1
  ['send1.delay.feedback', 85,  7],  // 11:3-10:5
  ['send1.delay.mix',      92,  7],  // 12:2-11:4
  // PITCH SEND 1
  ['send1.pitch.inputLevel', 99,  7],  // 13:1-12:3
  ['send1.pitch.type',      106, 1],  // 13:2
  ['send1.pitch.speed',     107, 7],  // 14:1-13:3
  ['send1.pitch.shape',     114, 1],  // 14:2
  ['send1.pitch.depth',     115, 7],  // 15:1-14:3
  ['send1.pitch.mix',       122, 7],  // 16:0-15:2
  // REVERB SEND 1 (no input routing/balance in config 1)
  ['send1.reverb.type',         129, 4],  // 16:4-16:1
  ['send1.reverb.inputLevel',   133, 7],  // 17:3-16:5
  ['send1.reverb.predelay10ms', 140, 5],  // 18:0-17:4
  ['send1.reverb.predelay1ms',  145, 4],  // 18:4-18:1
  ['send1.reverb.inputPremix',  149, 8],  // 19:4-18:5
  ['send1.reverb.inputFilter',  157, 7],  // 20:3-19:5
  ['send1.reverb.decay',        164, 7],  // 21:2-20:4
  ['send1.reverb.diffusion',    171, 7],  // 22:1-21:3
  ['send1.reverb.density',      178, 7],  // 23:0-22:2
  ['send1.reverb.lowDecay',     185, 7],  // 23:7-23:1
  ['send1.reverb.highDecay',    192, 7],  // 24:6-24:0
  ['send1.reverb.mix',          199, 7],  // 25:5-24:7
  // REVERB SEND 2 (input level only)
  ['send2.reverb.inputLevel', 206, 7],  // 26:4-25:6
  // PITCH SEND 3 (speed, shape, depth only - no type, no mix)
  ['send3.pitch.speed', 213, 7],  // 27:3-26:5
  ['send3.pitch.shape', 220, 1],  // 27:4
  ['send3.pitch.depth', 221, 7],  // 28:3-27:5
  // REVERB SEND 3 (no input routing/balance in config 1)
  ['send3.reverb.type',         228, 4],  // 28:7-28:4
  ['send3.reverb.inputLevel',   232, 7],  // 29:6-29:0
  ['send3.reverb.predelay10ms', 239, 5],  // 30:3-29:7
  ['send3.reverb.predelay1ms',  244, 4],  // 30:7-30:4
  ['send3.reverb.inputPremix',  248, 8],  // 31:7-31:0
  ['send3.reverb.inputFilter',  256, 7],  // 32:6-32:0
  ['send3.reverb.decay',        263, 7],  // 33:5-32:7
  ['send3.reverb.diffusion',    270, 7],  // 34:4-33:6
  ['send3.reverb.density',      277, 7],  // 35:3-34:5
  ['send3.reverb.lowDecay',     284, 7],  // 36:2-35:4
  ['send3.reverb.highDecay',    291, 7],  // 37:1-36:3
  ['send3.reverb.mix',          298, 7],  // 38:0-37:2
  // REVERB SEND 4 (input level only)
  ['send4.reverb.inputLevel', 305, 7],  // 38:7-38:1
];

// --- Configuration 2: 4-sends, 1 lezlie ---
// Send 1 replaces pitch with lezlie; delay is simplified (no type).
// Params 26-81 identical to config 0.
const EFFECT_CONFIG2_FIELDS = [
  // LEZLIE SEND 1 (replaces pitch)
  ['send1.lezlie.speed', 77,  7],  // 10:3-9:5  (value 0-1, stored in 7 bits)
  ['send1.lezlie.motor', 84,  1],  // 10:4
  ['send1.lezlie.horn',  85,  7],  // 11:3-10:5 (7-bit signed: 0-6 positive, 122-127 negative)
  ['send1.lezlie.mix',   99,  7],  // 13:1-12:3
  // DELAY SEND 1 (no type; input is unsigned 0-99 in config 2)
  ['send1.delay.input',    108, 8],  // 14:3-13:4
  ['send1.delay.time10ms', 116, 7],  // 15:2-14:4
  ['send1.delay.time1ms',  123, 4],  // 15:6-15:3
  ['send1.delay.feedback', 137, 7],  // 17:7-17:1
  ['send1.delay.mix',      151, 7],  // 19:5-18:7
  // PARAMS 26-81: identical to config 0
  ...CONFIG0_PARAMS_26_TO_81,
];

// --- Configuration 3: 2-sends, with EQ ---
// Params 11-56 identical to config 0 (send 1 pitch/delay/reverb + send 2 pitch/delay).
// Send 2 reverb is partial (same bit positions as config 0).
// EQ section replaces sends 3-4.
const CONFIG3_EQ_FIELDS = [
  ['eq.loFreq', 350, 3],  // 44:0-43:6
  ['eq.loGain', 358, 4],  // 45:1-44:6
  ['eq.hiFreq', 365, 3],  // 45:7-45:5
  ['eq.hiGain', 372, 4],  // 46:7-46:4
];

const EFFECT_CONFIG3_FIELDS = [
  ...CONFIG0_PITCH_SEND1,
  ...CONFIG0_DELAY_SEND1,
  ...CONFIG0_REVERB_SEND1,
  ...CONFIG0_PITCH_SEND2,
  ...CONFIG0_DELAY_SEND2,
  ...CONFIG0_REVERB_SEND2,
  ...CONFIG3_EQ_FIELDS,
];

// --- Configuration 4: Overdrive, Chorus, Delay, Reverb, Lezlie ---
// Everything on send 1; fields scattered across the byte array.
const EFFECT_CONFIG4_FIELDS = [
  // PITCH SEND 1 (2-bit type: 0=chorus, 1=flange, 2=resonator)
  ['send1.pitch.type',         74,  2],   // 9:3-9:2
  ['send1.pitch.speed',        77,  7],   // 10:3-9:5
  ['send1.pitch.shape',        84,  1],   // 10:4
  ['send1.pitch.depth',        85,  7],   // 11:3-10:5
  ['send1.pitch.feedback',     92,  7],   // 12:2-11:4
  ['send1.pitch.mix',          99,  7],   // 13:1-12:3
  ['send1.pitch.input2',       163, 2],   // 20:4-20:3
  ['send1.pitch.inputBalance', 280, 8],   // 35:7-35:0
  // LEZLIE SEND 1 (scattered bit positions)
  ['send1.lezlie.input1',       331, 1],  // 41:3
  ['send1.lezlie.input2',       323, 4],  // 40:6-40:3
  ['send1.lezlie.inputBalance', 333, 8],  // 42:4-41:5
  ['send1.lezlie.speed',        309, 1],  // 38:5
  ['send1.lezlie.motor',        330, 1],  // 41:2
  ['send1.lezlie.horn',         316, 7],  // 40:2-39:4
  ['send1.lezlie.mix',          249, 7],  // 31:7-31:1
  // DELAY SEND 1 (with type and extra routing)
  ['send1.delay.type',         106, 2],   // 13:3-13:2
  ['send1.delay.inputBalance', 108, 8],   // 14:3-13:4
  ['send1.delay.time10ms',     116, 7],   // 15:2-14:4
  ['send1.delay.time1ms',      123, 4],   // 15:6-15:3
  ['send1.delay.param1',       127, 6],   // 16:4-15:7
  ['send1.delay.param2',       133, 4],   // 17:0-16:5
  ['send1.delay.feedback',     137, 7],   // 17:7-17:1
  ['send1.delay.param3',       144, 7],   // 18:6-18:0
  ['send1.delay.mix',          151, 7],   // 19:5-18:7
  ['send1.delay.input2',       288, 3],   // 36:2-36:0
  // REVERB SEND 1 (full, with scattered input2)
  ['send1.reverb.type',         158, 4],  // 20:1-19:6
  ['send1.reverb.input1',       162, 1],  // 20:2
  ['send1.reverb.input2',       246, 3],  // 31:0-30:6
  ['send1.reverb.balance',      165, 8],  // 21:4-20:5
  ['send1.reverb.inputLevel',   173, 7],  // 22:3-21:5
  ['send1.reverb.predelay10ms', 180, 5],  // 23:0-22:4
  ['send1.reverb.predelay1ms',  185, 4],  // 23:4-23:1
  ['send1.reverb.inputPremix',  189, 8],  // 24:4-23:5
  ['send1.reverb.inputFilter',  197, 7],  // 25:3-24:5
  ['send1.reverb.decay',        204, 7],  // 26:2-25:4
  ['send1.reverb.diffusion',    211, 7],  // 27:1-26:3
  ['send1.reverb.density',      218, 7],  // 28:0-27:2
  ['send1.reverb.lowDecay',     225, 7],  // 28:7-28:1
  ['send1.reverb.highDecay',    232, 7],  // 29:6-29:0
  ['send1.reverb.mix',          239, 7],  // 30:5-29:7
  // OVERDRIVE SEND 1
  ['send1.overdrive.type',       357, 1],  // 44:5
  ['send1.overdrive.balance',    379, 8],  // 48:2-47:3
  ['send1.overdrive.threshold',  398, 7],  // 50:4-49:6
  ['send1.overdrive.brightness', 387, 7],  // 49:1-48:3
  // EQUALIZER
  ...CONFIG3_EQ_FIELDS,
];

// Per-configuration field lookup
const EFFECT_CONFIG_FIELDS = [
  EFFECT_CONFIG0_FIELDS,
  EFFECT_CONFIG1_FIELDS,
  EFFECT_CONFIG2_FIELDS,
  EFFECT_CONFIG3_FIELDS,
  EFFECT_CONFIG4_FIELDS,
];

export class Effect {
  constructor() {
    this.configuration = 0;
    this.mod = {};
  }

  static fromUnpacked(unpacked) {
    const effect = new Effect();

    effect.configuration = extractBits(unpacked, 70, 4);

    const configFields = EFFECT_CONFIG_FIELDS[effect.configuration] || EFFECT_CONFIG0_FIELDS;
    for (const [path, bitOffset, numBits] of configFields) {
      const val = extractBits(unpacked, bitOffset, numBits);
      setNestedField(effect, path, val);
    }

    for (const [path, bitOffset, numBits] of EFFECT_MOD_FIELDS) {
      const val = extractBits(unpacked, bitOffset, numBits);
      setNestedField(effect, path, val);
    }

    return effect;
  }

  static fromSysex(response) {
    const packed = response.slice(7, response.length - 1);
    const unpacked = unpackQSData(packed);
    return Effect.fromUnpacked(unpacked);
  }

  toUnpacked() {
    const unpacked = new Array(65).fill(0);

    setBits(unpacked, 70, 4, this.configuration);

    const configFields = EFFECT_CONFIG_FIELDS[this.configuration] || EFFECT_CONFIG0_FIELDS;
    for (const [path, bitOffset, numBits] of configFields) {
      const val = getNestedField(this, path);
      if (val !== undefined) {
        setBits(unpacked, bitOffset, numBits, val);
      }
    }

    for (const [path, bitOffset, numBits] of EFFECT_MOD_FIELDS) {
      const val = getNestedField(this, path);
      if (val !== undefined) {
        setBits(unpacked, bitOffset, numBits, val);
      }
    }

    return unpacked;
  }
}

// --- Device I/O functions ---

export async function readProgram(output, input, programNum) {
  const response = await requestUserProgram(output, input, programNum);
  const program = Program.fromSysex(response);
  const effectResponse = await requestUserEffects(output, input, programNum);
  program.effect = Effect.fromSysex(effectResponse);
  return program;
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
  const program = Program.fromSysex(response);
  const effectResponse = await requestEditEffects(output, input, 0);
  program.effect = Effect.fromSysex(effectResponse);
  return program;
}

export async function readEditMix(output, input) {
  const response = await requestNewMix(output, input, 100);
  return Mix.fromSysex(response);
}

export async function readEffect(output, input, effectNum) {
  const response = await requestUserEffects(output, input, effectNum);
  return Effect.fromSysex(response);
}

export async function writeEffect(output, effectNum, effect) {
  const unpacked = effect.toUnpacked();
  const packed = packQSData(unpacked);
  sendUserEffects(output, effectNum, new Uint8Array(packed));
}

export async function readEditEffect(output, input, editNum) {
  const response = await requestEditEffects(output, input, editNum);
  return Effect.fromSysex(response);
}

export async function writeEditEffect(output, editNum, effect) {
  const unpacked = effect.toUnpacked();
  const packed = packQSData(unpacked);
  sendEditEffects(output, editNum, new Uint8Array(packed));
}
