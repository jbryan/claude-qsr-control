# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- SysEx file viewer — open `.syx` dump files and browse programs, mixes, effects, and global settings in a tabbed dialog

## [1.0.0] - 2025

### Added
- Program info dialog with full SysEx parameter display (keyboard sounds, drum sounds, LFOs, envelopes, mod routings, tracking generators)
- Mix info dialog with per-channel program, level, pitch, note range, and MIDI control parameters
- Global settings dialog with editable parameters (transpose, tuning, controllers, MIDI program select, General MIDI)
- Search dialog with type-ahead filtering and browsable preset list across all banks
- Static preset name lookup for Preset 1-3 and General MIDI banks
- Disable General MIDI on connect to fix CC#0 bank select behavior
- Program and Mix mode switching with correct MIDI Program Select configuration
- Bank selection with MSB/LSB bank select messages
- Patch navigation with wrapping
- Auto-scan for QS devices on startup and MIDI device state changes
- Manual device identification via Advanced panel
- State persistence in localStorage (mode, bank, patch)
- PWA support with service worker, manifest, and installable app icons
- MIDI console logging for all SysEx and channel messages
- Full QSR SysEx opcode implementation including FLASH card operations
- Comprehensive test suite
