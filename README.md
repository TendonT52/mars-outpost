# Mars outpost

A Scratch game for children of 7 to 12.
The player keeps a small base on Mars alive until the rescue ship comes.
The player controls power, water, food, oxygen and the radiation dose, and sleeps to move the time on.
An AI "ship computer" talks to the player with a voice, and tells the player the next thing to do and why.

## What is in this repository

| Path | What it is |
| --- | --- |
| `Mars outpost.sb3` | The Scratch 3 project of the game: 192 sprites and the stage. |
| `editor/` | The three custom Scratch extensions that the game uses, for a Scratch editor. See [`editor/README.md`](editor/README.md). |
| `docs/server.md` | How the game server works: how it gets the game state, calls the AI model, checks the reply, and makes the voice. See [`docs/server.md`](docs/server.md). |
| `music-credits.md`, `sfx-credits.md` | The sources of the music and the sound effects. |

## How the parts work together

```text
 Browser                                    Game server                  OpenRouter
+-------------------------------+         +------------------------+    +-----------------+
| Scratch editor with the       |  HTTP   | Game routes            |    | Chat model      |
| custom extensions             | ------> |  /api/game/*           | -> | (the computer)  |
|                               |  JSON   | Speech to text         |    | Speech to text  |
|  Mars outpost.sb3             | <------ |  /api/speech           | -> | model           |
|   - mastra      (computer)    |  audio  | Text to speech         |    | Text to speech  |
|   - speech2text (microphone)  |         |  /api/speak            | -> | model           |
|   - stageText   (text)        |         | Guard, sessions, limits|    |                 |
+-------------------------------+         +------------------------+    +-----------------+
```

1. The game runs in the browser, in a Scratch editor that has the three custom extensions.
2. The game sends the state of the base (the sol, the supplies, the events) and the words of the player to the game server.
3. The game server builds a request, calls the AI model through OpenRouter, and checks the reply.
4. The game shows the reply on the screen, and plays it as a voice.

All AI logic is on the server.
The Scratch project has no API key and no prompt.

## How to open the game

1. Download `Mars outpost.sb3`.
2. Open a Scratch editor, and select **File > Load from your computer**.

In the standard Scratch editor (scratch.mit.edu), the game opens, but the three custom extensions are not there.
The editor can show a warning.
The computer does not talk, and the blocks of the Text extension do not work, so most words of the game do not show.
To play the full game, you need these two parts:

- A Scratch editor with the extensions of [`editor/`](editor/README.md).
- A game server with an OpenRouter key, as [`docs/server.md`](docs/server.md) tells.

The source code of the game server is not in this repository.
`docs/server.md` gives its contract and its design.

## License

The files in `editor/` come from a fork of [scratch-editor](https://github.com/scratchfoundation/scratch-editor), so they have the license of that project: GNU AGPL 3.0 (see `LICENSE`).
The music and the sound effects have the license CC0 1.0 (public domain).
