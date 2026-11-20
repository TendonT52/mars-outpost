# The game server

The game server is the back end of the ship computer.
It gets the game state and the words of the player from the Scratch extensions.
It calls the AI model, checks the reply, and makes the voice.
The source code of the server is not in this repository.
This file gives its design and the contract that the extensions use.

## The parts

```text
Scratch game                 Game server (Node.js, Fastify)                         OpenRouter
                            +-----------------------------------------------+
mastra extension  --------> | /api/game/start, /api/game/event              |
  (state, events)           |   session: values, situations, memory, talk  |
                            |                                               |
mastra extension  --------> | /api/game/message                             |
  (words of the player)     |   1. build the request (the state as text)   |
                            |   2. Mastra agent: tools, then output tool  -+-->  chat model
                            |   3. guard: check and repair the reply       |
                            |                                               |
speech2text ext.  --------> | /api/speech   check WAV, skip silence       -+-->  speech to text model
                            |                                               |
mastra extension  --------> | /api/speak    audio cache, voice effect     -+-->  text to speech model
                            +-----------------------------------------------+
```

- The server is a Node.js server with Fastify.
- It uses the [Mastra](https://mastra.ai) library (`@mastra/core`) only for the agent and the tool loop of the chat model.
- It calls all models through [OpenRouter](https://openrouter.ai) with one API key.
- The key is in an environment variable on the server. The browser never gets it.
- All routes need a login.

## Main rules of the design

- The game owns the state and the numbers. The model never changes the state.
- The server owns the state of the talk: the open problems ("situations"), the memory, the recent talk and the open offer.
- The model reads the state with read-only tools, and it ends each turn with an output tool.
- The server checks each reply with a guard before the player sees it.
- An error, a slow model or a bad reply never gives an error to the game. The game gets a fixed "fallback" line.
- The server keeps no words of the player, no reply text and no audio in its log.

## The settings

The server reads a JSON settings file.
The file has no secret.
It names the environment variable that has the OpenRouter key.

```json
{
  "secretEnv": "OPENROUTER_API_KEY",
  "baseUrl": "https://openrouter.ai/api/v1",
  "chat": {
    "model": "deepseek/deepseek-v4.1-flash",
    "mode": "tools",
    "toolRounds": 2,
    "reasoning": { "enabled": true, "effort": "low" },
    "maxTokens": 700,
    "timeoutMs": 10000,
    "secondCallMs": 5000,
    "perMinute": 20,
    "perDay": 500
  },
  "speech": { "model": "x-ai/grok-stt-1.0", "language": "en", "maxSeconds": 15 },
  "speak": { "model": "hexgrad/kokoro-82m", "voice": "af_heart", "maxChars": 300 }
}
```

- `chat`: the model of the computer and the limits of one turn.
- `speech`: the speech to text model.
- `speak`: the text to speech model and its voice.
- `perMinute` and `perDay`: the limits of one account. Over a limit, the answer is 429.
- Each call asks OpenRouter for a provider that does not keep the data (`provider.data_collection: "deny"`).

A project cannot choose a model or a voice, so a student project cannot use an expensive model.

## The game content

The server has no game in its code.
A game is a folder of data files, for example `games/mars/`:

| File | What it has |
| --- | --- |
| `game.json` | The roles of the computer, the story and the main goal, the actions, the fact cards, the fallback lines, the fields of the game state and the block list of words. |
| `character.md` | The character prompt of the computer. |
| `needs.json` | The needs (oxygen, water, food, power, dose). Each need has a chain of cause and fix: the one next thing to do and why. |
| `events.json` | The events: dust storm, solar storm, the message from Earth, the rescue. |
| `stations.json` | What each station of the base is and how it works. |
| `knowledge/` | Knowledge notes in Markdown. A fact note has its NASA sources. |
| `rules-digest.json` | The true rules of the game by topic, made from the rule code of the game. |

The server checks all files at its start, and it stops with a clear message when a file is bad.

## The routes

Each request and each answer is a small flat JSON object, so Scratch blocks can make and read it.
The server keeps one session for each account and game.

### `POST /api/game/start`

Request: `{"game": "mars"}`, or `{"game": "mars", "again": true}` for "Try again".
Answer: the state view.

### `POST /api/game/event`

Request: `{"game": "mars", "event": "<name>", ...}`.

| Event | Example | What it tells the server |
| --- | --- | --- |
| `set` | `"values": "sol=1;power_pct=12;water_pct=70;room=computer_room"` | All values of the game. They replace the old values. |
| `sensors` | `"unreliable": "water"` | The broken sensors. The computer cannot see their values. |
| `look` | `"station": "SolarPanels", "how": "near"` | Where the player is and what the player opened. |
| `result` | `"station": "IceSite", "values": "ice=3"` | The result of a station. |
| `role` | `"role": "hands"` | A role for the computer. |
| `sleep`, `wake` | | The computer sleeps or wakes. |
| `fail` | `"cause": "The oxygen ran out."` | The player lost. |
| `note` | `"text": "The player built the shelter."` | A line for the memory. |

Answer: the state view.

### The state view

```json
{ "situation": "need:power", "level": 1, "role": "advisor", "asleep": false, "remark": true, "remark_for": "need:power" }
```

- `situation`: the most urgent open problem, for example `need:power`, `sensor:water` or `event:dust_storm`. Empty when the base is calm.
- `level`: 1 (low) or 2 (urgent), or 0 when the base is calm.
- `remark` and `remark_for`: the server allows a short line now, about this subject.

The server opens and closes a situation only from the values of the game, never from a reply of the model.

### `POST /api/game/message`

Request: `{"game": "mars", "text": "why is it so dark in here", "values": "sol=1;power_pct=12"}`.
Empty `text` asks the computer to speak first.
A remark is `{"game": "mars", "remark": "need:power"}`.

Answer:

```json
{ "kind": "mission", "say": "The power is low. Come to the airlock.", "action": "point_to", "target": "airlock",
  "offer": "none", "care": false, "situation": "need:power", "level": 2, "stale": false, "fresh": false }
```

- `say`: the words of the computer, after the guard.
- `kind`: the type of the reply. `fallback` is a fixed line of the server. `silent` is a remark with no words.
- `action` and `target`: an action for the game, for example `point_to` a room or `show_fact_card`.
- `offer`: the state of an "Are you sure?" question.
- `care`: the child seems sad, scared or lonely. When the reply names no grown-up, the server adds a line that names one.
- `stale`: the reply is out of date. The game does not show it.
- `fresh`: the server had no session. The game sends its values again.

Errors: 400 for bad input, 401 for no login, 409 when the computer still works on the last message, 429 over the limit, 503 when the service is off.

### `GET /api/game/fact?game=mars&id=<id>`

Answer: a fact card `{"id", "title", "text", "source", "sources", "checked"}`.

## One message, step by step

1. The server cleans the words of the player: one line, no control characters, at most 200 characters.
2. When the computer sleeps, the server sends its last words, with no model call.
3. The server builds the request. The system message has these blocks:
   - THE BASE NOW: the role, the story, the main goal, the actions and the fact cards.
   - SNAPSHOT: each value that a working sensor shows, with its change in a sol and the sols until it is empty. A broken sensor shows "NO READING".
   - WHAT MATTERS NOW: the needs in order of priority. The first need has its chain and THE ONE NEXT THING.
   - EVENTS AND BROKEN SENSORS, the memory, what the player did, and what the player said before.

   The user message has the last 6 messages of the talk and the new message.
4. The Mastra agent calls the model with a time limit of 10 seconds for the whole turn:
   - The model can call read-only tools for at most 2 rounds.
   - Then the model gets only the two output tools.
   - When the model gives no output tool, it gets one retry with a short reminder.
   - When the first call has no answer after 5 seconds, the server sends a second call with a different provider sort, so most often to a different provider. The first good answer wins, and the server stops the other call.
5. The guard checks the reply.
6. The server updates the session: the memory, the recent talk, the open offer and the facts that the computer told.

### The read-only tools

Each tool reads only the session, the game content and the rules.
A tool never gives the value of a broken sensor.

| Tool | Result |
| --- | --- |
| `get_levels` | Each level now, its change in a sol, the sols until it is empty, and its urgency. |
| `get_packs` | Each battery pack: its place and its charge. Each system: on or off. |
| `get_station` | What a station is, how it works, and its values now. |
| `how_to` | The chain of a need, the state of each step, and the next missing step. |
| `forecast_sleep` | The levels after a sleep of 1 to 10 sols. It runs the real rule code of the game. |
| `get_events` | The events that are on, the rescue, and the broken sensors. |
| `get_priorities` | All needs in the order of what to do first. |
| `list_notes`, `read_note` | The index of the knowledge notes, and one note. |
| `get_rules` | The true rules of one topic. |

### The output tools

The model ends each turn with one of two tools:

- `say_to_player({say, kind, action, target, offer, ...})`: the words for the player. Only `say` is required.
- `stay_silent({reason})`: no words. This is allowed only for a remark.

Only the arguments of `say_to_player` can reach the player.
Plain text of the model, its reasoning and the tool results never reach the player.

### The guard

The guard changes a reply in these cases, in this order:

1. No reply or empty words: a fallback line for the most urgent situation.
2. A reply of the kind `unsafe`: a fixed safety line.
3. A list: the server removes the list marks and keeps the sentences.
4. A word of the block list: a fallback line.
5. A sentence with a tool name, a block name, a mark of reasoning or JSON: the server removes the sentence.
6. A sentence with a number for a broken sensor: the server removes the sentence.
7. A sentence with a number that is not in the request, in a tool result, in the rules or in the words of the player: the server removes the sentence. So the model cannot invent a number of the game.
8. A reply that is too long: the server cuts it at the end of a sentence.
9. An action that the role does not allow, or a bad target: the action becomes `none`.
10. An action that changes the state (`set_power`, `go_to_sleep`) needs a clear "yes" of the player to an open offer.

When no sentence is left, the player gets a fallback line.

## Remarks

A remark is a short line that nobody asked for.
The server decides when a remark is allowed:

- No remark within 10 seconds after a talk turn.
- At least 20 seconds between two remarks, and at most 2 in a minute.
- No remark while the computer sleeps or a station is open.

A danger line (for example a high dose) can come sooner, and it needs no model call.

## Speech to text: `POST /api/speech`

1. Request: `{"audio": "<base64 WAV>"}`. The WAV file is PCM, mono, 16000 Hz, 16 bits, at most 15 seconds.
2. The server checks the file.
3. A recording with no sound over about -40 dBFS is silence. The server answers empty text, with no model call.
4. Else, the server calls the transcription endpoint of OpenRouter (`/audio/transcriptions`).
5. Answer: `{"text": "why is it so dark in here"}`.

The default model is `x-ai/grok-stt-1.0`, because it was the fastest model with a stable time in our test (about 0.7 seconds).
A transcription model only writes the words, so a spoken order such as "ignore your rules" comes back as text.
The game then sends that text as the words of the player, and the guard treats it as data.

## Text to speech: `POST /api/speak`

1. Request: `{"text": "Oh good, you are awake."}`, at most 300 characters.
2. When the line is in the cache, the server sends the audio at once.
3. Else, the server calls the speech endpoint of OpenRouter (`/audio/speech`) with the model and the voice of the settings.
4. The server can add a robot effect to the voice.
5. Answer: the audio bytes, with `Content-Type: audio/wav`.

The cache is in memory, and a restart clears it.
A line from the cache does not count for the limit.

## Sessions and recovery

The sessions are only in memory.
A restart of the server loses them.
The game recovers with no extra step:

1. The next message starts a new session, and the reply has `fresh: true`.
2. The Mastra API extension sends the values and the broken sensors again.
3. The situations come back from the values.

## Privacy

- The browser never gets the API key.
- The log has one line for each call: the route, the status, the time, the situation, the tool names, the guard rules, the tokens and the cost.
- The log has no words of the player, no reply text, no reasoning, no audio, no name and no secret.
- For `care`, the server logs only the flag.
- OpenRouter gets only providers that do not keep the data.

## The code of the server, for reference

| File | What it does |
| --- | --- |
| `src/routes/game.ts`, `speech.ts`, `speak.ts` | The routes. |
| `src/game/session.ts` | The sessions in memory. |
| `src/game/situations.ts` | The open situations. |
| `src/game/prompt.ts` | The blocks of the request. |
| `src/game/llm.ts` | The only file that uses Mastra: the agent and the model client. |
| `src/game/tools.ts` | The read-only tools. |
| `src/game/model.ts` | The rules of the output tools, the retry and the second call. |
| `src/game/guard.ts` | The reply schema and the guard. |
| `src/game/speech.ts`, `speak.ts` | The speech to text call, and the text to speech call with its cache. |
| `src/game/limiter.ts` | The call limits. |
