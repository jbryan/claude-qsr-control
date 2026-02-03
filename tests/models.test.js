import { jest } from '@jest/globals';
import { MockMIDIInput, MockMIDIOutput, setMockMIDIAccess, MockMIDIAccess } from './setup.js';
import { extractBits, setBits, extractProgName, extractMixName, encodeProgName, encodeMixName, Program, Mix, readProgram, writeProgram, readMix, writeMix } from '../public/js/models.js';
import { packQSData, unpackQSData } from '../public/js/midi.js';

// --- extractBits / setBits ---

describe('extractBits', () => {
  test('extracts single bit', () => {
    expect(extractBits([0b00000010], 1, 1)).toBe(1);
    expect(extractBits([0b00000010], 0, 1)).toBe(0);
  });

  test('extracts multi-bit value within a byte', () => {
    expect(extractBits([0b01101100], 2, 4)).toBe(0b1011);
  });

  test('extracts value spanning two bytes', () => {
    const bytes = [0b11000000, 0b00000011];
    // bits 6-9: 4 bits = 1111
    expect(extractBits(bytes, 6, 4)).toBe(0b1111);
  });

  test('extracts 7-bit value', () => {
    const bytes = [0x7F];
    expect(extractBits(bytes, 0, 7)).toBe(127);
  });
});

describe('setBits', () => {
  test('sets single bit', () => {
    const bytes = [0];
    setBits(bytes, 3, 1, 1);
    expect(bytes[0]).toBe(0b00001000);
  });

  test('clears single bit', () => {
    const bytes = [0xFF];
    setBits(bytes, 3, 1, 0);
    expect(bytes[0]).toBe(0b11110111);
  });

  test('sets multi-bit value within a byte', () => {
    const bytes = [0];
    setBits(bytes, 2, 4, 0b1011);
    expect(bytes[0]).toBe(0b00101100);
  });

  test('sets value spanning two bytes', () => {
    const bytes = [0, 0];
    setBits(bytes, 6, 4, 0b1111);
    expect(bytes[0]).toBe(0b11000000);
    expect(bytes[1]).toBe(0b00000011);
  });
});

describe('extractBits / setBits inverse property', () => {
  test.each([
    [1, 0, 1],
    [3, 0, 4],
    [7, 0, 7],
    [8, 0, 8],
    [5, 3, 6],
    [127, 1, 7],
    [255, 0, 8],
    [0, 0, 1],
  ])('round-trips value %i at offset %i with %i bits', (value, offset, bits) => {
    const bytes = new Array(4).fill(0);
    setBits(bytes, offset, bits, value);
    expect(extractBits(bytes, offset, bits)).toBe(value);
  });

  test('preserves surrounding bits', () => {
    const bytes = [0xFF, 0xFF];
    setBits(bytes, 4, 4, 0);
    expect(extractBits(bytes, 0, 4)).toBe(0xF);
    expect(extractBits(bytes, 4, 4)).toBe(0);
    expect(extractBits(bytes, 8, 8)).toBe(0xFF);
  });
});

// --- Name helpers ---

describe('name helpers', () => {
  test('extractProgName / encodeProgName round-trip', () => {
    const unpacked = new Array(20).fill(0);
    encodeProgName(unpacked, 'TestName');
    expect(extractProgName(unpacked)).toBe('TestName');
  });

  test('extractMixName / encodeMixName round-trip', () => {
    const unpacked = new Array(20).fill(0);
    encodeMixName(unpacked, 'Mix Test');
    expect(extractMixName(unpacked)).toBe('Mix Test');
  });

  test('name is padded to 10 chars', () => {
    const unpacked = new Array(20).fill(0);
    encodeProgName(unpacked, 'Hi');
    // Raw extraction (without trim) should have trailing spaces
    let raw = '';
    for (let i = 0; i < 10; i++) {
      raw += String.fromCharCode(extractBits(unpacked, 8 + i * 7, 7) + 32);
    }
    expect(raw).toBe('Hi        ');
    expect(extractProgName(unpacked)).toBe('Hi');
  });

  test('name is truncated to 10 chars', () => {
    const unpacked = new Array(20).fill(0);
    encodeProgName(unpacked, 'VeryLongNameThatExceedsTen');
    expect(extractProgName(unpacked)).toBe('VeryLongNa');
  });
});

// --- Helper to build a fake SysEx program dump ---

function buildProgramUnpacked(name, romId, soundConfigs) {
  const unpacked = new Array(350).fill(0);
  encodeProgName(unpacked, name);
  setBits(unpacked, 78, 2, romId);

  const soundBases = [10, 95, 180, 265];
  for (let s = 0; s < 4; s++) {
    const baseBitOff = soundBases[s] * 8;
    const cfg = soundConfigs[s] || {};
    if (cfg.isDrum) {
      setBits(unpacked, baseBitOff, 1, 1);
      setBits(unpacked, baseBitOff + 81 * 8, 1, cfg.enabled ? 1 : 0);
    } else {
      setBits(unpacked, baseBitOff, 1, 0);
      setBits(unpacked, baseBitOff + 84 * 8 + 3, 1, cfg.enabled ? 1 : 0);
      // Set some keyboard fields
      if (cfg.sampleGroup !== undefined) {
        setBits(unpacked, baseBitOff + 1, 6, cfg.sampleGroup);
      }
      if (cfg.sampleNumber !== undefined) {
        setBits(unpacked, baseBitOff + 7, 7, cfg.sampleNumber);
      }
      if (cfg.volume !== undefined) {
        setBits(unpacked, baseBitOff + 14, 7, cfg.volume);
      }
    }
  }
  return unpacked;
}

function wrapInSysex(opcode, num, unpacked) {
  const packed = packQSData(unpacked);
  const msg = new Uint8Array(7 + packed.length + 1);
  msg[0] = 0xF0;
  msg[1] = 0x00; msg[2] = 0x00; msg[3] = 0x0E; msg[4] = 0x0E;
  msg[5] = opcode;
  msg[6] = num & 0x7F;
  msg.set(new Uint8Array(packed), 7);
  msg[msg.length - 1] = 0xF7;
  return msg;
}

// --- Program class ---

describe('Program', () => {
  test('fromUnpacked parses name and romId', () => {
    const unpacked = buildProgramUnpacked('TestProg', 1, [
      { enabled: true },
      { enabled: false },
      { enabled: false },
      { enabled: false },
    ]);
    const prog = Program.fromUnpacked(unpacked);
    expect(prog.name).toBe('TestProg');
    expect(prog.romId).toBe(1);
  });

  test('fromUnpacked parses 4 sounds', () => {
    const unpacked = buildProgramUnpacked('FourSounds', 0, [
      { enabled: true, sampleGroup: 3, sampleNumber: 42, volume: 99 },
      { enabled: true },
      { isDrum: true, enabled: true },
      { enabled: false },
    ]);
    const prog = Program.fromUnpacked(unpacked);
    expect(prog.sounds).toHaveLength(4);
    expect(prog.sounds[0].isDrum).toBe(false);
    expect(prog.sounds[0].enabled).toBe(true);
    expect(prog.sounds[0].keyboard.sample.group).toBe(3);
    expect(prog.sounds[0].keyboard.sample.number).toBe(42);
    expect(prog.sounds[0].keyboard.level.volume).toBe(99);
    expect(prog.sounds[2].isDrum).toBe(true);
    expect(prog.sounds[2].enabled).toBe(true);
    expect(prog.sounds[3].enabled).toBe(false);
  });

  test('toUnpacked / fromUnpacked round-trip', () => {
    const unpacked = buildProgramUnpacked('RoundTrip', 2, [
      { enabled: true, sampleGroup: 5, sampleNumber: 10, volume: 80 },
      { enabled: true, sampleGroup: 1, sampleNumber: 20, volume: 64 },
      { enabled: false },
      { isDrum: true, enabled: true },
    ]);
    const prog1 = Program.fromUnpacked(unpacked);
    const reUnpacked = prog1.toUnpacked();
    const prog2 = Program.fromUnpacked(reUnpacked);

    expect(prog2.name).toBe(prog1.name);
    expect(prog2.romId).toBe(prog1.romId);
    for (let s = 0; s < 4; s++) {
      expect(prog2.sounds[s].isDrum).toBe(prog1.sounds[s].isDrum);
      expect(prog2.sounds[s].enabled).toBe(prog1.sounds[s].enabled);
      if (!prog1.sounds[s].isDrum && prog1.sounds[s].enabled) {
        expect(prog2.sounds[s].keyboard.sample.group).toBe(prog1.sounds[s].keyboard.sample.group);
        expect(prog2.sounds[s].keyboard.sample.number).toBe(prog1.sounds[s].keyboard.sample.number);
        expect(prog2.sounds[s].keyboard.level.volume).toBe(prog1.sounds[s].keyboard.level.volume);
      }
    }
  });

  test('fromSysex handles SysEx header/trailer', () => {
    const unpacked = buildProgramUnpacked('SysExTest', 0, [
      { enabled: true, sampleGroup: 2, sampleNumber: 7 },
      { enabled: false },
      { enabled: false },
      { enabled: false },
    ]);
    const sysex = wrapInSysex(0x00, 5, unpacked);
    const prog = Program.fromSysex(sysex);
    expect(prog.name).toBe('SysExTest');
    expect(prog.sounds[0].keyboard.sample.group).toBe(2);
    expect(prog.sounds[0].keyboard.sample.number).toBe(7);
  });

  test('keyboard sound fields round-trip completely', () => {
    // Build a program with various keyboard field values
    const unpacked = new Array(350).fill(0);
    encodeProgName(unpacked, 'FullKB');
    const baseBitOff = 10 * 8; // sound 0
    setBits(unpacked, baseBitOff, 1, 0); // keyboard
    setBits(unpacked, baseBitOff + 84 * 8 + 3, 1, 1); // enabled

    // Set some pitch fields
    setBits(unpacked, baseBitOff + 35, 6, 30); // semitone
    setBits(unpacked, baseBitOff + 41, 8, 200); // detune
    setBits(unpacked, baseBitOff + 49, 1, 1); // detuneType

    // Set some filter fields
    setBits(unpacked, baseBitOff + 89, 7, 100); // frequency
    setBits(unpacked, baseBitOff + 96, 1, 1); // keyboardTrack

    // Set mod routing
    setBits(unpacked, baseBitOff + 178, 5, 14); // mod 0 source
    setBits(unpacked, baseBitOff + 183, 5, 4); // mod 0 destination
    setBits(unpacked, baseBitOff + 188, 8, 150); // mod 0 amplitude

    // Set LFO
    setBits(unpacked, baseBitOff + 292, 3, 5); // pitch LFO waveform
    setBits(unpacked, baseBitOff + 295, 7, 64); // pitch LFO speed

    // Set envelope
    setBits(unpacked, baseBitOff + 418, 7, 50); // pitch env attack
    setBits(unpacked, baseBitOff + 471, 8, 200); // pitch env velocity mod

    // Set tracking
    setBits(unpacked, baseBitOff + 593, 5, 13); // tracking input
    setBits(unpacked, baseBitOff + 598, 7, 100); // tracking point 0

    // Other 3 sounds disabled
    for (let s = 1; s < 4; s++) {
      const base = [95, 180, 265][s - 1] * 8;
      setBits(unpacked, base, 1, 0);
    }

    const prog = Program.fromUnpacked(unpacked);
    const kb = prog.sounds[0].keyboard;
    expect(kb.pitch.semitone).toBe(30);
    expect(kb.pitch.detune).toBe(200);
    expect(kb.pitch.detuneType).toBe(1);
    expect(kb.filter.frequency).toBe(100);
    expect(kb.filter.keyboardTrack).toBe(1);
    expect(kb.mods[0].source).toBe(14);
    expect(kb.mods[0].destination).toBe(4);
    expect(kb.mods[0].amplitude).toBe(150);
    expect(kb.pitchLfo.waveform).toBe(5);
    expect(kb.pitchLfo.speed).toBe(64);
    expect(kb.pitchEnv.attack).toBe(50);
    expect(kb.pitchEnv.velocityMod).toBe(200);
    expect(kb.tracking.input).toBe(13);
    expect(kb.tracking.points[0]).toBe(100);

    // Round-trip
    const reUnpacked = prog.toUnpacked();
    const prog2 = Program.fromUnpacked(reUnpacked);
    const kb2 = prog2.sounds[0].keyboard;
    expect(kb2.pitch.semitone).toBe(30);
    expect(kb2.pitch.detune).toBe(200);
    expect(kb2.mods[0].source).toBe(14);
    expect(kb2.pitchLfo.waveform).toBe(5);
    expect(kb2.pitchEnv.attack).toBe(50);
    expect(kb2.tracking.input).toBe(13);
    expect(kb2.tracking.points[0]).toBe(100);
  });

  test('drum sound fields round-trip', () => {
    const unpacked = new Array(350).fill(0);
    encodeProgName(unpacked, 'DrumTest');
    const baseBitOff = 10 * 8; // sound 0
    setBits(unpacked, baseBitOff, 1, 1); // drum
    setBits(unpacked, baseBitOff + 81 * 8, 1, 1); // enabled

    // Set drum 0 fields
    const drumBaseBit = baseBitOff + 8;
    setBits(unpacked, drumBaseBit + 0, 4, 3); // sampleGroup
    setBits(unpacked, drumBaseBit + 4, 7, 42); // sampleNumber
    setBits(unpacked, drumBaseBit + 11, 5, 20); // volume
    setBits(unpacked, drumBaseBit + 45, 7, 60); // noteNumber

    // Set drum 5 fields
    const drum5Bit = drumBaseBit + 5 * 72;
    setBits(unpacked, drum5Bit + 0, 4, 7); // sampleGroup
    setBits(unpacked, drum5Bit + 4, 7, 99); // sampleNumber

    // Remaining sounds disabled
    for (let s = 1; s < 4; s++) {
      const base = [95, 180, 265][s - 1] * 8;
      setBits(unpacked, base, 1, 0);
    }

    const prog = Program.fromUnpacked(unpacked);
    expect(prog.sounds[0].isDrum).toBe(true);
    expect(prog.sounds[0].drums[0].sampleGroup).toBe(3);
    expect(prog.sounds[0].drums[0].sampleNumber).toBe(42);
    expect(prog.sounds[0].drums[0].volume).toBe(20);
    expect(prog.sounds[0].drums[0].noteNumber).toBe(60);
    expect(prog.sounds[0].drums[5].sampleGroup).toBe(7);
    expect(prog.sounds[0].drums[5].sampleNumber).toBe(99);

    // Round-trip
    const reUnpacked = prog.toUnpacked();
    const prog2 = Program.fromUnpacked(reUnpacked);
    expect(prog2.sounds[0].drums[0].sampleGroup).toBe(3);
    expect(prog2.sounds[0].drums[0].sampleNumber).toBe(42);
    expect(prog2.sounds[0].drums[5].sampleGroup).toBe(7);
    expect(prog2.sounds[0].drums[5].sampleNumber).toBe(99);
  });
});

// --- Mix class ---

function buildMixUnpacked(name, effectMidiPC, effectChannel, channelConfigs) {
  const unpacked = new Array(138).fill(0);
  encodeMixName(unpacked, name);
  setBits(unpacked, 0, 1, effectMidiPC ? 1 : 0);
  setBits(unpacked, 1, 4, effectChannel);

  for (let ch = 0; ch < 16; ch++) {
    const baseBit = (10 + ch * 8) * 8;
    const cfg = channelConfigs[ch] || {};
    if (cfg.programNumber !== undefined) setBits(unpacked, baseBit + 0, 7, cfg.programNumber);
    if (cfg.programType !== undefined) setBits(unpacked, baseBit + 7, 4, cfg.programType);
    if (cfg.enable !== undefined) setBits(unpacked, baseBit + 11, 1, cfg.enable ? 1 : 0);
    if (cfg.volume !== undefined) setBits(unpacked, baseBit + 12, 7, cfg.volume);
    if (cfg.pan !== undefined) setBits(unpacked, baseBit + 19, 3, cfg.pan);
    if (cfg.lowNote !== undefined) setBits(unpacked, baseBit + 42, 7, cfg.lowNote);
    if (cfg.highNote !== undefined) setBits(unpacked, baseBit + 49, 7, cfg.highNote);
    if (cfg.midiIn !== undefined) setBits(unpacked, baseBit + 56, 1, cfg.midiIn ? 1 : 0);
  }
  return unpacked;
}

describe('Mix', () => {
  test('fromUnpacked parses name, effectMidiPC, effectChannel', () => {
    const unpacked = buildMixUnpacked('TestMix', true, 5, []);
    const mix = Mix.fromUnpacked(unpacked);
    expect(mix.name).toBe('TestMix');
    expect(mix.effectMidiPC).toBe(true);
    expect(mix.effectChannel).toBe(5);
  });

  test('fromUnpacked parses 16 channels', () => {
    const channels = new Array(16).fill(null).map(() => ({}));
    channels[0] = { programNumber: 42, programType: 1, enable: true, volume: 100, pan: 3 };
    channels[5] = { enable: true, lowNote: 24, highNote: 96, midiIn: true };
    channels[15] = { enable: false };
    const unpacked = buildMixUnpacked('ChTest', false, 0, channels);
    const mix = Mix.fromUnpacked(unpacked);

    expect(mix.channels).toHaveLength(16);
    expect(mix.channels[0].programNumber).toBe(42);
    expect(mix.channels[0].programType).toBe(1);
    expect(mix.channels[0].enable).toBe(true);
    expect(mix.channels[0].volume).toBe(100);
    expect(mix.channels[0].pan).toBe(3);
    expect(mix.channels[5].enable).toBe(true);
    expect(mix.channels[5].lowNote).toBe(24);
    expect(mix.channels[5].highNote).toBe(96);
    expect(mix.channels[5].midiIn).toBe(true);
    expect(mix.channels[15].enable).toBe(false);
  });

  test('toUnpacked / fromUnpacked round-trip', () => {
    const channels = new Array(16).fill(null).map(() => ({}));
    channels[0] = { programNumber: 10, programType: 2, enable: true, volume: 80, pan: 5 };
    channels[3] = { enable: true, lowNote: 36, highNote: 84, midiIn: true };
    const unpacked = buildMixUnpacked('MixRT', true, 7, channels);
    const mix1 = Mix.fromUnpacked(unpacked);
    const reUnpacked = mix1.toUnpacked();
    const mix2 = Mix.fromUnpacked(reUnpacked);

    expect(mix2.name).toBe(mix1.name);
    expect(mix2.effectMidiPC).toBe(mix1.effectMidiPC);
    expect(mix2.effectChannel).toBe(mix1.effectChannel);
    expect(mix2.channels[0].programNumber).toBe(mix1.channels[0].programNumber);
    expect(mix2.channels[0].programType).toBe(mix1.channels[0].programType);
    expect(mix2.channels[0].enable).toBe(mix1.channels[0].enable);
    expect(mix2.channels[0].volume).toBe(mix1.channels[0].volume);
    expect(mix2.channels[3].lowNote).toBe(mix1.channels[3].lowNote);
    expect(mix2.channels[3].highNote).toBe(mix1.channels[3].highNote);
  });

  test('fromSysex handles SysEx header/trailer', () => {
    const channels = new Array(16).fill(null).map(() => ({}));
    channels[0] = { programNumber: 55, enable: true };
    const unpacked = buildMixUnpacked('SyxMix', false, 3, channels);
    const sysex = wrapInSysex(0x0E, 10, unpacked);
    const mix = Mix.fromSysex(sysex);
    expect(mix.name).toBe('SyxMix');
    expect(mix.effectChannel).toBe(3);
    expect(mix.channels[0].programNumber).toBe(55);
    expect(mix.channels[0].enable).toBe(true);
  });

  test('boolean channel fields stored as booleans', () => {
    const channels = new Array(16).fill(null).map(() => ({}));
    channels[0] = { enable: true, midiIn: true };
    const unpacked = buildMixUnpacked('BoolTest', true, 0, channels);
    const mix = Mix.fromUnpacked(unpacked);
    expect(typeof mix.channels[0].enable).toBe('boolean');
    expect(typeof mix.channels[0].midiIn).toBe('boolean');
    expect(typeof mix.channels[0].midiOut).toBe('boolean');
    expect(typeof mix.effectMidiPC).toBe('boolean');
  });
});

// --- Device I/O functions ---

describe('readProgram / writeProgram', () => {
  test('readProgram sends request and returns Program', async () => {
    const input = new MockMIDIInput('Test');
    const output = new MockMIDIOutput('Test');

    const unpacked = buildProgramUnpacked('ReadTest', 0, [
      { enabled: true, sampleGroup: 1, sampleNumber: 5 },
      { enabled: false },
      { enabled: false },
      { enabled: false },
    ]);
    const reply = wrapInSysex(0x00, 3, unpacked);

    output.send = jest.fn(function (data) {
      const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (arr[0] === 0xF0 && arr[5] === 0x01) {
        setTimeout(() => input.receive(reply), 0);
      }
    });

    const prog = await readProgram(output, input, 3);
    expect(prog).toBeInstanceOf(Program);
    expect(prog.name).toBe('ReadTest');
    expect(prog.sounds[0].keyboard.sample.group).toBe(1);
  });

  test('writeProgram sends packed program data', () => {
    const output = new MockMIDIOutput('Test');

    const prog = new Program();
    prog.name = 'WriteTest';
    prog.romId = 0;
    prog.sounds = [
      { isDrum: false, enabled: true, keyboard: createDefaultKeyboard() },
      { isDrum: false, enabled: false, keyboard: createDefaultKeyboard() },
      { isDrum: false, enabled: false, keyboard: createDefaultKeyboard() },
      { isDrum: false, enabled: false, keyboard: createDefaultKeyboard() },
    ];

    writeProgram(output, 5, prog);

    expect(output.send).toHaveBeenCalled();
    const sentData = output.send.mock.calls[0][0];
    expect(sentData[0]).toBe(0xF0);
    expect(sentData[5]).toBe(0x00); // opcode for user program
    expect(sentData[6]).toBe(5); // program number
    expect(sentData[sentData.length - 1]).toBe(0xF7);
  });
});

describe('readMix / writeMix', () => {
  test('readMix sends request and returns Mix', async () => {
    const input = new MockMIDIInput('Test');
    const output = new MockMIDIOutput('Test');

    const channels = new Array(16).fill(null).map(() => ({}));
    channels[0] = { programNumber: 42, enable: true };
    const unpacked = buildMixUnpacked('ReadMix', false, 0, channels);
    const reply = wrapInSysex(0x0E, 10, unpacked);

    output.send = jest.fn(function (data) {
      const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (arr[0] === 0xF0 && arr[5] === 0x0F) {
        setTimeout(() => input.receive(reply), 0);
      }
    });

    const mix = await readMix(output, input, 10);
    expect(mix).toBeInstanceOf(Mix);
    expect(mix.name).toBe('ReadMix');
    expect(mix.channels[0].programNumber).toBe(42);
  });

  test('writeMix sends packed mix data', () => {
    const output = new MockMIDIOutput('Test');

    const mix = new Mix();
    mix.name = 'WriteMix';
    mix.effectMidiPC = true;
    mix.effectChannel = 3;
    mix.channels = Array.from({ length: 16 }, () => ({
      programNumber: 0, programType: 0, enable: false,
      volume: 0, pan: 0, output: 0, effectLevel: 0, effectBus: 0,
      pitchOctave: 0, pitchSemitone: 0, lowNote: 0, highNote: 0,
      midiIn: false, midiOut: false, midiGroup: false,
      wheels: false, aftertouch: false, sustainPedal: false,
      pedalsControllers: false,
    }));

    writeMix(output, 10, mix);

    expect(output.send).toHaveBeenCalled();
    const sentData = output.send.mock.calls[0][0];
    expect(sentData[0]).toBe(0xF0);
    expect(sentData[5]).toBe(0x0E); // opcode for new mix
    expect(sentData[6]).toBe(10); // mix number
    expect(sentData[sentData.length - 1]).toBe(0xF7);
  });
});

// Helper to create a default keyboard sound with all fields
function createDefaultKeyboard() {
  return {
    sample: { group: 0, number: 0 },
    level: { volume: 0, pan: 0, output: 0, effectLevel: 0, effectBus: 0 },
    pitch: { semitone: 0, detune: 0, detuneType: 0, pitchWheelMod: 0, aftertouchMod: 0, lfoMod: 0, envMod: 0, portamentoMode: 0, portamentoRate: 0, keyMode: 0 },
    filter: { frequency: 0, keyboardTrack: 0, velocityMod: 0, pitchWheelMod: 0, aftertouchMod: 0, lfoMod: 0, envMod: 0 },
    amp: { velocityCurve: 0, aftertouchMod: 0, lfoMod: 0 },
    noteRange: { lowNote: 0, highNote: 0, overlap: 0 },
    mods: Array.from({ length: 6 }, () => ({ source: 0, destination: 0, amplitude: 0, gate: 0 })),
    pitchLfo: { waveform: 0, speed: 0, delay: 0, trigger: 0, level: 0, modWheelMod: 0, aftertouchMod: 0 },
    filterLfo: { waveform: 0, speed: 0, delay: 0, trigger: 0, level: 0, modWheelMod: 0, aftertouchMod: 0 },
    ampLfo: { waveform: 0, speed: 0, delay: 0, trigger: 0, level: 0, modWheelMod: 0, aftertouchMod: 0 },
    pitchEnv: { attack: 0, decay: 0, sustain: 0, release: 0, delay: 0, sustainDecay: 0, triggerType: 0, timeTrack: 0, sustainPedal: 0, level: 0, velocityMod: 0 },
    filterEnv: { attack: 0, decay: 0, sustain: 0, release: 0, delay: 0, sustainDecay: 0, triggerType: 0, timeTrack: 0, sustainPedal: 0, level: 0, velocityMod: 0 },
    ampEnv: { attack: 0, decay: 0, sustain: 0, release: 0, delay: 0, sustainDecay: 0, triggerType: 0, timeTrack: 0, sustainPedal: 0, level: 0 },
    tracking: { input: 0, points: new Array(11).fill(0) },
  };
}
