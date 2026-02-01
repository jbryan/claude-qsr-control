import { PRESET_PROGRAMS, PRESET_MIXES, getPresetName } from '../public/js/presets.js';

describe('PRESET_PROGRAMS', () => {
  test('has 4 banks', () => {
    expect(PRESET_PROGRAMS).toHaveLength(4);
  });

  test('each bank has 128 programs', () => {
    for (let i = 0; i < 4; i++) {
      expect(PRESET_PROGRAMS[i]).toHaveLength(128);
    }
  });

  test('bank 1 first and last entries match docs', () => {
    expect(PRESET_PROGRAMS[0][0]).toBe('TrueStereo');
    expect(PRESET_PROGRAMS[0][127]).toBe('Orch Hits');
  });

  test('bank 2 first and last entries match docs', () => {
    expect(PRESET_PROGRAMS[1][0]).toBe('DarkClascl');
    expect(PRESET_PROGRAMS[1][127]).toBe('Danz Hitz');
  });

  test('bank 3 first and last entries match docs', () => {
    expect(PRESET_PROGRAMS[2][0]).toBe('64 Grand');
    expect(PRESET_PROGRAMS[2][127]).toBe('Film Hit');
  });

  test('bank 4 (GM) first and last entries match docs', () => {
    expect(PRESET_PROGRAMS[3][0]).toBe('AcGrandPno');
    expect(PRESET_PROGRAMS[3][127]).toBe('Gunshot');
  });

  test('spot-check mid-bank entries', () => {
    expect(PRESET_PROGRAMS[0][64]).toBe('Real Brass');
    expect(PRESET_PROGRAMS[1][50]).toBe('Mi Viola');
    expect(PRESET_PROGRAMS[2][100]).toBe('Fast Sync');
    expect(PRESET_PROGRAMS[3][73]).toBe('Flute');
  });
});

describe('PRESET_MIXES', () => {
  test('has 4 banks', () => {
    expect(PRESET_MIXES).toHaveLength(4);
  });

  test('each bank has 100 mixes', () => {
    for (let i = 0; i < 4; i++) {
      expect(PRESET_MIXES[i]).toHaveLength(100);
    }
  });

  test('bank 1 first and last entries match docs', () => {
    expect(PRESET_MIXES[0][0]).toBe('Zen Piano');
    expect(PRESET_MIXES[0][99]).toBe('Bezt Hitz');
  });

  test('bank 2 first and last entries match docs', () => {
    expect(PRESET_MIXES[1][0]).toBe('A/V Piano');
    expect(PRESET_MIXES[1][99]).toBe('Mobile Hit');
  });

  test('bank 3 first and last entries match docs', () => {
    expect(PRESET_MIXES[2][0]).toBe('Octo Rock');
    expect(PRESET_MIXES[2][99]).toBe('Huge Hit');
  });

  test('bank 4 first and last entries match docs', () => {
    expect(PRESET_MIXES[3][0]).toBe('GM Multi');
    expect(PRESET_MIXES[3][99]).toBe('MassDriver');
  });

  test('spot-check mid-bank entries', () => {
    expect(PRESET_MIXES[0][50]).toBe('Pno&Violin');
    expect(PRESET_MIXES[1][25]).toBe('Cathedral');
    expect(PRESET_MIXES[2][69]).toBe('mf Orch');
    expect(PRESET_MIXES[3][93]).toBe('Gom Jabbar');
  });
});

describe('getPresetName', () => {
  test('returns empty string for User bank (0)', () => {
    expect(getPresetName('prog', 0, 0)).toBe('');
    expect(getPresetName('mix', 0, 50)).toBe('');
  });

  test('returns program name for banks 1-4', () => {
    expect(getPresetName('prog', 1, 0)).toBe('TrueStereo');
    expect(getPresetName('prog', 2, 0)).toBe('DarkClascl');
    expect(getPresetName('prog', 3, 0)).toBe('64 Grand');
    expect(getPresetName('prog', 4, 0)).toBe('AcGrandPno');
  });

  test('returns mix name for banks 1-4', () => {
    expect(getPresetName('mix', 1, 0)).toBe('Zen Piano');
    expect(getPresetName('mix', 2, 0)).toBe('A/V Piano');
    expect(getPresetName('mix', 3, 0)).toBe('Octo Rock');
    expect(getPresetName('mix', 4, 0)).toBe('GM Multi');
  });

  test('returns empty string for out-of-range bank', () => {
    expect(getPresetName('prog', 5, 0)).toBe('');
    expect(getPresetName('prog', -1, 0)).toBe('');
  });

  test('returns empty string for out-of-range patch', () => {
    expect(getPresetName('prog', 1, 128)).toBe('');
    expect(getPresetName('prog', 1, -1)).toBe('');
    expect(getPresetName('mix', 1, 100)).toBe('');
  });
});
