const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');
const Base64Util = require('../../util/base64-util');
const Cast = require('../../util/cast');
const log = require('../../util/log');
const formatMessage = require('format-message');
const {Recorder} = require('./recorder');
const {encodeWav, resample} = require('./wav');

/**
 * Make an icon with a microphone, encoded as a data URI.
 * @param {string} color The color of the icon.
 * @returns {string} The data URI of the icon.
 */
const makeIconURI = color => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">' +
        `<rect x="14.5" y="4" width="11" height="20" rx="5.5" fill="${color}"/>` +
        `<path d="M9 18a11 11 0 0 0 22 0M20 29v6M13.5 35h13" fill="none" stroke="${color}" ` +
        'stroke-width="3.5" stroke-linecap="round"/>' +
        '</svg>';
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
 * The speech route of the server. It takes a WAV file and gives the recognised words.
 * @type {string}
 */
const SPEECH_URL = '/api/speech';

/**
 * The sample rate of the WAV file for the server, in Hz.
 * @type {number}
 */
const WAV_SAMPLE_RATE = 16000;

/**
 * The longest time to wait for the answer of the server, in milliseconds.
 * @type {number}
 */
const SERVER_TIMEOUT_MS = 20000;

/**
 * Make a text simple to compare: lower case, no punctuation, single spaces.
 * @param {string|number|boolean} text The text.
 * @returns {string} The simple text.
 */
const simplify = text => Cast.toString(text).toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Blocks that record speech from the microphone and get the words from the speech route of the server.
 * The microphone is open only while a "listen and wait" block records.
 * The audio goes only to the server. The text is run-time state of this browser.
 */
class Scratch3Speech2TextBlocks {
    /**
     * @param {object} runtime The runtime instantiating this block package.
     */
    constructor (runtime) {
        this.runtime = runtime;

        /**
         * The text of the last "listen and wait" block. The "speech" block reports it.
         * @type {string}
         */
        this._speech = '';

        /**
         * The simple form of the text for the "when I hear" blocks. It is empty while a
         * "listen and wait" block listens, so that the same words start the hat blocks again.
         * @type {string}
         */
        this._heard = '';

        /**
         * True while the microphone records.
         * @type {boolean}
         */
        this._listening = false;

        /**
         * The current recognition: its recorder and its server call. Null when no block listens.
         * @type {?{recorder: ?Recorder, abort: ?AbortController}}
         */
        this._session = null;

        /**
         * The resolve functions of the "listen and wait" blocks that wait for the current recognition.
         * @type {Array.<function(): void>}
         */
        this._waiting = [];

        this.runtime.on('PROJECT_STOP_ALL', this._stop.bind(this));
        this.runtime.on('PROJECT_START', () => {
            this._heard = '';
        });
    }

    /**
     * @returns {object} Metadata for this extension and its blocks.
     */
    getInfo () {
        return {
            id: 'speech2text',
            name: formatMessage({
                id: 'speech.extensionName',
                default: 'Speech to Text',
                description: 'Name of extension that adds speech recognition blocks.'
            }),
            menuIconURI: menuIconURI,
            blockIconURI: blockIconURI,
            blocks: [
                {
                    opcode: 'listenAndWait',
                    text: formatMessage({
                        id: 'speech.listenAndWait',
                        default: 'listen and wait',
                        description: 'Start listening to the microphone and wait for the recognized words.'
                    }),
                    blockType: BlockType.COMMAND
                },
                {
                    opcode: 'whenIHearHat',
                    text: formatMessage({
                        id: 'speech.whenIHear',
                        default: 'when I hear [PHRASE]',
                        description: 'Event that triggers when the recognized words contain the text on the block.'
                    }),
                    blockType: BlockType.HAT,
                    arguments: {
                        PHRASE: {
                            type: ArgumentType.STRING,
                            defaultValue: formatMessage({
                                id: 'speech.defaultWhenIHearValue',
                                default: 'let\'s go',
                                description: 'The default phrase/word that, when heard, triggers the event.'
                            })
                        }
                    }
                },
                {
                    opcode: 'getSpeech',
                    text: formatMessage({
                        id: 'speech.speechReporter',
                        default: 'speech',
                        description: 'Get the text of spoken words transcribed by the speech recognition system.'
                    }),
                    blockType: BlockType.REPORTER
                },
                {
                    opcode: 'isListening',
                    text: formatMessage({
                        id: 'speech.listening',
                        default: 'listening?',
                        description: 'Reports whether the microphone records speech at this time.'
                    }),
                    blockType: BlockType.BOOLEAN
                }
            ]
        };
    }

    /**
     * Record speech from the microphone and get its text. Blocks that start while another block
     * listens wait for the same text.
     * @returns {Promise} A promise that resolves when the text is ready, also when it is empty.
     */
    listenAndWait () {
        return new Promise(resolve => {
            this._waiting.push(resolve);
            if (!this._session) this._listen();
        });
    }

    /**
     * An edge triggered hat block. It starts when the text of a "listen and wait" block contains the phrase.
     * @param {object} args - the block arguments.
     * @property {string} PHRASE - the phrase.
     * @returns {boolean} true if the text contains the phrase.
     */
    whenIHearHat (args) {
        const phrase = simplify(args.PHRASE);
        return phrase !== '' && this._heard.includes(phrase);
    }

    /**
     * @returns {string} The text of the last "listen and wait" block. It is empty when the block heard no words.
     */
    getSpeech () {
        return this._speech;
    }

    /**
     * @returns {boolean} true while the microphone records.
     */
    isListening () {
        return this._listening;
    }

    /**
     * Start a recognition. Each failure gives an empty text.
     * @private
     */
    _listen () {
        const session = {recorder: null, abort: null};
        this._session = session;
        this._speech = '';
        this._heard = '';
        new Promise(resolve => resolve(this._recognize(session)))
            .catch(err => {
                if (this._session === session) log.warn(`speech2text: no text. ${err}`);
                return '';
            })
            .then(text => {
                if (this._session === session) this._finish(text);
            });
    }

    /**
     * Record speech and get its text from the server.
     * @param {object} session The recognition.
     * @returns {Promise.<string>} The text. It is empty when the recorder heard no speech.
     * @private
     */
    _recognize (session) {
        const mediaDevices = typeof navigator === 'undefined' ? null : navigator.mediaDevices;
        const audioEngine = this.runtime.audioEngine;
        if (!mediaDevices || !audioEngine) return Promise.reject(new Error('There is no microphone.'));
        session.recorder = new Recorder(audioEngine.audioContext, mediaDevices, listening => {
            this._listening = listening;
            this.runtime.emitMicListening(listening);
        });
        return session.recorder.record().then(recording => {
            // No speech, or the project stopped: the server gets nothing.
            if (!recording || this._session !== session) return '';
            return this._send(recording, session);
        });
    }

    /**
     * Send a recording to the speech route of the server.
     * @param {{samples: Float32Array, sampleRate: number}} recording The recording.
     * @param {object} session The recognition.
     * @returns {Promise.<string>} The recognised words.
     * @private
     */
    _send (recording, session) {
        const wav = encodeWav(resample(recording.samples, recording.sampleRate, WAV_SAMPLE_RATE), WAV_SAMPLE_RATE);
        session.abort = new AbortController();
        const timer = setTimeout(() => session.abort.abort(), SERVER_TIMEOUT_MS);
        return fetch(SPEECH_URL, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({audio: Base64Util.arrayBufferToBase64(wav.buffer)}),
            signal: session.abort.signal
        })
            .then(response => {
                if (!response.ok) throw new Error(`The speech route answered with status ${response.status}.`);
                return response.json();
            })
            .then(reply => (reply && typeof reply.text === 'string' ? reply.text.trim() : ''))
            .finally(() => clearTimeout(timer));
    }

    /**
     * Give the text to the blocks and let the waiting scripts continue.
     * @param {string} text The recognised words, or an empty string.
     * @private
     */
    _finish (text) {
        this._session = null;
        this._speech = text;
        this._heard = simplify(text);
        const waiting = this._waiting;
        this._waiting = [];
        waiting.forEach(resolve => resolve());
    }

    /**
     * Stop the current recognition: release the microphone, stop the server call and
     * let the waiting scripts continue with an empty text.
     * @private
     */
    _stop () {
        const session = this._session;
        if (!session) return;
        if (session.recorder) session.recorder.stop();
        if (session.abort) session.abort.abort();
        this._finish('');
    }
}

module.exports = Scratch3Speech2TextBlocks;
