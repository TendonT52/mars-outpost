/**
 * The microphone settings. The browser removes echo and noise, and it adjusts the level.
 * @type {object}
 */
const CONSTRAINTS = {audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}};

/**
 * The number of samples of each block of microphone audio.
 * @type {number}
 */
const BLOCK_SIZE = 2048;

/**
 * The longest recording, in seconds. The speech server accepts 15 seconds.
 * @type {number}
 */
const MAX_RECORDING_SECONDS = 10;

/**
 * The longest time between the microphone request and the start of the recording, in milliseconds.
 * The person uses this time to answer the permission question of the browser.
 * @type {number}
 */
const MICROPHONE_TIMEOUT_MS = 30000;

/**
 * The lowest level (RMS, 0 to 1) that counts as speech.
 * @type {number}
 */
const MIN_SPEECH_LEVEL = 0.01;

/**
 * Speech is this many times louder than the background noise.
 * @type {number}
 */
const SPEECH_TO_NOISE = 3;

/**
 * The highest background noise level (RMS, 0 to 1) that the detector follows.
 * @type {number}
 */
const MAX_NOISE_LEVEL = 0.03;

/**
 * The time in which the noise level follows louder background noise, in seconds.
 * @type {number}
 */
const NOISE_RISE_SECONDS = 1;

/**
 * Sound must be loud for this time without a stop to count as speech, in seconds. A click is shorter.
 * @type {number}
 */
const MIN_SPEECH_SECONDS = 0.1;

/**
 * The speaker stopped when the sound after speech is quiet for this time, in seconds.
 * This wait is the largest fixed delay between the last word and the answer.
 * A shorter time gives a faster answer, but it cuts a speaker who stops to think in the middle of a sentence.
 * Children make such pauses more than adults, and we have no recordings of children that show a shorter time is safe.
 * @type {number}
 */
const END_SILENCE_SECONDS = 1;

/**
 * The recording keeps this much audio before the first loud block of speech, in seconds.
 * A word can start with a quiet sound, for example "f", "h" or "s", or with a quiet short word.
 * In a test with quiet voices, speech started up to 0.36 seconds before the first loud block.
 * @type {number}
 */
const PRE_ROLL_SECONDS = 0.5;

/**
 * The recording keeps this much audio after the last loud block of speech, in seconds.
 * A word can end with a quiet sound. In the same test, speech ended up to 0.27 seconds after the last loud block.
 * @type {number}
 */
const TAIL_SECONDS = 0.5;

/**
 * Finds speech and the end of speech in microphone audio, from the level of each block.
 * It follows the level of the background noise, so that a noisy room does not count as speech.
 */
class SpeechDetector {
    /**
     * @param {number} sampleRate The sample rate of the audio, in Hz.
     */
    constructor (sampleRate) {
        this._sampleRate = sampleRate;
        this._noise = null;
        this._loudSeconds = 0;
        this._quietSeconds = 0;
        this._length = 0;
        this._loudStart = 0;

        /**
         * True after the detector heard speech.
         * @type {boolean}
         */
        this.heardSpeech = false;

        /**
         * The position of the first sample of the first loud block of speech. 0 before speech.
         * @type {number}
         */
        this.speechStart = 0;

        /**
         * The position after the last sample of the last loud block of speech. 0 before speech.
         * @type {number}
         */
        this.speechEnd = 0;

        /**
         * True when the speaker stopped after speech.
         * @type {boolean}
         */
        this.ended = false;
    }

    /**
     * The part of the audio that has the speech, with the pre-roll and the tail.
     * The silence before and after this part has no words, and it makes the server call slower.
     * @returns {{start: number, end: number}} The positions of the first sample and after the last sample.
     */
    get speechRange () {
        return {
            start: Math.max(0, this.speechStart - Math.round(PRE_ROLL_SECONDS * this._sampleRate)),
            end: Math.min(this._length, this.speechEnd + Math.round(TAIL_SECONDS * this._sampleRate))
        };
    }

    /**
     * Examine the next block of audio.
     * @param {Float32Array} samples The samples of the block.
     */
    add (samples) {
        if (samples.length === 0) return;
        let squares = 0;
        for (let i = 0; i < samples.length; i++) squares += samples[i] * samples[i];
        const level = Math.sqrt(squares / samples.length);
        const seconds = samples.length / this._sampleRate;

        if (this._noise === null) this._noise = Math.min(level, MAX_NOISE_LEVEL);
        const loud = level > Math.max(MIN_SPEECH_LEVEL, this._noise * SPEECH_TO_NOISE);
        if (level < this._noise) {
            this._noise = level;
        } else if (!loud) {
            const rise = Math.min(1, seconds / NOISE_RISE_SECONDS);
            this._noise += (Math.min(level, MAX_NOISE_LEVEL) - this._noise) * rise;
        }

        const blockStart = this._length;
        this._length += samples.length;
        if (loud) {
            if (this._loudSeconds === 0) this._loudStart = blockStart;
            this._loudSeconds += seconds;
            this._quietSeconds = 0;
            if (!this.heardSpeech && this._loudSeconds >= MIN_SPEECH_SECONDS) {
                this.heardSpeech = true;
                this.speechStart = this._loudStart;
            }
            if (this.heardSpeech) this.speechEnd = this._length;
        } else {
            this._loudSeconds = 0;
            this._quietSeconds += seconds;
            if (this.heardSpeech && this._quietSeconds >= END_SILENCE_SECONDS) this.ended = true;
        }
    }
}

/**
 * @typedef {object} Recording
 * @property {Float32Array} samples - the mono samples.
 * @property {number} sampleRate - the sample rate, in Hz.
 */

/**
 * Records one utterance from the microphone. The recording stops when the speaker stops,
 * at the longest recording time, or on a call of stop(). The recording has the speech only,
 * with a short time before and after it. The audio stays in memory only.
 * A recorder makes one recording.
 */
class Recorder {
    /**
     * @param {AudioContext} audioContext The audio context that reads the microphone.
     * @param {MediaDevices} mediaDevices The media devices of the browser.
     * @param {function(boolean)} onListening Called with true when the recording starts and with false when it stops.
     */
    constructor (audioContext, mediaDevices, onListening) {
        this._audioContext = audioContext;
        this._mediaDevices = mediaDevices;
        this._onListening = onListening;
        this._detector = new SpeechDetector(audioContext.sampleRate);
        this._blocks = [];
        this._length = 0;
        this._stream = null;
        this._source = null;
        this._processor = null;
        this._timer = null;
        this._released = false;
        this._finish = null;
    }

    /**
     * Ask for the microphone and record.
     * @returns {Promise.<?Recording>} The recording, or null when the recorder heard no speech.
     *     The promise rejects when the browser gives no microphone.
     */
    record () {
        return new Promise((resolve, reject) => {
            this._finish = recording => {
                this._release();
                resolve(recording);
            };
            this._timer = setTimeout(() => {
                this._release();
                reject(new Error(`The microphone did not start in ${MICROPHONE_TIMEOUT_MS} ms`));
            }, MICROPHONE_TIMEOUT_MS);
            this._mediaDevices.getUserMedia(CONSTRAINTS).then(stream => {
                if (this._released) {
                    // The recorder stopped while the browser asked for the permission.
                    stream.getTracks().forEach(track => track.stop());
                    return;
                }
                this._start(stream);
            }, err => {
                this._release();
                reject(err);
            });
        });
    }

    /**
     * Stop and release the microphone. The promise of record() resolves with null.
     */
    stop () {
        if (this._finish) this._finish(null);
    }

    /**
     * Connect the microphone and start the time limit of the recording.
     * @param {MediaStream} stream The microphone stream.
     * @private
     */
    _start (stream) {
        clearTimeout(this._timer);
        const context = this._audioContext;
        this._stream = stream;
        // A browser can suspend an audio context that plays no sound.
        if (context.state === 'suspended') context.resume();
        this._source = context.createMediaStreamSource(stream);
        this._processor = context.createScriptProcessor(BLOCK_SIZE, 1, 1);
        this._processor.onaudioprocess = event => this._addBlock(event.inputBuffer.getChannelData(0));
        this._source.connect(this._processor);
        // The processor gets audio only when it has a destination. Its output is silence.
        this._processor.connect(context.destination);
        // The clock limit also ends a recording for which the browser gives no audio.
        this._timer = setTimeout(() => this._end(), MAX_RECORDING_SECONDS * 1000);
        this._onListening(true);
    }

    /**
     * Keep a block of microphone audio, and finish at the end of speech or at the longest recording.
     * @param {Float32Array} samples The samples of the block. The browser uses the array again.
     * @private
     */
    _addBlock (samples) {
        const room = (MAX_RECORDING_SECONDS * this._audioContext.sampleRate) - this._length;
        const block = samples.slice(0, room);
        this._blocks.push(block);
        this._length += block.length;
        this._detector.add(block);
        if (this._detector.ended || block.length < samples.length) this._end();
    }

    /**
     * Finish with the speech of the recorded audio as one array, or with null when the recorder heard no speech.
     * @private
     */
    _end () {
        if (!this._detector.heardSpeech) {
            this._finish(null);
            return;
        }
        const samples = new Float32Array(this._length);
        let offset = 0;
        for (const block of this._blocks) {
            samples.set(block, offset);
            offset += block.length;
        }
        const {start, end} = this._detector.speechRange;
        this._finish({samples: samples.subarray(start, end), sampleRate: this._audioContext.sampleRate});
    }

    /**
     * Release the microphone, so that the browser shows no recording any more.
     * @private
     */
    _release () {
        if (this._released) return;
        this._released = true;
        clearTimeout(this._timer);
        if (!this._stream) return;
        this._processor.onaudioprocess = null;
        this._source.disconnect();
        this._processor.disconnect();
        this._stream.getTracks().forEach(track => track.stop());
        this._onListening(false);
    }
}

module.exports = {Recorder, SpeechDetector, MAX_RECORDING_SECONDS, MICROPHONE_TIMEOUT_MS};
