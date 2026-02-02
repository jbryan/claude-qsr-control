# QSR Control

[![Made with AI](https://img.shields.io/badge/Made%20with-AI-lightgrey?style=for-the-badge)](https://github.com/mefengl/made-by-ai)

**[Try it live](https://jbryan.github.io/claude-qsr-control/)**

A progressive web app for controlling Alesis QS series synthesizers (QSR, QS6, QS7, QS8) over Web MIDI.

## AI Developed 

I have been a software developer, computer scientist, and engineering manager in
various capacities over the last 25-odd years. I have taken pride in my ability
to code, analyze software, manage the software development lifecycle, and
architect solutions to real problems. With the rise of LLMs and agentic coding
tools, I recognize that some of those things that I prided myself on being able
to do well are likely skills that can be replaced by a machine. I am certainly
not bullish enough on AI (or enough of a doomer) to think that all of software
engineering can be replaced, but I also am not naive enough to think that we
won't need to learn to use and work with agentic tools as software engineers.

To that end, I have started a series of projects to help me learn the capabilities and
limitations of agentic coding tools. My goal is to develop a good intuition for
what kinds of problems they can solve, how best to use them to solve those
problems, and what the likely pitfalls are when using them for development. I would
like to be as transparent as possible that these projects are wholly or mostly
developed using AI. So, within my GitHub account, I'll name those repos
prefixed by the name of the agent primarily responsible (e.g., `claude-mr-taps`
was largely coded by Claude Code). Additionally, I will badge them with the
"Made by AI" badge you see at the top of this README as well as a section like
this that describes why they are AI-developed.

While I do read the code generated and don't believe there to be any critical
bugs or security vulnerabilities, do treat these as experiments and only use
them for non-critical, low-risk tasks.

## Features

- **Program & Mix selection** — Browse and select programs and mixes across User, Preset, and General MIDI banks
- **Search** — Type-ahead search across all preset names with mode/bank filtering
- **Global settings** — View and edit global parameters (transpose, tuning, controllers, MIDI settings)
- **Program info** — Inspect full SysEx program parameters including per-sound details (keyboard and drum modes), LFOs, envelopes, mod routings, and tracking generators
- **Mix info** — Inspect mix parameters with per-channel program, level, pitch, note range, and MIDI control settings
- **SysEx file viewer** — Open `.syx` dump files and browse program names, mix names, effects, and global settings
- **State persistence** — Remembers your last mode, bank, and patch selection across sessions
- **PWA** — Installable as a standalone app with offline support

## Requirements

- A browser with [Web MIDI API](https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API) support (Chrome, Edge, Opera)
- An Alesis QS series synthesizer connected via USB-MIDI or a MIDI interface

## Getting Started

Install dependencies:

```sh
npm install
```

Start the development server:

```sh
npm start
```

Then open the URL shown in your browser (typically `http://localhost:3000`).

## Running Tests

```sh
npm test
```

## Usage

1. Connect your Alesis QS synthesizer via MIDI
2. Open the app — it will auto-scan and connect to the first QS device found
3. Use the **PROG** / **MIX** buttons to switch modes
4. Select a bank from the dropdown and navigate patches with the arrow buttons
5. Click **Search** to find patches by name
6. Click the gear icon to view/edit global settings
7. Click the **i** button on the LCD to inspect the current program or mix
8. Click the folder icon to open and browse a `.syx` dump file

## License

[ISC](LICENSE.md)
