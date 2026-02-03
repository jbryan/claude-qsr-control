import { Program, Mix } from './models.js';

const DB_NAME = 'qsr-user-banks';
const DB_VERSION = 1;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('programs')) {
        db.createObjectStore('programs', { keyPath: 'number' });
      }
      if (!db.objectStoreNames.contains('mixes')) {
        db.createObjectStore('mixes', { keyPath: 'number' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putProgram(programNum, program) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('programs', 'readwrite');
    tx.objectStore('programs').put({
      number: programNum,
      name: program.name,
      romId: program.romId,
      sounds: program.sounds,
      unpacked: program.toUnpacked(),
    });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function getProgram(programNum) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('programs', 'readonly');
    const req = tx.objectStore('programs').get(programNum);
    req.onsuccess = () => {
      db.close();
      if (!req.result) return resolve(null);
      const prog = new Program();
      prog.name = req.result.name;
      prog.romId = req.result.romId;
      prog.sounds = req.result.sounds;
      resolve(prog);
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

export async function putMix(mixNum, mix) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('mixes', 'readwrite');
    tx.objectStore('mixes').put({
      number: mixNum,
      name: mix.name,
      effectMidiPC: mix.effectMidiPC,
      effectChannel: mix.effectChannel,
      channels: mix.channels,
      unpacked: mix.toUnpacked(),
    });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function getMix(mixNum) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('mixes', 'readonly');
    const req = tx.objectStore('mixes').get(mixNum);
    req.onsuccess = () => {
      db.close();
      if (!req.result) return resolve(null);
      const mix = new Mix();
      mix.name = req.result.name;
      mix.effectMidiPC = req.result.effectMidiPC;
      mix.effectChannel = req.result.effectChannel;
      mix.channels = req.result.channels;
      resolve(mix);
    };
    req.onerror = () => { db.close(); reject(req.error); };
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
    programs: programs.map(r => ({ number: r.number, name: r.name })),
    mixes: mixes.map(r => ({ number: r.number, name: r.name })),
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

export async function clearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['programs', 'mixes'], 'readwrite');
    tx.objectStore('programs').clear();
    tx.objectStore('mixes').clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
