import { putProgram, getProgram, putMix, getMix, getAllNames, hasData, clearAll } from '../public/js/store.js';
import { Program, Mix, encodeProgName, encodeMixName, setBits } from '../public/js/models.js';

function makeProgram(name) {
  const unpacked = new Array(350).fill(0);
  encodeProgName(unpacked, name);
  // Enable sound 0 as keyboard
  const baseBitOff = 10 * 8;
  setBits(unpacked, baseBitOff, 1, 0);
  setBits(unpacked, baseBitOff + 84 * 8 + 3, 1, 1);
  return Program.fromUnpacked(unpacked);
}

function makeMix(name) {
  const unpacked = new Array(138).fill(0);
  encodeMixName(unpacked, name);
  setBits(unpacked, 0, 1, 0);
  setBits(unpacked, 1, 4, 0);
  // Enable channel 0
  const baseBit = 10 * 8;
  setBits(unpacked, baseBit + 11, 1, 1);
  return Mix.fromUnpacked(unpacked);
}

beforeEach(async () => {
  await clearAll();
});

describe('store', () => {
  test('putProgram / getProgram round-trip', async () => {
    const prog = makeProgram('TestProg');
    await putProgram(5, prog);
    const result = await getProgram(5);
    expect(result).toBeInstanceOf(Program);
    expect(result.name).toBe('TestProg');
  });

  test('putMix / getMix round-trip', async () => {
    const mix = makeMix('TestMix');
    await putMix(3, mix);
    const result = await getMix(3);
    expect(result).toBeInstanceOf(Mix);
    expect(result.name).toBe('TestMix');
  });

  test('getProgram returns null for missing entry', async () => {
    const result = await getProgram(99);
    expect(result).toBeNull();
  });

  test('getMix returns null for missing entry', async () => {
    const result = await getMix(99);
    expect(result).toBeNull();
  });

  test('getAllNames returns correct names', async () => {
    await putProgram(0, makeProgram('Prog0'));
    await putProgram(5, makeProgram('Prog5'));
    await putMix(2, makeMix('Mix2'));

    const names = await getAllNames();
    expect(names.programs).toEqual(
      expect.arrayContaining([
        { number: 0, name: 'Prog0' },
        { number: 5, name: 'Prog5' },
      ])
    );
    expect(names.mixes).toEqual([{ number: 2, name: 'Mix2' }]);
  });

  test('hasData returns false when empty', async () => {
    expect(await hasData()).toBe(false);
  });

  test('hasData returns true after storing', async () => {
    await putProgram(0, makeProgram('P'));
    expect(await hasData()).toBe(true);
  });

  test('clearAll removes all data', async () => {
    await putProgram(0, makeProgram('P'));
    await putMix(0, makeMix('M'));
    await clearAll();
    expect(await hasData()).toBe(false);
    expect(await getProgram(0)).toBeNull();
    expect(await getMix(0)).toBeNull();
  });

  test('overwriting updates correctly', async () => {
    await putProgram(0, makeProgram('Original'));
    await putProgram(0, makeProgram('Updated'));
    const result = await getProgram(0);
    expect(result.name).toBe('Updated');
  });
});
