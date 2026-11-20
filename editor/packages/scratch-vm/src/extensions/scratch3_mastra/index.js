const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');
const Cast = require('../../util/cast');
const log = require('../../util/log');
const {fetchWithTimeout} = require('../../util/fetch-with-timeout');
const formatMessage = require('format-message');

/**
 * Make an icon with a speech bubble that has three dots, encoded as a data URI.
 * @param {string} color The color of the icon.
 * @returns {string} The data URI of the icon.
 */
const makeIconURI = color => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">' +
        `<g fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">` +
        '<path d="M8 8h24a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H21l-7 6v-6H8a3 3 0 0 1-3-3V11a3 3 0 0 1 3-3z"/>' +
        '</g>' +
        `<g fill="${color}"><circle cx="14" cy="18" r="2"/><circle cx="20" cy="18" r="2"/>` +
        '<circle cx="26" cy="18" r="2"/></g></svg>';
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

/**
 * Icon to be displayed in the blocks category menu, encoded as a data URI.
 * @type {string}
 */
const menuIconURI = makeIconURI('#0FBD8C');

/**
 * Icon to be displayed at the left edge of each extension block, encoded as a data URI.
 * @type {string}
 */
const blockIconURI = makeIconURI('#FFFFFF');

/**
 * The routes of the computer on the server. They are relative, so the request goes to the server of the page.
 * @type {object}
 */
const ROUTES = {
    start: '/api/game/start',
    message: '/api/game/message',
    event: '/api/game/event',
    fact: '/api/game/fact',
    speak: '/api/speak'
};

/**
 * How long to wait in ms before a call times out. The server waits 8 s for its model by default and then
 * answers with a fallback line, so the client waits a little longer.
 * @type {number}
 */
const CALL_TIMEOUT_MS = 12000;

/**
 * The longest value that the server accepts, in characters.
 * @type {number}
 */
const MAX_VALUE_CHARS = 40;

/**
 * The action after which the computer sleeps.
 * @type {string}
 */
const SLEEP_ACTION = 'go_to_sleep';

/**
 * How long in ms a line can play after its length before the speak block ends anyway. The audio context of a page
 * can be suspended (for example before the first click), and then a sound never ends.
 * @type {number}
 */
const SPEAK_GRACE_MS = 2000;

/**
 * How the player looks at a station: the player is near it, opened it or left it.
 * @type {Array.<string>}
 */
const LOOK_HOWS = ['near', 'open', 'leave'];

/**
 * The roles that the set role block can choose. The role `none` gives back the role of the situations.
 * @type {Array.<string>}
 */
const ROLES = ['advisor', 'low_power', 'damaged', 'hands', 'none'];

/**
 * The parts of a fact card that the fact block reports.
 * @type {Array.<string>}
 */
const FACT_PARTS = ['title', 'text', 'source'];

const isObject = value => value !== null && typeof value === 'object';
const textOf = (value, fallback) => (typeof value === 'string' ? value : fallback);

/**
 * Parse JSON text.
 * @param {string} text The JSON text.
 * @returns {?object} The value, or null when the text is not valid JSON.
 */
const parseJSON = text => {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};

/**
 * Make a name safe for the values text of the server: no `;`, no `=` and no control characters.
 * @param {string|number|boolean} name The name.
 * @returns {string} The clean name.
 */
const cleanName = name => Cast.toString(name).replace(/[;=]|\p{Cc}/gu, '')
    .trim();

/**
 * Make a value safe for the values text of the server. The server splits the text at `;`, so a `;` becomes a
 * comma. A control character becomes a space. The server accepts at most 40 characters.
 * @param {string|number|boolean} value The value.
 * @returns {string} The clean value.
 */
const cleanValue = value => {
    const text = Cast.toString(value).replace(/;/g, ',')
        .replace(/\p{Cc}/gu, ' ');
    return text.trim().slice(0, MAX_VALUE_CHARS)
        .trim();
};

/**
 * Class for the Mastra API blocks in Scratch 3.0.
 * The blocks talk to the computer of a game. The computer is a character that lives on the server.
 * All AI logic is on the server. The game owns its state and sends it with events. The blocks send the events
 * and the words of the player, and report the state view and the reply of the computer.
 * The contract of the routes is in server/README.md, section "The computer".
 * @class
 */
class Scratch3MastraBlocks {
    /**
     * @param {object} runtime The runtime that runs the blocks.
     */
    constructor (runtime) {
        /**
         * How long to wait in ms before a call times out.
         * @type {number}
         * @private
         */
        this._timeoutMs = CALL_TIMEOUT_MS;

        /**
         * How long in ms a line can play after its length before the speak block ends anyway.
         * @type {number}
         * @private
         */
        this._speakGraceMs = SPEAK_GRACE_MS;

        /**
         * The end of the main queue of calls. A call starts when the call before it has finished.
         * @type {Promise}
         * @private
         */
        this._tail = Promise.resolve();

        /**
         * The end of the queue of the `look` and `result` events.
         * @type {Promise}
         * @private
         */
        this._stationTail = Promise.resolve();

        /**
         * The number of the current run. A call of an older run does not start, and its answer is dropped.
         * @type {number}
         * @private
         */
        this._epoch = 0;

        /**
         * The runtime. Its audio engine plays the voice of the computer.
         * @type {object}
         * @private
         */
        this._runtime = runtime;

        /**
         * The number of the current line of the voice. A new speak block or a stop changes it, and then an older
         * line does not play.
         * @type {number}
         * @private
         */
        this._lineId = 0;

        /**
         * The sound player of the line that plays now, or null.
         * @type {?object}
         * @private
         */
        this._player = null;

        /**
         * Ends the block of the current line, or null when no speak block waits.
         * @type {?function()}
         * @private
         */
        this._endLine = null;

        /**
         * The decoded line that waits for the `play voice` block, or null.
         * @type {?object}
         * @private
         */
        this._readyPlayer = null;

        /**
         * The number of the current `get voice ready` block. A newer block or a stop changes it, and then the audio
         * of an older block is dropped.
         * @type {number}
         * @private
         */
        this._loadId = 0;

        /**
         * Ends the `get voice ready` block that waits for its audio, or null.
         * @type {?function()}
         * @private
         */
        this._endLoad = null;

        /**
         * The time in ms (Date.now) at which the line that plays now started.
         * @type {number}
         * @private
         */
        this._playStart = 0;

        this._resetState();

        if (runtime) {
            runtime.on('PROJECT_START', () => this._resetState());
            runtime.on('PROJECT_STOP_ALL', () => {
                this._epoch++;
                this._thinking = 0;
                this._stopVoice();
            });
        }
    }

    /**
     * Forget the game, the values and the reply. This is the state at the start of a run.
     * @private
     */
    _resetState () {
        this._game = 'mars';
        this._values = new Map();
        this._sentValues = null;
        this._sensors = '';
        this._recoverDue = false;
        this._status = 0;
        this._thinking = 0;
        this._view = {situation: '', level: 0, role: '', asleep: false, remark: false, remarkFor: ''};
        this._clearReply();
    }

    /**
     * Forget the last reply of the computer.
     * @param {string} [kind] The kind of the empty reply.
     * @private
     */
    _clearReply (kind = '') {
        this._reply = {
            say: '', action: 'none', target: '', kind, offer: 'none', care: false, stale: false, fresh: false
        };
    }

    /**
     * @returns {object} metadata for this extension and its blocks.
     */
    getInfo () {
        const defaultText = formatMessage({
            id: 'mastra.defaultText',
            default: 'Hello',
            description: 'Default words of the player'
        });
        const defaultCause = formatMessage({
            id: 'mastra.defaultCause',
            default: 'The oxygen ran out.',
            description: 'Default cause of a fail'
        });
        const defaultSpeech = formatMessage({
            id: 'mastra.defaultSpeech',
            default: 'Oh good, you are awake.',
            description: 'Default words that the computer says aloud'
        });
        const defaultNote = formatMessage({
            id: 'mastra.defaultNote',
            default: 'The player built the shelter.',
            description: 'Default line for the memory'
        });
        return {
            id: 'mastra',
            name: formatMessage({
                id: 'mastra.categoryName',
                default: 'Mastra API',
                description: 'Name of extension that adds blocks to talk to the computer of a game'
            }),
            blockIconURI: blockIconURI,
            menuIconURI: menuIconURI,
            blocks: [
                {
                    opcode: 'startGame',
                    text: formatMessage({
                        id: 'mastra.startGame',
                        default: 'start game [GAME]',
                        description: 'Start a new game on the server and wait for the answer'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        GAME: {type: ArgumentType.STRING, defaultValue: 'mars'}
                    }
                },
                {
                    opcode: 'startGameAgain',
                    text: formatMessage({
                        id: 'mastra.startGameAgain',
                        default: 'start game [GAME] again',
                        description: 'Start the game again after a fail. The computer keeps the facts that it told'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        GAME: {type: ArgumentType.STRING, defaultValue: 'mars'}
                    }
                },
                '---',
                {
                    opcode: 'setValue',
                    text: formatMessage({
                        id: 'mastra.setValue',
                        default: 'set value [NAME] to [VALUE]',
                        description: 'Keep a number or word of the game state for the next send'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        NAME: {type: ArgumentType.STRING, defaultValue: 'sol'},
                        VALUE: {type: ArgumentType.STRING, defaultValue: '1'}
                    }
                },
                {
                    opcode: 'clearValues',
                    text: formatMessage({
                        id: 'mastra.clearValues',
                        default: 'clear values',
                        description: 'Forget all kept values of the game state'
                    }),
                    blockType: BlockType.COMMAND
                },
                {
                    opcode: 'sendValues',
                    text: formatMessage({
                        id: 'mastra.sendValues',
                        default: 'send values',
                        description: 'Send all kept values to the computer, when they changed since the last send'
                    }),
                    blockType: BlockType.COMMAND
                },
                {
                    opcode: 'sendValuesAlways',
                    text: formatMessage({
                        id: 'mastra.sendValuesAlways',
                        default: 'send values again',
                        description: 'Send all kept values to the computer, also when they did not change'
                    }),
                    blockType: BlockType.COMMAND
                },
                {
                    opcode: 'valuesText',
                    text: formatMessage({
                        id: 'mastra.valuesText',
                        default: 'values',
                        description: 'Report all kept values as one text, for example sol=1;power_pct=12'
                    }),
                    blockType: BlockType.REPORTER
                },
                {
                    opcode: 'setSensors',
                    text: formatMessage({
                        id: 'mastra.setSensors',
                        default: 'set broken sensors to [SENSORS]',
                        description: 'Name the values that the computer cannot trust, or empty text to repair all'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        SENSORS: {type: ArgumentType.STRING, defaultValue: 'water'}
                    }
                },
                '---',
                {
                    opcode: 'look',
                    text: formatMessage({
                        id: 'mastra.look',
                        default: 'look at [STATION] [HOW]',
                        description: 'Tell the computer that the player is near a station, opened it or left it'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        STATION: {type: ArgumentType.STRING, defaultValue: 'SolarPanels'},
                        HOW: {type: ArgumentType.STRING, menu: 'hows', defaultValue: LOOK_HOWS[0]}
                    }
                },
                {
                    opcode: 'stationResult',
                    text: formatMessage({
                        id: 'mastra.stationResult',
                        default: 'result of [STATION] is [VALUES]',
                        description: 'Tell the computer what the player did at a station'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        STATION: {type: ArgumentType.STRING, defaultValue: 'IceSite'},
                        VALUES: {type: ArgumentType.STRING, defaultValue: 'ice=3'}
                    }
                },
                {
                    opcode: 'setRole',
                    text: formatMessage({
                        id: 'mastra.setRole',
                        default: 'set role to [ROLE]',
                        description: 'Set the role of the computer, in place of the role of the situations'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        ROLE: {type: ArgumentType.STRING, menu: 'roles', defaultValue: ROLES[0]}
                    }
                },
                {
                    opcode: 'sleepComputer',
                    text: formatMessage({
                        id: 'mastra.sleepComputer',
                        default: 'put computer to sleep',
                        description: 'Tell the computer that the game put it to sleep'
                    }),
                    blockType: BlockType.COMMAND
                },
                {
                    opcode: 'wakeComputer',
                    text: formatMessage({
                        id: 'mastra.wakeComputer',
                        default: 'wake computer',
                        description: 'Wake the computer after its sleep'
                    }),
                    blockType: BlockType.COMMAND
                },
                {
                    opcode: 'reportFail',
                    text: formatMessage({
                        id: 'mastra.reportFail',
                        default: 'report fail [CAUSE]',
                        description: 'Tell the computer that the player failed, and why'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        CAUSE: {type: ArgumentType.STRING, defaultValue: defaultCause}
                    }
                },
                {
                    opcode: 'addNote',
                    text: formatMessage({
                        id: 'mastra.addNote',
                        default: 'add note [TEXT]',
                        description: 'Give the computer a line for its memory'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        TEXT: {type: ArgumentType.STRING, defaultValue: defaultNote}
                    }
                },
                '---',
                {
                    opcode: 'situation',
                    text: formatMessage({
                        id: 'mastra.situation',
                        default: 'situation',
                        description: 'Report the most urgent open situation, for example need:power, or empty text'
                    }),
                    blockType: BlockType.REPORTER
                },
                {
                    opcode: 'hintLevel',
                    text: formatMessage({
                        id: 'mastra.hintLevel',
                        default: 'hint level',
                        description: 'Report the hint level of the most urgent situation, 1 to 3, or 0'
                    }),
                    blockType: BlockType.REPORTER
                },
                {
                    opcode: 'computerRole',
                    text: formatMessage({
                        id: 'mastra.computerRole',
                        default: 'computer role',
                        description: 'Report the role of the computer'
                    }),
                    blockType: BlockType.REPORTER
                },
                {
                    opcode: 'isAsleep',
                    text: formatMessage({
                        id: 'mastra.isAsleep',
                        default: 'computer asleep?',
                        description: 'True when the computer sleeps'
                    }),
                    blockType: BlockType.BOOLEAN
                },
                {
                    opcode: 'remarkWanted',
                    text: formatMessage({
                        id: 'mastra.remarkWanted',
                        default: 'remark wanted?',
                        description: 'True when the computer wants to say a short line now'
                    }),
                    blockType: BlockType.BOOLEAN
                },
                {
                    opcode: 'remarkFor',
                    text: formatMessage({
                        id: 'mastra.remarkFor',
                        default: 'remark for',
                        description: 'Report the subject of the remark: a situation or a station'
                    }),
                    blockType: BlockType.REPORTER
                },
                '---',
                {
                    opcode: 'tellComputer',
                    text: formatMessage({
                        id: 'mastra.tellComputer',
                        default: 'tell computer [TEXT]',
                        description: 'Send the words of the player to the computer and wait for the reply'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        TEXT: {type: ArgumentType.STRING, defaultValue: defaultText}
                    }
                },
                {
                    opcode: 'sayRemark',
                    text: formatMessage({
                        id: 'mastra.sayRemark',
                        default: 'say the remark',
                        description: 'Ask the computer for the remark that it wants to say, and wait for the reply'
                    }),
                    blockType: BlockType.COMMAND
                },
                {
                    opcode: 'replyToShow',
                    text: formatMessage({
                        id: 'mastra.replyToShow',
                        default: 'reply to show?',
                        description: 'True when the last reply has words that the game must show and speak'
                    }),
                    blockType: BlockType.BOOLEAN
                },
                {
                    opcode: 'computerSays',
                    text: formatMessage({
                        id: 'mastra.computerSays',
                        default: 'computer says',
                        description: 'Report the words of the last reply of the computer'
                    }),
                    blockType: BlockType.REPORTER
                },
                {
                    opcode: 'replyKind',
                    text: formatMessage({
                        id: 'mastra.replyKind',
                        default: 'reply kind',
                        description: 'Report the kind of the last reply, for example mission, science or fallback'
                    }),
                    blockType: BlockType.REPORTER
                },
                {
                    opcode: 'computerAction',
                    text: formatMessage({
                        id: 'mastra.computerAction',
                        default: 'computer action',
                        description: 'Report the action that the last reply asks for'
                    }),
                    blockType: BlockType.REPORTER
                },
                {
                    opcode: 'actionTarget',
                    text: formatMessage({
                        id: 'mastra.actionTarget',
                        default: 'action target',
                        description: 'Report the target of the action of the last reply'
                    }),
                    blockType: BlockType.REPORTER
                },
                {
                    opcode: 'openOffer',
                    text: formatMessage({
                        id: 'mastra.openOffer',
                        default: 'computer offer',
                        description: 'Report the offer of the last reply: none, open, accepted or declined'
                    }),
                    blockType: BlockType.REPORTER
                },
                {
                    opcode: 'needsCare',
                    text: formatMessage({
                        id: 'mastra.needsCare',
                        default: 'care needed?',
                        description: 'True when the last reply says that the child needs a grown-up'
                    }),
                    blockType: BlockType.BOOLEAN
                },
                {
                    opcode: 'isStale',
                    text: formatMessage({
                        id: 'mastra.isStale',
                        default: 'reply stale?',
                        description: 'True when the last reply is out of date and the game must drop it'
                    }),
                    blockType: BlockType.BOOLEAN
                },
                {
                    opcode: 'isFresh',
                    text: formatMessage({
                        id: 'mastra.isFresh',
                        default: 'reply fresh?',
                        description: 'True when the server started a new session with the last message'
                    }),
                    blockType: BlockType.BOOLEAN
                },
                {
                    opcode: 'isThinking',
                    text: formatMessage({
                        id: 'mastra.isThinking',
                        default: 'computer thinking?',
                        description: 'True while a message waits for the reply of the computer'
                    }),
                    blockType: BlockType.BOOLEAN
                },
                '---',
                {
                    opcode: 'speak',
                    text: formatMessage({
                        id: 'mastra.speak',
                        default: 'speak [TEXT]',
                        description: 'Say the words aloud with the voice of the computer, and wait until the end'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        TEXT: {type: ArgumentType.STRING, defaultValue: defaultSpeech}
                    }
                },
                {
                    opcode: 'loadSpeech',
                    text: formatMessage({
                        id: 'mastra.loadSpeech',
                        default: 'get voice ready for [TEXT]',
                        description: 'Get the audio of the words from the server, and wait until it can play'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        TEXT: {type: ArgumentType.STRING, defaultValue: defaultSpeech}
                    }
                },
                {
                    opcode: 'playSpeech',
                    text: formatMessage({
                        id: 'mastra.playSpeech',
                        default: 'play voice',
                        description: 'Play the audio that is ready, and wait until the end'
                    }),
                    blockType: BlockType.COMMAND
                },
                {
                    opcode: 'stopSpeaking',
                    text: formatMessage({
                        id: 'mastra.stopSpeaking',
                        default: 'stop speaking',
                        description: 'Stop the voice of the computer'
                    }),
                    blockType: BlockType.COMMAND
                },
                {
                    opcode: 'isSpeaking',
                    text: formatMessage({
                        id: 'mastra.isSpeaking',
                        default: 'speaking?',
                        description: 'True while the voice of the computer plays'
                    }),
                    blockType: BlockType.BOOLEAN
                },
                {
                    opcode: 'speechReady',
                    text: formatMessage({
                        id: 'mastra.speechReady',
                        default: 'voice ready?',
                        description: 'True when the audio of a line is ready and waits for the play voice block'
                    }),
                    blockType: BlockType.BOOLEAN
                },
                {
                    opcode: 'speechLength',
                    text: formatMessage({
                        id: 'mastra.speechLength',
                        default: 'voice length',
                        description: 'The length in seconds of the line that is ready, or of the line that plays'
                    }),
                    blockType: BlockType.REPORTER
                },
                {
                    opcode: 'speechTime',
                    text: formatMessage({
                        id: 'mastra.speechTime',
                        default: 'voice time',
                        description: 'The seconds since the start of the line that plays'
                    }),
                    blockType: BlockType.REPORTER
                },
                '---',
                {
                    opcode: 'fact',
                    text: formatMessage({
                        id: 'mastra.fact',
                        default: 'fact [ID] [PART]',
                        description: 'Report a part of a fact card of the game'
                    }),
                    blockType: BlockType.REPORTER,
                    arguments: {
                        ID: {type: ArgumentType.STRING, defaultValue: 'sol_length'},
                        PART: {type: ArgumentType.STRING, menu: 'parts', defaultValue: 'text'}
                    }
                },
                {
                    opcode: 'status',
                    text: formatMessage({
                        id: 'mastra.status',
                        default: 'status of last call',
                        description: 'Report the HTTP status number of the last call to the server'
                    }),
                    blockType: BlockType.REPORTER
                }
            ],
            menus: {
                hows: {acceptReporters: true, items: LOOK_HOWS},
                roles: {acceptReporters: false, items: ROLES},
                parts: {acceptReporters: false, items: FACT_PARTS}
            }
        };
    }

    /**
     * Run a call after all calls of the same queue before it. A call of an older run does not start.
     * The main queue has the messages and most events, so two of them never overlap and the extension itself never
     * causes a 409 answer. The station queue has the `look` and `result` events: the server takes them also while
     * it works on a message, so they do not wait for the reply.
     * @param {string} queue The property with the end of the queue: `_tail` or `_stationTail`.
     * @param {function(): ?Promise} job Make the call. It must not reject.
     * @returns {Promise} Resolves when the job has finished or was dropped.
     * @private
     */
    _enqueue (queue, job) {
        const epoch = this._epoch;
        const run = this[queue].then(() => (epoch === this._epoch ? job() : null));
        this[queue] = run.catch(() => {});
        return run;
    }

    /**
     * Run a call in the main queue. When a recovery is due, it runs first.
     * @param {function(): ?Promise} job Make the call. It must not reject.
     * @returns {Promise} Resolves when the job has finished or was dropped.
     * @private
     */
    _enqueueMain (job) {
        return this._enqueue('_tail', () => {
            if (!this._recoverDue) return job();
            const epoch = this._epoch;
            return this._recover().then(() => (epoch === this._epoch ? job() : null));
        });
    }

    /**
     * Send a POST request to the server.
     * @param {string} route The route.
     * @param {object} body The JSON body.
     * @returns {Promise.<{status: number, data: ?object}>} The HTTP status (0 when the call did not finish)
     *     and the JSON object of the answer.
     * @private
     */
    _post (route, body) {
        return this._fetch(route, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        });
    }

    /**
     * Make a call. It never rejects. The log has the route and the status, and never the words.
     * @param {string} url The relative URL.
     * @param {object} init The options of fetch.
     * @returns {Promise.<{status: number, data: ?object}>} The status and the JSON object of the answer.
     * @private
     */
    _fetch (url, init) {
        return fetchWithTimeout(url, init, this._timeoutMs)
            .then(response => response.text().then(text => {
                const data = parseJSON(text);
                return {status: response.status, data: isObject(data) ? data : null};
            }))
            .catch(() => {
                log.warn(`Mastra API: no answer from ${url.split('?')[0]}`);
                return {status: 0, data: null};
            });
    }

    /**
     * @returns {string} All values as text for the server, for example `sol=1;power_pct=12`.
     * @private
     */
    _valuesText () {
        return Array.from(this._values, ([name, value]) => `${name}=${value}`).join(';');
    }

    /**
     * Take the fields of a state view, or the state fields of a reply.
     * @param {?object} data The answer of the server.
     * @private
     */
    _takeView (data) {
        if (!data) return;
        const view = this._view;
        if (typeof data.situation === 'string') view.situation = data.situation;
        if (typeof data.level === 'number') view.level = data.level;
        if (typeof data.role === 'string') view.role = data.role;
        if (typeof data.asleep === 'boolean') view.asleep = data.asleep;
        if (typeof data.remark === 'boolean') {
            view.remark = data.remark;
            view.remarkFor = textOf(data.remark_for, '');
        }
    }

    /**
     * Send one game event now, and take the state view of the answer. It never rejects.
     * @param {object} fields The fields of the event, with `event`.
     * @returns {Promise.<number>} The HTTP status, or -1 when the run ended before the answer.
     * @private
     */
    _eventNow (fields) {
        const epoch = this._epoch;
        return this._post(ROUTES.event, Object.assign({game: this._game}, fields)).then(({status, data}) => {
            if (epoch !== this._epoch) return -1;
            this._status = status;
            if (status === 200) this._takeView(data);
            return status;
        });
    }

    /**
     * Send one game event after the calls of the main queue.
     * @param {object} fields The fields of the event, with `event`.
     * @returns {Promise} Resolves when the server has answered.
     * @private
     */
    _sendEvent (fields) {
        return this._enqueueMain(() => this._eventNow(fields));
    }

    /**
     * Give a new session of the server the state of the game again: all values and the broken sensors.
     * The server loses its sessions at a restart, and says so with `fresh: true` in the next reply.
     * When a call fails, the recovery stays due, and the next call of the main queue tries again.
     * The status of the last call does not change, so it still tells about the call of the block.
     * @returns {Promise} Resolves when the calls have finished.
     * @private
     */
    _recover () {
        const epoch = this._epoch;
        const status = this._status;
        const values = this._valuesText();
        const sensors = this._sensors;
        this._sentValues = null;
        const first = values ? this._eventNow({event: 'set', values}) : Promise.resolve(200);
        return first.then(result => {
            if (result !== 200) return result;
            this._sentValues = values;
            return sensors ? this._eventNow({event: 'sensors', unreliable: sensors}) : 200;
        }).then(result => {
            if (epoch !== this._epoch) return;
            this._recoverDue = result !== 200;
            this._status = status;
        });
    }

    /**
     * Send a message now and take the reply. It never rejects.
     * @param {object} body The body of the message.
     * @param {boolean} thinks True when the "thinking" count has this message.
     * @returns {Promise} Resolves when the reply is there, or the call has failed.
     * @private
     */
    _messageNow (body, thinks) {
        const epoch = this._epoch;
        return this._post(ROUTES.message, body).then(({status, data}) => {
            if (epoch !== this._epoch) return null;
            if (thinks) this._thinking--;
            this._status = status;
            if (status !== 200 || !data || typeof data.say !== 'string') {
                this._clearReply();
                return null;
            }
            this._reply = {
                say: data.say,
                action: textOf(data.action, 'none'),
                target: textOf(data.target, ''),
                kind: textOf(data.kind, ''),
                offer: textOf(data.offer, 'none'),
                care: data.care === true,
                stale: data.stale === true,
                fresh: data.fresh === true
            };
            this._takeView(data);
            if (this._reply.kind === 'asleep' || this._reply.action === SLEEP_ACTION) this._view.asleep = true;
            if (body.values) this._sentValues = body.values;
            if (!this._reply.fresh) return null;
            this._recoverDue = true;
            return this._recover();
        });
    }

    /**
     * Start a new game on the server. The kept values stay, and the next `send values` sends them.
     * @param {object} args The block arguments.
     * @returns {Promise} Resolves when the call has finished.
     */
    startGame (args) {
        return this._start(args, false);
    }

    /**
     * Start the game again after a fail ("Try again"). The same as `startGame`, but the server keeps the facts that the
     * computer told in the old session of this game, so the computer does not tell a story again.
     * @param {object} args The block arguments.
     * @returns {Promise} Resolves when the call has finished.
     */
    startGameAgain (args) {
        return this._start(args, true);
    }

    /**
     * Start a game on the server. The kept values stay, and the next `send values` sends them.
     * @param {object} args The block arguments.
     * @param {boolean} again True for "Try again": the body has `again: true`. False: the body has only the game.
     * @returns {Promise} Resolves when the call has finished.
     */
    _start (args, again) {
        const game = Cast.toString(args.GAME).trim() || 'mars';
        const body = again ? {game, again: true} : {game};
        return this._enqueue('_tail', () => {
            const epoch = this._epoch;
            return this._post(ROUTES.start, body).then(({status, data}) => {
                if (epoch !== this._epoch) return;
                this._status = status;
                if (status !== 200 || !data) return;
                this._game = game;
                this._sentValues = null;
                this._sensors = '';
                this._recoverDue = false;
                this._takeView(data);
                this._clearReply();
            });
        });
    }

    /**
     * Keep a value of the game state. An empty value removes the value. This block makes no call.
     * @param {object} args The block arguments.
     */
    setValue (args) {
        const name = cleanName(args.NAME);
        if (!name) return;
        const value = cleanValue(args.VALUE);
        if (value) {
            this._values.set(name, value);
        } else {
            this._values.delete(name);
        }
    }

    /** Forget all kept values. This block makes no call. */
    clearValues () {
        this._values.clear();
    }

    /**
     * Send all kept values in one `set` event. The server replaces all its values with them.
     * With no kept value there is no call, because the server ignores an empty text.
     * @param {boolean} always False: send only when the text changed since the last send.
     * @returns {Promise} Resolves when the server has answered, or at once when there is no call.
     * @private
     */
    _sendValues (always) {
        return this._enqueueMain(() => {
            const values = this._valuesText();
            if (!values || (!always && values === this._sentValues)) return null;
            return this._eventNow({event: 'set', values}).then(status => {
                if (status === 200) this._sentValues = values;
            });
        });
    }

    /**
     * Send all kept values, when they changed since the last send.
     * @returns {Promise} Resolves when the server has answered, or at once when there is no call.
     */
    sendValues () {
        return this._sendValues(false);
    }

    /**
     * Send all kept values, also when they did not change.
     * @returns {Promise} Resolves when the server has answered.
     */
    sendValuesAlways () {
        return this._sendValues(true);
    }

    /**
     * Name the values with a broken sensor. Empty text repairs all sensors.
     * @param {object} args The block arguments.
     * @returns {Promise} Resolves when the server has answered.
     */
    setSensors (args) {
        const unreliable = Cast.toString(args.SENSORS).trim();
        return this._enqueueMain(() => {
            // The recovery after a new session sends this text again.
            this._sensors = unreliable;
            return this._eventNow({event: 'sensors', unreliable});
        });
    }

    /**
     * Tell the computer that the player is near a station, opened it or left it.
     * @param {object} args The block arguments.
     * @returns {Promise} Resolves when the server has answered.
     */
    look (args) {
        const fields = {
            event: 'look',
            station: Cast.toString(args.STATION).trim(),
            how: Cast.toString(args.HOW).trim()
        };
        return this._enqueue('_stationTail', () => this._eventNow(fields));
    }

    /**
     * Tell the computer what the player did at a station.
     * @param {object} args The block arguments.
     * @returns {Promise} Resolves when the server has answered.
     */
    stationResult (args) {
        const fields = {
            event: 'result',
            station: Cast.toString(args.STATION).trim(),
            values: Cast.toString(args.VALUES).trim()
        };
        return this._enqueue('_stationTail', () => this._eventNow(fields));
    }

    /**
     * Set the role of the computer. The role `none` gives back the role of the situations.
     * @param {object} args The block arguments.
     * @returns {Promise} Resolves when the server has answered.
     */
    setRole (args) {
        const role = Cast.toString(args.ROLE).trim();
        return this._sendEvent({event: 'role', role: role === 'none' ? '' : role});
    }

    /**
     * Tell the computer that the game put it to sleep.
     * @returns {Promise} Resolves when the server has answered.
     */
    sleepComputer () {
        return this._sendEvent({event: 'sleep'});
    }

    /**
     * Wake the computer.
     * @returns {Promise} Resolves when the server has answered.
     */
    wakeComputer () {
        return this._sendEvent({event: 'wake'});
    }

    /**
     * Report a fail with its cause.
     * @param {object} args The block arguments.
     * @returns {Promise} Resolves when the server has answered.
     */
    reportFail (args) {
        return this._sendEvent({event: 'fail', cause: Cast.toString(args.CAUSE)});
    }

    /**
     * Add a line to the memory of the computer.
     * @param {object} args The block arguments.
     * @returns {Promise} Resolves when the server has answered.
     */
    addNote (args) {
        return this._sendEvent({event: 'note', text: Cast.toString(args.TEXT)});
    }

    /**
     * Send the words of the player, with all kept values, and take the reply.
     * Empty text asks the computer to speak first.
     * @param {object} args The block arguments.
     * @returns {Promise} Resolves when the reply is there, or the call has failed.
     */
    tellComputer (args) {
        const text = Cast.toString(args.TEXT);
        this._thinking++;
        return this._enqueueMain(() => {
            // A turn of talk makes the grant of a remark out of date.
            this._view.remark = false;
            const body = {game: this._game, text};
            const values = this._valuesText();
            if (values) body.values = values;
            return this._messageNow(body, true);
        });
    }

    /**
     * Ask for the remark that the last state view granted. A remark has a subject and never a text.
     * With no grant there is no call, and the reply is an empty reply of the kind `silent`.
     * @returns {Promise} Resolves when the reply is there, or the call has failed.
     */
    sayRemark () {
        return this._enqueueMain(() => {
            const view = this._view;
            const remark = view.remark ? view.remarkFor : '';
            // A grant is good for one message.
            view.remark = false;
            if (!remark) {
                this._clearReply('silent');
                return null;
            }
            return this._messageNow({game: this._game, remark}, false);
        });
    }

    /**
     * Read a part of a fact card. This call does not wait for the queue, because it changes no state of the
     * computer.
     * @param {object} args The block arguments.
     * @returns {Promise.<string>} The part, or an empty string when the call failed.
     */
    fact (args) {
        const epoch = this._epoch;
        const part = Cast.toString(args.PART);
        const query = `game=${encodeURIComponent(this._game)}&id=${encodeURIComponent(Cast.toString(args.ID).trim())}`;
        return this._fetch(`${ROUTES.fact}?${query}`, {credentials: 'same-origin'}).then(({status, data}) => {
            if (epoch !== this._epoch) return '';
            this._status = status;
            return status === 200 && data && FACT_PARTS.includes(part) ? textOf(data[part], '') : '';
        });
    }

    /**
     * Get the audio of a line from the server and decode it.
     * @param {object} engine The audio engine.
     * @param {string} text The words of the line.
     * @param {function(): boolean} current Tells if the line is still wanted. An answer for a line that is not
     * wanted is dropped, and it does not change the status.
     * @returns {Promise.<?object>} The sound player of the line, or null when there is no audio to play.
     * @private
     */
    _fetchLine (engine, text, current) {
        return fetchWithTimeout(ROUTES.speak, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({text})
        }, this._timeoutMs)
            .then(response => {
                if (!current()) return null;
                this._status = response.status;
                return response.status === 200 ? response.arrayBuffer() : null;
            })
            .then(buffer => (buffer && current() ? engine.decodeSoundPlayer({data: {buffer}}) : null))
            .then(player => (player && current() ? player : null))
            .catch(() => {
                log.warn(`Mastra API: the line did not play (${ROUTES.speak})`);
                if (current()) this._status = 0;
                return null;
            });
    }

    /**
     * Say a line aloud with the voice of the computer. The server makes the audio, and the audio engine plays it.
     * A new line stops the line before it, so the computer never talks over itself. The block of the line before
     * it ends at once. Each failure ends the block at once.
     * @param {object} args The block arguments.
     * @returns {Promise|undefined} Resolves when the line has finished or has stopped.
     */
    speak (args) {
        this._stopVoice();
        const text = Cast.toString(args.TEXT).trim();
        if (!text) return;
        const engine = this._runtime && this._runtime.audioEngine;
        if (!engine) {
            // A VM with no audio engine (for example a headless VM) makes no call.
            this._status = 0;
            return;
        }
        const lineId = this._lineId;
        const current = () => lineId === this._lineId;
        return new Promise(resolve => {
            this._endLine = resolve;
            this._fetchLine(engine, text, current)
                .then(player => {
                    if (player) return this._play(engine, player);
                })
                .then(() => {
                    if (current()) this._endLine = null;
                    resolve();
                });
        });
    }

    /**
     * Get the audio of a line ready, and do not play it. The block waits until the audio is decoded, or the call
     * has failed. The line that plays now continues. A line that was ready before, or that still waits for its
     * audio, is dropped. The `play voice` block plays the line.
     * @param {object} args The block arguments.
     * @returns {Promise|undefined} Resolves when the audio is ready, or there is no audio.
     */
    loadSpeech (args) {
        this._dropReady();
        const text = Cast.toString(args.TEXT).trim();
        if (!text) return;
        const engine = this._runtime && this._runtime.audioEngine;
        if (!engine) {
            this._status = 0;
            return;
        }
        const loadId = this._loadId;
        const current = () => loadId === this._loadId;
        return new Promise(resolve => {
            this._endLoad = resolve;
            this._fetchLine(engine, text, current).then(player => {
                if (current()) {
                    this._endLoad = null;
                    this._readyPlayer = player;
                }
                resolve();
            });
        });
    }

    /**
     * Play the line that the `get voice ready` block made. It stops the line that plays now. With no line that
     * is ready, the block ends at once.
     * @returns {Promise|undefined} Resolves when the line has finished or has stopped.
     */
    playSpeech () {
        const player = this._readyPlayer;
        this._readyPlayer = null;
        this._stopVoice();
        if (!player) return;
        const lineId = this._lineId;
        return new Promise(resolve => {
            this._endLine = resolve;
            this._play(this._runtime.audioEngine, player).then(() => {
                if (lineId === this._lineId) this._endLine = null;
                resolve();
            });
        });
    }

    /**
     * Play a decoded line.
     * @param {object} engine The audio engine.
     * @param {object} player The sound player of the line.
     * @returns {Promise} Resolves when the line has finished or has stopped.
     * @private
     */
    _play (engine, player) {
        return new Promise(resolve => {
            let timer = null;
            const finish = () => {
                clearTimeout(timer);
                if (this._player === player) this._player = null;
                resolve();
            };
            this._player = player;
            this._playStart = Date.now();
            player.once('stop', finish);
            player.connect(engine);
            player.play();
            timer = setTimeout(() => {
                player.stop();
                finish();
            }, (player.buffer.duration * 1000) + this._speakGraceMs);
        });
    }

    /**
     * Drop the line that is ready, and the line of a `get voice ready` block that waits for its audio. That block
     * ends at once.
     * @private
     */
    _dropReady () {
        this._loadId++;
        const endLoad = this._endLoad;
        this._readyPlayer = null;
        this._endLoad = null;
        if (endLoad) endLoad();
    }

    /**
     * Stop the line that plays, drop each line that waits, and end the blocks of these lines.
     * @private
     */
    _stopVoice () {
        this._dropReady();
        this._lineId++;
        const player = this._player;
        const endLine = this._endLine;
        this._player = null;
        this._endLine = null;
        if (player) player.stop();
        if (endLine) endLine();
    }

    /** Stop the voice of the computer. */
    stopSpeaking () {
        this._stopVoice();
    }

    /** @returns {boolean} True while the voice of the computer plays. */
    isSpeaking () {
        return this._player !== null;
    }

    /** @returns {boolean} True when a line is ready and waits for the `play voice` block. */
    speechReady () {
        return this._readyPlayer !== null;
    }

    /** @returns {number} The length in seconds of the line that is ready, else of the line that plays, else 0. */
    speechLength () {
        const player = this._readyPlayer || this._player;
        return player ? player.buffer.duration : 0;
    }

    /**
     * @returns {number} The seconds since the start of the line that plays, at most its length. 0 when no line
     * plays. The clock of the page gives the time, so it also runs when the audio context is suspended.
     */
    speechTime () {
        const player = this._player;
        if (!player) return 0;
        return Math.min((Date.now() - this._playStart) / 1000, player.buffer.duration);
    }

    /** @returns {string} The words of the last reply. */
    computerSays () {
        return this._reply.say;
    }

    /** @returns {string} The action of the last reply. */
    computerAction () {
        return this._reply.action;
    }

    /** @returns {string} The target of the action of the last reply. */
    actionTarget () {
        return this._reply.target;
    }

    /** @returns {string} The kind of the last reply. */
    replyKind () {
        return this._reply.kind;
    }

    /** @returns {string} The offer of the last reply. */
    openOffer () {
        return this._reply.offer;
    }

    /** @returns {boolean} True when the last reply is out of date. The game must not show it. */
    isStale () {
        return this._reply.stale;
    }

    /** @returns {boolean} True when the server started a new session with the last message. */
    isFresh () {
        return this._reply.fresh;
    }

    /** @returns {boolean} True when the last reply has words that the game must show and speak. */
    replyToShow () {
        const reply = this._reply;
        return reply.say !== '' && reply.kind !== 'silent' && !reply.stale;
    }

    /** @returns {string} The key of the most urgent open situation, or empty text when the base is calm. */
    situation () {
        return this._view.situation;
    }

    /** @returns {number} The hint level of the most urgent situation, 1 to 3, or 0 when the base is calm. */
    hintLevel () {
        return this._view.level;
    }

    /** @returns {string} The role of the computer. */
    computerRole () {
        return this._view.role;
    }

    /** @returns {boolean} True when the computer wants to say a short line now. */
    remarkWanted () {
        return this._view.remark;
    }

    /** @returns {string} The subject of the remark: a situation key or a station id. */
    remarkFor () {
        return this._view.remarkFor;
    }

    /** @returns {string} All kept values as one text, for example `sol=1;power_pct=12`. */
    valuesText () {
        return this._valuesText();
    }

    /** @returns {boolean} True while a message waits for its reply. */
    isThinking () {
        return this._thinking > 0;
    }

    /** @returns {boolean} True when the last reply says that the child needs care. */
    needsCare () {
        return this._reply.care;
    }

    /** @returns {boolean} True when the computer sleeps. */
    isAsleep () {
        return this._view.asleep;
    }

    /** @returns {number} The HTTP status of the last finished call. 0 when the call did not finish. */
    status () {
        return this._status;
    }
}

module.exports = Scratch3MastraBlocks;
