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

All opcodes (all implemented in `midi.js`):

| Opcode | Name | Direction | Function in midi.js |
|--------|------|-----------|---------------------|
| `0x00` | User Program Dump | send/receive | `sendUserProgram()` / `requestUserProgram()` |
| `0x01` | User Program Dump Request | send | (used internally by `requestUserProgram`) |
| `0x02` | Edit Program Dump | send/receive | `sendEditProgram()` / `requestEditProgram()` |
| `0x03` | Edit Program Dump Request | send | (used internally by `requestEditProgram`) |
| `0x04` | Old Mix Dump (legacy) | send/receive | `sendOldMix()` / `requestOldMix()` |
| `0x05` | Old Mix Dump Request | send | (used internally by `requestOldMix`) |
| `0x06` | User Effects Dump | send/receive | `sendUserEffects()` / `requestUserEffects()` |
| `0x07` | User Effects Dump Request | send | (used internally by `requestUserEffects`) |
| `0x08` | Edit Effects Dump | send/receive | `sendEditEffects()` / `requestEditEffects()` |
| `0x09` | Edit Effects Dump Request | send | (used internally by `requestEditEffects`) |
| `0x0A` | Global Data Dump | send/receive | `sendGlobalData()` / `requestGlobalData()` |
| `0x0B` | Global Data Dump Request | send | (used internally by `requestGlobalData`) |
| `0x0C` | All Dump Request | send | `requestAllDump()` — caller handles responses |
| `0x0D` | Mode Select | send | `sendModeSelect()` |
| `0x0E` | New Mix Dump (v2.00+) | send/receive | `sendNewMix()` / `requestNewMix()` |
| `0x0F` | New Mix Dump Request | send | (used internally by `requestNewMix`) |
| `0x10` | Direct Parameter Edit | send | `sendGlobalParam()` / `sendParamEdit()` |
| `0x11` | FLASH Sector Erase | send | `flashSectorErase()` |
| `0x12` | FLASH Sector Write | send/receive | `flashSectorWrite()` / `requestFlashSectorRead()` response |
| `0x13` | FLASH Sector Read Request | send | `requestFlashSectorRead()` |
| `0x14` | FLASH ACK | receive | handled internally by flash functions |
| `0x15` | FLASH NACK | receive | handled internally by flash functions |

Patch names are only readable from User bank (bank 0) via SysEx dump requests.
Name bit offsets: programs at bit 8, mixes at bit 5 in unpacked data.

## Data Encoding

The QSR uses 7-bit MIDI packing: every 8 MIDI bytes encode 7 data bytes. Use `packQSData()` and `unpackQSData()` (both exported from midi.js) for conversion. Patch names are 10 characters, each a 7-bit value (0-95) mapped to ASCII 32-127, extracted at a bit offset that differs between programs (bit 8) and mixes (bit 5).

`sendParamEdit()` is the full-featured parameter edit function supporting all four edit modes (Global/Mix/Program/Effects) with sound, channel, and pot selection. `sendGlobalParam()` is a convenience wrapper for Global mode edits only.

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
