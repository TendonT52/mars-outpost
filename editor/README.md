# The custom Scratch extensions

The Mars outpost game uses three extensions that the standard Scratch editor does not have.
This folder has their source code, their icons and their unit tests.
It also has one patch that adds them to a Scratch editor.

| Extension | Id | What it does |
| --- | --- | --- |
| Mastra API | `mastra` | The Scratch side of the ship computer. It sends the game state and the words of the player to the game server, and gives the reply and the voice of the computer to the project. |
| Speech to Text | `speech2text` | Records the microphone, sends the speech to the game server, and gives the words as text. |
| Text | `stageText` | Lets a sprite show text in place of its costume. The game uses it for all its words on the screen. |

The extensions are built-in extensions of scratch-vm.
They are not "custom URL" extensions that you can load into scratch.mit.edu.
You must add them to a Scratch editor, and build that editor.

## The files

The paths are the same as in the [scratch-editor](https://github.com/scratchfoundation/scratch-editor) monorepo.

| Path | What it is |
| --- | --- |
| `packages/scratch-vm/src/extensions/scratch3_mastra/index.js` | The Mastra API extension. |
| `packages/scratch-vm/src/extensions/scratch3_speech2text/` | The Speech to Text extension: `index.js`, `recorder.js` (the microphone and the end of speech) and `wav.js` (the WAV file). It replaces the experimental extension of the same name. |
| `packages/scratch-vm/src/extensions/scratch3_stage_text/index.js` | The Text extension. |
| `packages/scratch-render/src/TextCostumeSkin.js` | The renderer skin that draws the text of the Text extension. |
| `packages/scratch-gui/src/lib/libraries/extensions/<id>/` | The icons of the extension library. |
| `packages/scratch-vm/test/unit/extension_*.js` | The unit tests of the three extensions. |
| `register-extensions.patch` | The changes to three upstream files: it adds the extensions to `extension-manager.js`, adds three methods for the text skin to `RenderWebGL.js`, and adds the three cards to the extension library of the GUI. |

## How to add the extensions to a Scratch editor

You need Node.js and git.

1. Get the editor:

   ```sh
   git clone https://github.com/scratchfoundation/scratch-editor.git
   cd scratch-editor
   ```

2. Copy the files of this folder into the editor.
   Replace the files that are there already:

   ```sh
   cp -R ../mars-outpost/editor/packages/. packages/
   ```

3. Apply the patch:

   ```sh
   git apply ../mars-outpost/editor/register-extensions.patch
   ```

4. Install, test and start the editor:

   ```sh
   npm install
   cd packages/scratch-vm
   npx tap test/unit/extension_mastra.js test/unit/extension_speech2text.js test/unit/extension_stage_text.js
   cd ../..
   npm start
   ```

5. Open the editor in the browser, and load `Mars outpost.sb3`.

We tested the patch with `git apply --check` on the `develop` branch of scratch-editor of 2026-11-20 (commit `6b058a9`).
The unit tests of the three extensions passed (761 of 761) in our editor fork.

The Mastra API and Speech to Text extensions call the routes `/api/game/*`, `/api/speech` and `/api/speak`.
All URLs are relative, so the editor and the game server must have the same origin.
For example, the game server can serve the files of the built editor, or a proxy can send `/api` to the game server.
Without a game server, each call fails, `status of last call` is `0` or an error status, and the game continues with no computer.
See [`../docs/server.md`](../docs/server.md).

## Mastra API (`mastra`)

The game is state-driven.
The extension tells the server what is true in the game, and the server decides what the computer says.
The extension has no AI logic, no prompt and no key.

### Command blocks

| Block | What it does |
| --- | --- |
| `start game [GAME]` | `POST /api/game/start`. Starts a new talk session on the server. |
| `start game [GAME] again` | The same, for "Try again". The computer does not tell its story again. |
| `set value [NAME] to [VALUE]` | Keeps one value of the game state in a local table. It sends nothing. |
| `clear values` | Empties the local table. |
| `send values` | Sends all values of the table (`sol=1;power_pct=12;...`). It makes no call when nothing changed. |
| `send values again` | Sends all values, also when nothing changed. |
| `set broken sensors to [SENSORS]` | Tells the server which sensors are broken, for example `water,dose`. |
| `look at [STATION] [HOW]` | The player is `near` a station, opened it (`open`), or went away (`leave`). |
| `result of [STATION] is [VALUES]` | The player finished at a station, for example `ice=3`. |
| `set role to [ROLE]` | Gives the computer a role: `advisor`, `low_power`, `damaged`, `hands` or `none`. |
| `put computer to sleep`, `wake computer` | The computer sleeps or wakes. |
| `report fail [CAUSE]` | The player lost. The computer then explains why. |
| `add note [TEXT]` | Adds a line to the memory of the computer. |
| `tell computer [TEXT]` | `POST /api/game/message` with the words of the player and all values. Empty text asks the computer to speak first. |
| `say the remark` | Asks for the short line that the server offered (see "Remarks"). |
| `speak [TEXT]` | Gets the voice of the line from `POST /api/speak`, plays it, and waits until the end. |
| `get voice ready for [TEXT]`, `play voice` | The voice in two steps, so the game knows the length of the audio before it types the words. |
| `stop speaking` | Stops the voice. |

### Reporter blocks

| Block | Value |
| --- | --- |
| `computer says` | The words of the reply. |
| `reply to show?` | True when the game must show and speak the reply. |
| `reply kind` | `mission`, `science`, `chat`, `help`, `order`, `unsafe`, `care`, `fallback`, `asleep` or `silent`. |
| `computer action`, `action target` | An action for the game, for example `point_to` and `airlock`. |
| `computer offer` | `none`, `open`, `accepted` or `declined`: the state of an "Are you sure?" question of the computer. |
| `situation`, `hint level` | The most urgent open problem (for example `need:power`) and its urgency. |
| `computer role`, `computer asleep?` | The role and the sleep of the computer. |
| `remark wanted?`, `remark for` | The server offers a short line now, and its subject. |
| `care needed?` | The child seems sad, scared or lonely. |
| `reply stale?`, `reply fresh?` | The reply is out of date, or the server started a new session. |
| `computer thinking?`, `speaking?`, `voice ready?`, `voice length`, `voice time` | The state of a call and of the voice. |
| `fact [ID] [PART]` | The `title`, `text` or `source` of a NASA fact card (`GET /api/game/fact`). |
| `values` | All values of the local table, for tests. |
| `status of last call` | The HTTP status of the last call. `0` when the call got no answer. |

### Rules of the extension

- Each block that makes a call waits until the server answers, for at most 12 seconds.
- No block throws an error. After each call, `status of last call` has the status, and the script continues.
- The calls go through two queues, so the project never sends two messages at the same time.
- When the server lost its session (for example after a restart), the next reply has `fresh: true`. Then the extension sends the values and the broken sensors again by itself.
- The computer has one voice. A new line stops the old line, so the computer never talks over itself.
- The extension never logs the words of the player or the reply.
- The values, the reply and the voice are run-time state. The project does not save them. The green flag clears them.

### Remarks

A remark is a short line of the computer that nobody asked for, for example when the player comes near a station.
The server decides when a remark is allowed.
A script uses a remark in three steps:

1. After an event block, check `remark wanted?`.
2. When it is true, use `say the remark`.
3. When `reply to show?` is true, show and speak `computer says`.

### Example

```text
when green flag clicked
start game [mars]
clear values
set value [sol] to [1]
set value [power_pct] to [25]
send values
tell computer []
if <reply to show?> then
  show text (computer says)
  speak (computer says)
```

## Speech to Text (`speech2text`)

| Block | What it does |
| --- | --- |
| `listen and wait` | Records the microphone until the speaker stops, gets the text from the server, and then continues. |
| `when I hear [PHRASE]` | Starts when the text of `listen and wait` contains PHRASE. |
| `speech` | The text of the last `listen and wait`. Empty when there were no words. |
| `listening?` | True while the microphone records. |

How it works:

1. The browser asks the player for the microphone the first time.
2. While it records, the stage shows a red microphone in the bottom right corner.
3. The recording stops after 1 second of silence after the speech, after 10 seconds, or when the project stops.
4. The extension removes the silence before and after the speech, but it keeps 0.5 seconds on each side for quiet sounds such as "f" and "s".
5. When the recording has speech, the extension sends it to `POST /api/speech` as a 16 kHz mono WAV file. When it has no speech, the extension sends nothing.

## Text (`stageText`)

| Block | What it does |
| --- | --- |
| `show text [TEXT]` | The sprite shows TEXT in place of its costume. A line break starts a new line. |
| `show costume` | The sprite shows its costume again. |
| `set font to [FONT]` | Sans Serif, Serif, Handwriting, Marker, Curly or Pixel. |
| `set text color to [COLOR]` | The color of the text. |
| `set text size to [SIZE]` | The font size in stage pixels, 4 to 200. |
| `set text width to [WIDTH]` | The wrap width in stage pixels, 10 to 1000. |
| `align text [ALIGN]` | Left, center or right. |
| `number of text lines` | The number of wrapped lines. 0 when the sprite shows its costume. |
| `showing text?` | True when the sprite shows text. |

All other sprite blocks keep working on a sprite with text: motion, show and hide, layers, size, effects, clones, touching and drag.
The id is `stageText` and not `text`, because `text` is already the name of a core block and of a color key of the GUI.

## License

These files come from a fork of scratch-editor, so they have its license: GNU AGPL 3.0.
See [`../LICENSE`](../LICENSE).
