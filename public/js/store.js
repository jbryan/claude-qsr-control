import { Program, Mix, Effect, extractProgName, extractMixName } from './models.js';

const DB_NAME = 'qsr-user-banks';
const DB_VERSION = 3;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Delete all existing stores (data is a hardware cache, safe to lose)
      for (const name of db.objectStoreNames) {
        db.deleteObjectStore(name);
      }
      db.createObjectStore('programs', { keyPath: 'id' });
      db.createObjectStore('mixes', { keyPath: 'id' });
      db.createObjectStore('program-data', { keyPath: 'hash' });
      db.createObjectStore('mix-data', { keyPath: 'hash' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putProgram(bank, programNum, program) {
  if (!program.hash) await program.computeHash();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['programs', 'program-data'], 'readwrite');
    tx.objectStore('programs').put({
      id: `${bank}:${programNum}`,
      bank,
      number: programNum,
      name: program.name,
      hash: program.hash,
    });
    tx.objectStore('program-data').put({
      hash: program.hash,
      programUnpacked: program.toUnpacked(),
      effectUnpacked: program.effect ? program.effect.toUnpacked() : null,
    });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function getProgram(bank, programNum) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['programs', 'program-data'], 'readonly');
    const indexReq = tx.objectStore('programs').get(`${bank}:${programNum}`);
    indexReq.onsuccess = () => {
      if (!indexReq.result) { db.close(); return resolve(null); }
      const { hash } = indexReq.result;
      const dataReq = tx.objectStore('program-data').get(hash);
      dataReq.onsuccess = () => {
        db.close();
        if (!dataReq.result) return resolve(null);
        const prog = Program.fromUnpacked(dataReq.result.programUnpacked);
        prog.hash = hash;
        if (dataReq.result.effectUnpacked) {
          prog.effect = Effect.fromUnpacked(dataReq.result.effectUnpacked);
        }
        resolve(prog);
      };
      dataReq.onerror = () => { db.close(); reject(dataReq.error); };
    };
    indexReq.onerror = () => { db.close(); reject(indexReq.error); };
  });
}

export async function putMix(bank, mixNum, mix) {
  if (!mix.hash) await mix.computeHash();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['mixes', 'mix-data'], 'readwrite');
    tx.objectStore('mixes').put({
      id: `${bank}:${mixNum}`,
      bank,
      number: mixNum,
      name: mix.name,
      hash: mix.hash,
    });
    tx.objectStore('mix-data').put({
      hash: mix.hash,
      mixUnpacked: mix.toUnpacked(),
    });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function getMix(bank, mixNum) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['mixes', 'mix-data'], 'readonly');
    const indexReq = tx.objectStore('mixes').get(`${bank}:${mixNum}`);
    indexReq.onsuccess = () => {
      if (!indexReq.result) { db.close(); return resolve(null); }
      const { hash } = indexReq.result;
      const dataReq = tx.objectStore('mix-data').get(hash);
      dataReq.onsuccess = () => {
        db.close();
        if (!dataReq.result) return resolve(null);
        const mix = Mix.fromUnpacked(dataReq.result.mixUnpacked);
        mix.hash = hash;
        resolve(mix);
      };
      dataReq.onerror = () => { db.close(); reject(dataReq.error); };
    };
    indexReq.onerror = () => { db.close(); reject(indexReq.error); };
  });
}

export async function getAllNames() {
  const db = await openDB();
  const programs = await new Promise((resolve, reject) => {
    const tx = db.transaction('programs', 'readonly');
    const req = tx.objectStore('programs').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const mixes = await new Promise((resolve, reject) => {
    const tx = db.transaction('mixes', 'readonly');
    const req = tx.objectStore('mixes').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return {
    programs: programs.map(r => ({ bank: r.bank, number: r.number, name: r.name })),
    mixes: mixes.map(r => ({ bank: r.bank, number: r.number, name: r.name })),
  };
}

export async function hasData() {
  const db = await openDB();
  const count = await new Promise((resolve, reject) => {
    const tx = db.transaction('programs', 'readonly');
    const req = tx.objectStore('programs').count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return count > 0;
}

function storeGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllPatchEntries() {
  const db = await openDB();
  const tx = db.transaction(['programs', 'mixes', 'program-data', 'mix-data'], 'readonly');
  const [programs, mixes, programData, mixData] = await Promise.all([
    storeGetAll(tx.objectStore('programs')),
    storeGetAll(tx.objectStore('mixes')),
    storeGetAll(tx.objectStore('program-data')),
    storeGetAll(tx.objectStore('mix-data')),
  ]);
  db.close();

  const progMap = new Map();
  for (const p of programs) {
    if (!progMap.has(p.hash)) progMap.set(p.hash, []);
    progMap.get(p.hash).push({ bank: p.bank, number: p.number });
  }
  const mixMap = new Map();
  for (const m of mixes) {
    if (!mixMap.has(m.hash)) mixMap.set(m.hash, []);
    mixMap.get(m.hash).push({ bank: m.bank, number: m.number });
  }

  return {
    programs: programData.map(pd => ({
      hash: pd.hash,
      name: progMap.get(pd.hash)?.[0]
        ? programs.find(p => p.hash === pd.hash).name
        : extractProgName(pd.programUnpacked),
      assignments: progMap.get(pd.hash) || [],
    })),
    mixes: mixData.map(md => ({
      hash: md.hash,
      name: mixMap.get(md.hash)?.[0]
        ? mixes.find(m => m.hash === md.hash).name
        : extractMixName(md.mixUnpacked),
      assignments: mixMap.get(md.hash) || [],
    })),
  };
}

export async function getProgramByHash(hash) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('program-data', 'readonly');
    const req = tx.objectStore('program-data').get(hash);
    req.onsuccess = () => {
      db.close();
      if (!req.result) return resolve(null);
      const prog = Program.fromUnpacked(req.result.programUnpacked);
      prog.hash = hash;
      if (req.result.effectUnpacked) {
        prog.effect = Effect.fromUnpacked(req.result.effectUnpacked);
      }
      resolve(prog);
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

export async function getMixByHash(hash) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('mix-data', 'readonly');
    const req = tx.objectStore('mix-data').get(hash);
    req.onsuccess = () => {
      db.close();
      if (!req.result) return resolve(null);
      const mix = Mix.fromUnpacked(req.result.mixUnpacked);
      mix.hash = hash;
      resolve(mix);
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

export async function clearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['programs', 'mixes', 'program-data', 'mix-data'], 'readwrite');
    tx.objectStore('programs').clear();
    tx.objectStore('mixes').clear();
    tx.objectStore('program-data').clear();
    tx.objectStore('mix-data').clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
