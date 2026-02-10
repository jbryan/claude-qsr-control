import { putProgram, getProgram, putMix, getMix, getAllNames, hasData, clearAll, getAllPatchEntries, getProgramByHash, getMixByHash, openDB } from '../public/js/store.js';
import { Program, Mix, Effect, encodeProgName, encodeMixName, setBits } from '../public/js/models.js';

function makeProgram(name) {
  const unpacked = new Array(350).fill(0);
  encodeProgName(unpacked, name);
  // Enable sound 0 as keyboard
  const baseBitOff = 10 * 8;
  setBits(unpacked, baseBitOff, 1, 0);
  setBits(unpacked, baseBitOff + 84 * 8 + 3, 1, 1);
  const prog = Program.fromUnpacked(unpacked);
  prog.effect = Effect.fromUnpacked(new Array(65).fill(0));
  return prog;
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
    await putProgram(0, 5, prog);
    const result = await getProgram(0, 5);
    expect(result).toBeInstanceOf(Program);
    expect(result.name).toBe('TestProg');
  });

  test('putMix / getMix round-trip', async () => {
    const mix = makeMix('TestMix');
    await putMix(0, 3, mix);
    const result = await getMix(0, 3);
    expect(result).toBeInstanceOf(Mix);
    expect(result.name).toBe('TestMix');
  });

  test('getProgram returns null for missing entry', async () => {
    const result = await getProgram(0, 99);
    expect(result).toBeNull();
  });

  test('getMix returns null for missing entry', async () => {
    const result = await getMix(0, 99);
    expect(result).toBeNull();
  });

  test('getAllNames returns correct names', async () => {
    await putProgram(0, 0, makeProgram('Prog0'));
    await putProgram(0, 5, makeProgram('Prog5'));
    await putMix(0, 2, makeMix('Mix2'));

    const names = await getAllNames();
    expect(names.programs).toEqual(
      expect.arrayContaining([
        { bank: 0, number: 0, name: 'Prog0' },
        { bank: 0, number: 5, name: 'Prog5' },
      ])
    );
    expect(names.mixes).toEqual([{ bank: 0, number: 2, name: 'Mix2' }]);
  });

  test('hasData returns false when empty', async () => {
    expect(await hasData()).toBe(false);
  });

  test('hasData returns true after storing', async () => {
    await putProgram(0, 0, makeProgram('P'));
    expect(await hasData()).toBe(true);
  });

  test('clearAll removes all data', async () => {
    await putProgram(0, 0, makeProgram('P'));
    await putMix(0, 0, makeMix('M'));
    await clearAll();
    expect(await hasData()).toBe(false);
    expect(await getProgram(0, 0)).toBeNull();
    expect(await getMix(0, 0)).toBeNull();
  });

  test('overwriting updates correctly', async () => {
    await putProgram(0, 0, makeProgram('Original'));
    await putProgram(0, 0, makeProgram('Updated'));
    const result = await getProgram(0, 0);
    expect(result.name).toBe('Updated');
  });

  test('hash round-trip for program', async () => {
    const prog = makeProgram('HashProg');
    await putProgram(0, 0, prog);
    const result = await getProgram(0, 0);
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.hash).toBe(prog.hash);
  });

  test('hash round-trip for mix', async () => {
    const mix = makeMix('HashMix');
    await putMix(0, 0, mix);
    const result = await getMix(0, 0);
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.hash).toBe(mix.hash);
  });

  test('same content at two slots produces same hash', async () => {
    const prog1 = makeProgram('DupProg');
    const prog2 = makeProgram('DupProg');
    await putProgram(0, 0, prog1);
    await putProgram(0, 1, prog2);
    const r0 = await getProgram(0, 0);
    const r1 = await getProgram(0, 1);
    expect(r0.hash).toBe(r1.hash);
  });

  test('getProgram returns effect when stored', async () => {
    const prog = makeProgram('FxProg');
    const effectUnpacked = new Array(65).fill(0);
    setBits(effectUnpacked, 70, 4, 2); // config 2
    prog.effect = Effect.fromUnpacked(effectUnpacked);
    await putProgram(0, 0, prog);
    const result = await getProgram(0, 0);
    expect(result.effect).toBeInstanceOf(Effect);
    expect(result.effect.configuration).toBe(2);
  });

  test('getAllNames returns only bank, number, and name', async () => {
    await putProgram(0, 0, makeProgram('P'));
    await putMix(0, 0, makeMix('M'));
    const names = await getAllNames();
    expect(Object.keys(names.programs[0]).sort()).toEqual(['bank', 'name', 'number']);
    expect(Object.keys(names.mixes[0]).sort()).toEqual(['bank', 'name', 'number']);
  });

  test('stores and retrieves programs from different banks', async () => {
    await putProgram(0, 5, makeProgram('UserProg'));
    await putProgram(1, 5, makeProgram('PresetProg'));
    expect((await getProgram(0, 5)).name).toBe('UserProg');
    expect((await getProgram(1, 5)).name).toBe('PresetProg');
  });

  test('stores and retrieves mixes from different banks', async () => {
    await putMix(0, 3, makeMix('UserMix'));
    await putMix(1, 3, makeMix('PresetMix'));
    expect((await getMix(0, 3)).name).toBe('UserMix');
    expect((await getMix(1, 3)).name).toBe('PresetMix');
  });

  test('getAllNames includes entries from multiple banks', async () => {
    await putProgram(0, 0, makeProgram('UserP'));
    await putProgram(1, 0, makeProgram('Preset1P'));
    await putMix(0, 0, makeMix('UserM'));
    await putMix(2, 0, makeMix('Preset2M'));

    const names = await getAllNames();
    expect(names.programs).toEqual(
      expect.arrayContaining([
        { bank: 0, number: 0, name: 'UserP' },
        { bank: 1, number: 0, name: 'Preset1P' },
      ])
    );
    expect(names.mixes).toEqual(
      expect.arrayContaining([
        { bank: 0, number: 0, name: 'UserM' },
        { bank: 2, number: 0, name: 'Preset2M' },
      ])
    );
  });

  test('getAllPatchEntries returns assigned patches with assignments', async () => {
    await putProgram(0, 5, makeProgram('Assigned'));
    await putMix(0, 3, makeMix('AssignMix'));
    const entries = await getAllPatchEntries();
    const prog = entries.programs.find(p => p.name === 'Assigned');
    expect(prog).toBeTruthy();
    expect(prog.assignments).toEqual([{ bank: 0, number: 5 }]);
    const mix = entries.mixes.find(m => m.name === 'AssignMix');
    expect(mix).toBeTruthy();
    expect(mix.assignments).toEqual([{ bank: 0, number: 3 }]);
  });

  test('getAllPatchEntries returns unassigned patches with empty assignments', async () => {
    // Write directly to program-data without a programs index entry
    const prog = makeProgram('Orphan');
    await prog.computeHash();
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('program-data', 'readwrite');
      tx.objectStore('program-data').put({
        hash: prog.hash,
        programUnpacked: prog.toUnpacked(),
        effectUnpacked: prog.effect ? prog.effect.toUnpacked() : null,
      });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
    const entries = await getAllPatchEntries();
    const found = entries.programs.find(p => p.hash === prog.hash);
    expect(found).toBeTruthy();
    expect(found.name).toBe('Orphan');
    expect(found.assignments).toEqual([]);
  });

  test('getProgramByHash round-trip', async () => {
    const prog = makeProgram('ByHash');
    await putProgram(0, 0, prog);
    const result = await getProgramByHash(prog.hash);
    expect(result).toBeInstanceOf(Program);
    expect(result.name).toBe('ByHash');
    expect(result.hash).toBe(prog.hash);
  });

  test('getProgramByHash returns effect when stored', async () => {
    const prog = makeProgram('FxHash');
    const effectUnpacked = new Array(65).fill(0);
    setBits(effectUnpacked, 70, 4, 2);
    prog.effect = Effect.fromUnpacked(effectUnpacked);
    await putProgram(0, 0, prog);
    const result = await getProgramByHash(prog.hash);
    expect(result.effect).toBeInstanceOf(Effect);
    expect(result.effect.configuration).toBe(2);
  });

  test('getProgramByHash returns null for missing hash', async () => {
    const result = await getProgramByHash('nonexistent');
    expect(result).toBeNull();
  });

  test('getMixByHash round-trip', async () => {
    const mix = makeMix('MixHash');
    await putMix(0, 0, mix);
    const result = await getMixByHash(mix.hash);
    expect(result).toBeInstanceOf(Mix);
    expect(result.name).toBe('MixHash');
    expect(result.hash).toBe(mix.hash);
  });

  test('getMixByHash returns null for missing hash', async () => {
    const result = await getMixByHash('nonexistent');
    expect(result).toBeNull();
  });
});
