import { jest } from '@jest/globals';
import { webcrypto } from 'crypto';
import 'fake-indexeddb/auto';

// Polyfill structuredClone for jsdom (used by fake-indexeddb)
if (typeof globalThis.structuredClone === 'undefined') {
  globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));
}

// Polyfill SubtleCrypto for jsdom
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto;
} else if (!globalThis.crypto.subtle) {
  globalThis.crypto.subtle = webcrypto.subtle;
}

// Mock Web MIDI API

export class MockMIDIOutput {
  constructor(name = 'Test Output') {
    this.name = name;
    this.send = jest.fn();
  }
}

export class MockMIDIInput {
  constructor(name = 'Test Input') {
    this.name = name;
    this._listeners = {};
  }

  addEventListener(type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  }

  removeEventListener(type, fn) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter(f => f !== fn);
  }

  // Test helper: simulate receiving a MIDI message
  receive(data) {
    const event = { data: data instanceof Uint8Array ? data : new Uint8Array(data) };
    for (const fn of (this._listeners['midimessage'] || [])) {
      fn(event);
    }
  }
}

export class MockMIDIAccess {
  constructor() {
    this.inputs = new Map();
    this.outputs = new Map();
    this._listeners = {};
  }

  addEventListener(type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  }

  removeEventListener(type, fn) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter(f => f !== fn);
  }

  addDevice(name = 'Test Device') {
    const input = new MockMIDIInput(name);
    const output = new MockMIDIOutput(name);
    const id = `id-${this.inputs.size}`;
    this.inputs.set(id, input);
    this.outputs.set(id, output);
    return { input, output, id, name };
  }
}

// Install navigator.requestMIDIAccess mock
let mockMIDIAccess = null;

export function setMockMIDIAccess(access) {
  mockMIDIAccess = access;
}

Object.defineProperty(navigator, 'requestMIDIAccess', {
  value: jest.fn(async () => {
    if (!mockMIDIAccess) {
      mockMIDIAccess = new MockMIDIAccess();
    }
    return mockMIDIAccess;
  }),
  writable: true,
  configurable: true,
});
