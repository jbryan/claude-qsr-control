# QSR Control

Web-based MIDI controller PWA for Alesis QS series synthesizers (QS6, QS7, QS8, QSR). Vanilla JS, no build step. Served as static files from `public/` via `npx serve public`.

## Architecture

- `public/js/midi.js` — MIDI protocol layer. All sends and receives. No UI concerns.
- `public/js/midi-log.js` — Console logging for all MIDI traffic (plain English + hex).
- `public/js/app.js` — UI state and event handling. Imports from midi.js.
- `public/index.html` — Single-page UI.
- `public/css/styles.css` — Styling.
- `qsr_docs/` — Alesis QSR reference documentation. Consult these before making MIDI protocol changes.

## Critical: QSR MIDI Program Select Behavior

The QSR's global "MIDI Program Select" parameter controls how the synth interprets incoming Program Change messages. **This must be set correctly for the current mode or the QSR will misbehave.**

Values (set via `sendMidiProgramSelect(output, value)`):

| Value | Name | Effect |
|-------|------|--------|
| 0 | Off | Ignores all incoming Program Change messages |
| 1 | On | **Program mode**: PC selects programs. **Mix mode**: PC changes individual channel programs *within* the current mix (does NOT change which mix is active) |
| 2-17 | Channel 1-16 | PC on that channel selects **Mixes**. On other channels, changes channel programs within the mix |

**The app must toggle this when switching modes:**
- Entering Program mode: set to `1` (On)
- Entering Mix mode: set to `2` (Channel 1) so that PC on channel 1 selects mixes

Setting it to "Channel N" while in Program mode causes the QSR to interpret program changes as mix selections, switching it out of Program mode. This was a previous bug.

## QSR SysEx Reference

Manufacturer ID: `00 00 0E` (Alesis). Device ID byte: `0E` (QS family).

All QS SysEx messages: `F0 00 00 0E 0E <opcode> <data...> F7`

Key opcodes:
- `0x00` — Program Dump (response). Name at bit offset 8 in unpacked data.
- `0x01` — Program Dump Request. `F0 00 00 0E 0E 01 <num> F7`
- `0x0D` — Mode Select. `F0 00 00 0E 0E 0D <0=prog|1=mix> F7`
- `0x0E` — Mix Dump (response). Name at bit offset 5 in unpacked data.
- `0x0F` — Mix Dump Request. `F0 00 00 0E 0E 0F <num> F7`
- `0x10` — Direct Parameter Edit. Byte layout: `<0mmfffff> <0ssppppp> <0ccccddv> <0vvvvvvv>`

Patch names are only readable from User bank (bank 0) via SysEx dump requests.

## Data Encoding

The QSR uses 7-bit MIDI packing: every 8 MIDI bytes encode 7 data bytes. Patch names are 10 characters, each a 7-bit value (0-95) mapped to ASCII 32-127, extracted at a bit offset that differs between programs (bit 8) and mixes (bit 5).

## Banks and Ranges

- Banks: 0=User, 1=Preset 1, 2=Preset 2, 3=Preset 3, 4=GenMIDI
- Programs: 0-127 per bank
- Mixes: 0-99 (User bank only has 100 mixes)
- Bank Select uses CC#0 (Bank Select MSB)
- MIDI channel is 0-indexed in code (`MIDI_CHANNEL = 0` = MIDI channel 1)

## Logging

All MIDI sends and receives are logged to the browser console via `midi-log.js`. TX messages are green, RX messages are blue. Each log line shows a plain English description and the hex bytes on the wire. Check the console when debugging any MIDI issue.

## Device Identity

Universal Device Inquiry (`F0 7E 7F 06 01 F7`) is used to auto-detect QS devices. Identity replies contain manufacturer ID, family/member codes, and firmware version. Member codes: `0x03`=QS6, `0x04`=QS8, `0x05`=QS7, `0x06`=QSR.

## Common Pitfalls

- Always consult `qsr_docs/` before assuming how a MIDI message will behave on the QSR. The QSR has mode-dependent behavior that is not obvious from general MIDI knowledge.
- The order of MIDI messages matters. Set MIDI Program Select *before* sending the Mode Select, so the QSR is configured before the mode transition.
- SysEx dump requests only work for User bank. Non-User banks return nothing; the code returns empty string for bank != 0.
