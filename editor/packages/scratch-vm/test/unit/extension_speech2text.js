const test = require('tap').test;
const Runtime = require('../../src/engine/runtime');
const Speech2Text = require('../../src/extensions/scratch3_speech2text/index.js');
const {SpeechDetector} = require('../../src/extensions/scratch3_speech2text/recorder.js');
const {encodeWav, resample} = require('../../src/extensions/scratch3_speech2text/wav.js');
const collab = require('../../src/engine/collab');

const CONTEXT_RATE = 48000;
const BLOCK_SIZE = 2048;
const MAX_RECORDING_MS = 10000;
const MICROPHONE_TIMEOUT_MS = 30000;
const SERVER_TIMEOUT_MS = 20000;

/**
 * Make a sine tone.
 * @param {number} seconds The length.
 * @param {number} frequency The frequency, in Hz.
 * @param {number} amplitude The amplitude. 0 gives silence.
 * @param {number} sampleRate The sample rate, in Hz.
 * @returns {Float32Array} The samples.
 */
const tone = (seconds, frequency, amplitude, sampleRate = CONTEXT_RATE) => {
    const samples = new Float32Array(Math.round(seconds * sampleRate));
    for (let i = 0; i < samples.length; i++) {
        samples[i] = amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate);
    }
    return samples;
};

const silence = seconds => tone(seconds, 0, 0);

/** Audio of a speaker: a short silence, one second of sound, then silence. */
const UTTERANCE = [silence(0.3), tone(1, 440, 0.3), silence(1.5)];

const amplitudeOf = samples => samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);

/**
 * Let the pending promise callbacks run.
 * @returns {Promise} A promise that resolves after them.
 */
const flush = () => new Promise(resolve => setImmediate(resolve));

/**
 * Replace the timers with timers that the test fires. The test gets the real timers back at its end.
 * @param {object} t The test.
 * @returns {{fire: function(number): number}} fire(ms) calls the pending timers of this delay and returns their number.
 */
const fakeTimers = t => {
    const real = {setTimeout: global.setTimeout, clearTimeout: global.clearTimeout};
    const timers = new Map();
    let nextId = 1;
    global.setTimeout = (fn, ms) => {
        timers.set(nextId, {fn, ms});
        return nextId++;
    };
    global.clearTimeout = id => timers.delete(id);
    t.teardown(() => Object.assign(global, real));
    return {
        fire (ms) {
            const due = [...timers].filter(([, timer]) => timer.ms === ms);
            for (const [id, timer] of due) {
                timers.delete(id);
                timer.fn();
            }
            return due.length;
        },
        get pending () {
            return timers.size;
        }
    };
};

/**
 * Make a fake microphone: the media devices and the audio context.
 * @returns {object} The fake microphone. feed() gives audio to the recorder as the browser does.
 */
const makeMicrophone = () => {
    const mic = {
        requests: [],
        tracks: [],
        processor: null,
        connected: 0,
        // The test replaces this function for a denied or a late microphone.
        openStream: () => Promise.resolve(mic.makeStream()),
        makeStream () {
            const track = {stopped: false, stop: () => (track.stopped = true)};
            mic.tracks.push(track);
            return {getTracks: () => [track]};
        },
        mediaDevices: {
            getUserMedia (constraints) {
                mic.requests.push(constraints);
                return mic.openStream();
            }
        },
        audioContext: {
            sampleRate: CONTEXT_RATE,
            state: 'running',
            destination: {},
            createMediaStreamSource: () => ({
                connect: () => mic.connected++,
                disconnect: () => mic.connected--
            }),
            createScriptProcessor (size, inputs, outputs) {
                mic.processorArgs = [size, inputs, outputs];
                mic.processor = {
                    onaudioprocess: null,
                    connect: () => mic.connected++,
                    disconnect: () => mic.connected--
                };
                return mic.processor;
            }
        },
        // Give audio in blocks. The browser uses one array for all blocks.
        feed (...parts) {
            const shared = new Float32Array(BLOCK_SIZE);
            let fed = 0;
            for (const part of parts) {
                for (let i = 0; i + BLOCK_SIZE <= part.length; i += BLOCK_SIZE) {
                    if (!mic.processor.onaudioprocess) return fed;
                    shared.set(part.subarray(i, i + BLOCK_SIZE));
                    mic.processor.onaudioprocess({inputBuffer: {getChannelData: () => shared}});
                    fed += BLOCK_SIZE;
                }
            }
            return fed;
        },
        get open () {
            return mic.tracks.some(track => !track.stopped);
        }
    };
    return mic;
};

/**
 * Make the fake speech route.
 * @returns {object} The fake server. The test sets `reply` for the next call.
 */
const makeServer = () => {
    const server = {
        calls: [],
        reply: () => ({ok: true, status: 200, json: () => Promise.resolve({text: 'hello world'})}),
        fetch (url, init) {
            server.calls.push({url, init});
            return new Promise((resolve, reject) => {
                init.signal.addEventListener('abort', () => reject(new Error('aborted')));
                const reply = server.reply();
                if (reply) resolve(reply);
            });
        }
    };
    return server;
};

const errorReply = status => () => ({ok: false, status, json: () => Promise.resolve({error: 'no'})});

/**
 * Make a runtime with the extension, a fake microphone and a fake server.
 * @param {object} t The test.
 * @returns {object} The parts.
 */
const setup = t => {
    const mic = makeMicrophone();
    const server = makeServer();
    const real = {navigator: Object.getOwnPropertyDescriptor(global, 'navigator'), fetch: global.fetch};
    Object.defineProperty(global, 'navigator', {value: {mediaDevices: mic.mediaDevices}, configurable: true});
    global.fetch = server.fetch;
    t.teardown(() => {
        if (real.navigator) Object.defineProperty(global, 'navigator', real.navigator);
        else delete global.navigator;
        global.fetch = real.fetch;
    });
    const runtime = new Runtime();
    runtime.audioEngine = {audioContext: mic.audioContext};
    const listening = [];
    runtime.on('MIC_LISTENING', value => listening.push(value));
    const ext = new Speech2Text(runtime);
    return {runtime, ext, mic, server, listening};
};

/**
 * Start a "listen and wait" block.
 * @param {Speech2Text} ext The extension.
 * @returns {{done: boolean}} done is true after the block finished.
 */
const listen = ext => {
    const state = {done: false};
    ext.listenAndWait().then(() => (state.done = true));
    return state;
};

/**
 * Read the WAV file of a call of the fake server.
 * @param {object} call The call.
 * @returns {object} The header fields and the samples.
 */
const wavOf = call => {
    const bytes = Buffer.from(JSON.parse(call.init.body).audio, 'base64');
    return {
        bytes,
        riff: bytes.toString('latin1', 0, 4),
        riffSize: bytes.readUInt32LE(4),
        wave: bytes.toString('latin1', 8, 12),
        fmt: bytes.toString('latin1', 12, 16),
        fmtSize: bytes.readUInt32LE(16),
        format: bytes.readUInt16LE(20),
        channels: bytes.readUInt16LE(22),
        sampleRate: bytes.readUInt32LE(24),
        byteRate: bytes.readUInt32LE(28),
        blockAlign: bytes.readUInt16LE(32),
        bits: bytes.readUInt16LE(34),
        data: bytes.toString('latin1', 36, 40),
        dataSize: bytes.readUInt32LE(40),
        samples: new Int16Array(bytes.buffer.slice(bytes.byteOffset + 44, bytes.byteOffset + bytes.length))
    };
};

test('getInfo: the id is speech2text, each block has a method, and the blocks are synced', t => {
    const info = new Speech2Text(new Runtime()).getInfo();
    t.equal(info.id, 'speech2text');
    const opcodes = info.blocks.map(block => block.opcode);
    t.same(opcodes, ['listenAndWait', 'whenIHearHat', 'getSpeech', 'isListening']);
    for (const opcode of opcodes) t.type(Speech2Text.prototype[opcode], 'function', opcode);
    t.same(info.blocks.map(block => block.text), ['listen and wait', 'when I hear [PHRASE]', 'speech', 'listening?']);
    t.ok(collab.BUILTIN_EXTENSIONS.includes('speech2text'));
    t.ok(collab.isSyncedOpcode('speech2text_listenAndWait'));
    t.end();
});

test('listen and wait records until the speaker stops, sends a WAV file and reports the text', async t => {
    const {ext, mic, server, listening} = setup(t);
    const timers = fakeTimers(t);
    t.equal(ext.getSpeech(), '');
    t.equal(ext.isListening(), false);

    const block = listen(ext);
    t.equal(ext.isListening(), false, 'not before the browser gives the microphone');
    await flush();
    t.same(mic.requests, [{audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}}]);
    t.same(mic.processorArgs, [BLOCK_SIZE, 1, 1]);
    t.equal(ext.isListening(), true);
    t.same(listening, [true]);
    t.equal(mic.open, true);

    const fed = mic.feed(...UTTERANCE);
    t.equal(ext.isListening(), false, 'the recording stops after the trailing silence');
    t.same(listening, [true, false]);
    t.equal(mic.open, false, 'the microphone track stopped');
    t.equal(mic.connected, 0, 'the audio nodes are disconnected');
    t.equal(block.done, false, 'the block waits for the server');
    await flush();
    t.equal(block.done, true);
    t.equal(ext.getSpeech(), 'hello world');
    t.equal(timers.pending, 0, 'no timer stays');

    t.equal(server.calls.length, 1);
    const {url, init} = server.calls[0];
    t.equal(url, '/api/speech');
    t.equal(init.method, 'POST');
    t.equal(init.credentials, 'same-origin');
    t.same(init.headers, {'Content-Type': 'application/json'});
    t.same(Object.keys(JSON.parse(init.body)), ['audio']);

    const wav = wavOf(server.calls[0]);
    t.same([wav.riff, wav.wave, wav.fmt, wav.data], ['RIFF', 'WAVE', 'fmt ', 'data']);
    t.same([wav.fmtSize, wav.format, wav.channels, wav.bits], [16, 1, 1, 16]);
    t.same([wav.sampleRate, wav.byteRate, wav.blockAlign], [16000, 32000, 2]);
    t.equal(wav.riffSize, wav.bytes.length - 8);
    t.equal(wav.dataSize, wav.bytes.length - 44);
    // The recorder reads the audio up to the end of the trailing silence of 1 second.
    t.ok(fed > 2.3 * CONTEXT_RATE && fed < 2.4 * CONTEXT_RATE, `${fed} samples`);
    // The WAV file has the silence of 0.3 seconds, the sound of 1 second, and a tail of 0.5 seconds.
    // The recorder finds the sound in blocks of about 43 ms.
    const seconds = wav.samples.length / 16000;
    t.ok(seconds > 1.75 && seconds < 1.85, `${seconds} seconds`);
    // The tone has the amplitude 0.3.
    const peak = amplitudeOf(wav.samples.subarray(0.5 * 16000, 1.2 * 16000)) / 0x7FFF;
    t.ok(Math.abs(peak - 0.3) < 0.01, `peak ${peak}`);
    t.equal(amplitudeOf(wav.samples.subarray(0, 0.2 * 16000)), 0);
});

test('the WAV file has the speech with 0.5 seconds before and after it, and no other silence', async t => {
    const {ext, mic, server} = setup(t);
    fakeTimers(t);
    listen(ext);
    await flush();
    // The speaker starts after 3 seconds. The words start and end with a quiet sound, below the level of speech.
    const quiet = tone(0.3, 440, 0.01);
    mic.feed(silence(3), quiet, tone(1, 440, 0.3), quiet, silence(1.5));
    await flush();
    const wav = wavOf(server.calls[0]);
    const seconds = wav.samples.length / 16000;
    // 1 second of loud sound and 0.5 seconds on each side. The recorder finds the sound in blocks of about 43 ms.
    t.ok(seconds > 1.95 && seconds < 2.05, `${seconds} seconds`);
    const part = (from, to) => amplitudeOf(wav.samples.subarray(from * 16000, to * 16000)) / 0x7FFF;
    t.equal(part(0, 0.1), 0, 'the file starts in the silence before the quiet sound');
    t.ok(Math.abs(part(0.25, 0.45) - 0.01) < 0.001, `the quiet start is in the file: ${part(0.25, 0.45)}`);
    t.ok(Math.abs(part(0.6, 1.4) - 0.3) < 0.01, 'the loud sound is in the file');
    t.ok(Math.abs(part(1.6, 1.8) - 0.01) < 0.001, `the quiet end is in the file: ${part(1.6, 1.8)}`);
    t.equal(part(1.95, seconds), 0, 'the file ends in the silence after the quiet sound');
});

test('silence gives an empty text and no server call', async t => {
    const {ext, mic, server} = setup(t);
    fakeTimers(t);
    const block = listen(ext);
    await flush();
    // Low noise and one click are not speech. The recording ends at 10 seconds of audio.
    const click = tone(0.04, 1000, 0.5);
    const fed = mic.feed(tone(3, 200, 0.004), click, tone(8, 200, 0.004));
    t.ok(fed >= 10 * CONTEXT_RATE && fed < (10 * CONTEXT_RATE) + BLOCK_SIZE, 'the recorder stops at 10 seconds');
    t.equal(mic.open, false);
    await flush();
    t.equal(block.done, true);
    t.equal(ext.getSpeech(), '');
    t.equal(server.calls.length, 0);
});

test('speech with no end stops at 10 seconds, and the WAV file is 10 seconds long', async t => {
    const {ext, mic, server} = setup(t);
    fakeTimers(t);
    const block = listen(ext);
    await flush();
    mic.feed(tone(12, 300, 0.3));
    await flush();
    t.equal(block.done, true);
    t.equal(wavOf(server.calls[0]).samples.length, 160000);
});

test('a microphone that gives no audio stops at the time limit', async t => {
    const {ext, mic, server, listening} = setup(t);
    const timers = fakeTimers(t);
    const block = listen(ext);
    await flush();
    t.equal(timers.fire(MAX_RECORDING_MS), 1);
    await flush();
    t.equal(block.done, true);
    t.equal(mic.open, false);
    t.same(listening, [true, false]);
    t.equal(server.calls.length, 0);
});

test('each error status of the server gives an empty text, and the script continues', async t => {
    const {ext, mic, server} = setup(t);
    fakeTimers(t);
    for (const status of [400, 401, 413, 429, 502, 503]) {
        server.reply = makeServer().reply;
        let block = listen(ext);
        await flush();
        mic.feed(...UTTERANCE);
        await flush();
        t.equal(ext.getSpeech(), 'hello world');

        server.reply = errorReply(status);
        block = listen(ext);
        await flush();
        mic.feed(...UTTERANCE);
        await flush();
        t.equal(block.done, true, `status ${status}`);
        t.equal(ext.getSpeech(), '', `status ${status}`);
        t.equal(mic.open, false);
    }
    t.equal(server.calls.length, 12);
});

test('a network failure and a bad answer give an empty text', async t => {
    const {ext, mic, server} = setup(t);
    fakeTimers(t);
    const replies = [
        () => {
            throw new Error('offline');
        },
        () => ({ok: true, status: 200, json: () => Promise.reject(new Error('no JSON'))}),
        () => ({ok: true, status: 200, json: () => Promise.resolve(null)}),
        () => ({ok: true, status: 200, json: () => Promise.resolve({text: 5})})
    ];
    for (const reply of replies) {
        server.reply = reply;
        const block = listen(ext);
        await flush();
        mic.feed(...UTTERANCE);
        await flush();
        t.equal(block.done, true);
        t.equal(ext.getSpeech(), '');
    }
});

test('a denied microphone gives an empty text and no server call', async t => {
    const {ext, mic, server, listening} = setup(t);
    const timers = fakeTimers(t);
    mic.openStream = () => Promise.reject(Object.assign(new Error('Permission denied'), {name: 'NotAllowedError'}));
    const block = listen(ext);
    await flush();
    t.equal(block.done, true);
    t.equal(ext.getSpeech(), '');
    t.same(listening, []);
    t.equal(server.calls.length, 0);
    t.equal(timers.pending, 0);
});

test('a browser with no microphone API or no audio engine gives an empty text', async t => {
    const {ext, runtime, mic} = setup(t);
    runtime.audioEngine = null;
    let block = listen(ext);
    await flush();
    t.equal(block.done, true);
    t.same(mic.requests, []);

    runtime.audioEngine = {audioContext: mic.audioContext};
    Object.defineProperty(global, 'navigator', {value: {}, configurable: true});
    block = listen(ext);
    await flush();
    t.equal(block.done, true);
    t.equal(ext.getSpeech(), '');
});

test('a permission question with no answer ends at the time limit, and a late microphone is released', async t => {
    const {ext, mic, server, listening} = setup(t);
    const timers = fakeTimers(t);
    let giveStream;
    mic.openStream = () => new Promise(resolve => (giveStream = () => resolve(mic.makeStream())));
    const block = listen(ext);
    await flush();
    t.equal(block.done, false);
    t.equal(timers.fire(MICROPHONE_TIMEOUT_MS), 1);
    await flush();
    t.equal(block.done, true);
    t.equal(ext.getSpeech(), '');

    giveStream();
    await flush();
    t.equal(mic.tracks.length, 1);
    t.equal(mic.open, false);
    t.same(listening, []);
    t.equal(server.calls.length, 0);
});

test('a server that does not answer ends at the time limit', async t => {
    const {ext, mic, server} = setup(t);
    const timers = fakeTimers(t);
    server.reply = () => null;
    const block = listen(ext);
    await flush();
    mic.feed(...UTTERANCE);
    await flush();
    t.equal(block.done, false);
    t.equal(server.calls.length, 1);
    t.equal(timers.fire(SERVER_TIMEOUT_MS), 1);
    await flush();
    t.equal(server.calls[0].init.signal.aborted, true);
    t.equal(block.done, true);
    t.equal(ext.getSpeech(), '');
});

test('stop all while the microphone records releases the microphone and sends nothing', async t => {
    const {ext, runtime, mic, server, listening} = setup(t);
    const timers = fakeTimers(t);
    const block = listen(ext);
    await flush();
    mic.feed(silence(0.3), tone(1, 440, 0.3));
    t.equal(mic.open, true);
    runtime.stopAll();
    t.equal(mic.open, false);
    t.equal(mic.connected, 0);
    t.equal(ext.isListening(), false);
    t.same(listening, [true, false]);
    await flush();
    t.equal(block.done, true);
    t.equal(ext.getSpeech(), '');
    t.equal(server.calls.length, 0);
    t.equal(timers.pending, 0);

    // The next block listens again.
    const next = listen(ext);
    await flush();
    mic.feed(...UTTERANCE);
    await flush();
    t.equal(next.done, true);
    t.equal(ext.getSpeech(), 'hello world');
});

test('stop all during the permission question releases the late microphone', async t => {
    const {ext, runtime, mic, listening} = setup(t);
    fakeTimers(t);
    let giveStream;
    mic.openStream = () => new Promise(resolve => (giveStream = () => resolve(mic.makeStream())));
    const block = listen(ext);
    await flush();
    runtime.stopAll();
    await flush();
    t.equal(block.done, true);
    giveStream();
    await flush();
    t.equal(mic.tracks.length, 1);
    t.equal(mic.open, false);
    t.same(listening, []);
});

test('stop all during the server call stops the call, and its late answer changes nothing', async t => {
    const {ext, runtime, mic, server} = setup(t);
    fakeTimers(t);
    let answer;
    server.reply = () => ({ok: true, status: 200, json: () => new Promise(resolve => (answer = resolve))});
    const block = listen(ext);
    await flush();
    mic.feed(...UTTERANCE);
    await flush();
    t.equal(block.done, false);
    runtime.stopAll();
    await flush();
    t.equal(server.calls[0].init.signal.aborted, true);
    t.equal(block.done, true);
    answer({text: 'too late'});
    await flush();
    t.equal(ext.getSpeech(), '');
});

test('blocks that start while another block listens share one recording', async t => {
    const {ext, mic, server} = setup(t);
    fakeTimers(t);
    const first = listen(ext);
    await flush();
    const second = listen(ext);
    await flush();
    mic.feed(...UTTERANCE);
    const third = listen(ext);
    await flush();
    t.same([first.done, second.done, third.done], [true, true, true]);
    t.equal(mic.requests.length, 1);
    t.equal(server.calls.length, 1);
});

test('when I hear starts on the text of listen and wait only', async t => {
    const {ext, runtime, mic, server} = setup(t);
    fakeTimers(t);
    server.reply = () => ({ok: true, status: 200, json: () => Promise.resolve({text: ' OK. Let\'s go,  now! '})});
    t.equal(ext.whenIHearHat({PHRASE: 'let\'s go'}), false);
    listen(ext);
    await flush();
    mic.feed(...UTTERANCE);
    await flush();
    t.equal(ext.getSpeech(), 'OK. Let\'s go,  now!');
    t.equal(ext.whenIHearHat({PHRASE: 'let\'s go'}), true);
    t.equal(ext.whenIHearHat({PHRASE: 'LETS GO NOW'}), true);
    t.equal(ext.whenIHearHat({PHRASE: 'ok'}), true);
    t.equal(ext.whenIHearHat({PHRASE: 'stop'}), false);
    t.equal(ext.whenIHearHat({PHRASE: ''}), false);
    t.equal(ext.whenIHearHat({PHRASE: '?!'}), false);

    // The hat is false while the next block listens, so the same words start it again.
    listen(ext);
    t.equal(ext.whenIHearHat({PHRASE: 'let\'s go'}), false);
    await flush();
    mic.feed(...UTTERANCE);
    await flush();
    t.equal(ext.whenIHearHat({PHRASE: 'let\'s go'}), true);

    // The green flag resets the hat. The speech block keeps its text.
    runtime.emit('PROJECT_START');
    t.equal(ext.whenIHearHat({PHRASE: 'let\'s go'}), false);
    t.equal(ext.getSpeech(), 'OK. Let\'s go,  now!');
});

test('SpeechDetector: speech starts after 0.1 seconds of sound and ends after 1 second of silence', t => {
    const feed = (detector, samples, size = 480) => {
        for (let i = 0; i + size <= samples.length; i += size) detector.add(samples.subarray(i, i + size));
    };
    const detector = new SpeechDetector(CONTEXT_RATE);
    feed(detector, silence(0.5));
    t.same([detector.heardSpeech, detector.ended], [false, false]);
    feed(detector, tone(0.05, 440, 0.5));
    feed(detector, silence(2));
    t.same([detector.heardSpeech, detector.ended], [false, false], 'a click is not speech');
    feed(detector, tone(0.2, 440, 0.2));
    t.same([detector.heardSpeech, detector.ended], [true, false]);
    // The speech starts at 2.55 seconds, after the silence and the click.
    t.same([detector.speechStart, detector.speechEnd], [122400, 132000]);
    feed(detector, silence(0.9));
    feed(detector, tone(0.2, 440, 0.2));
    feed(detector, silence(0.9));
    t.equal(detector.ended, false, 'a pause of less than 1 second does not end the speech');
    feed(detector, silence(0.2));
    t.equal(detector.ended, true);
    // The range has both parts of the speech and the pause between them, with 0.5 seconds on each side.
    t.same([detector.speechStart, detector.speechEnd], [122400, 184800]);
    t.same(detector.speechRange, {start: 98400, end: 208800});

    // The detector follows the noise of a room, and speech is louder than 3 times the noise.
    const noisy = new SpeechDetector(CONTEXT_RATE);
    feed(noisy, tone(3, 200, 0.03));
    t.equal(noisy.heardSpeech, false, 'constant noise is not speech');
    feed(noisy, tone(0.5, 200, 0.05));
    t.equal(noisy.heardSpeech, false);
    feed(noisy, tone(0.5, 200, 0.3));
    t.equal(noisy.heardSpeech, true);
    feed(noisy, tone(1.1, 200, 0.03));
    t.equal(noisy.ended, true);

    // A speaker who talks from the first block: the detector finds the speech after the first pause.
    const early = new SpeechDetector(CONTEXT_RATE);
    feed(early, tone(0.5, 200, 0.3));
    feed(early, silence(0.2));
    feed(early, tone(0.5, 200, 0.3));
    t.equal(early.heardSpeech, true);
    // The range stays in the audio: it starts at 0, and it ends at the last sample.
    t.same(early.speechRange, {start: 0, end: 57600});
    t.end();
});

test('encodeWav writes a mono 16-bit PCM header and the samples', t => {
    const bytes = Buffer.from(encodeWav(Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]), 16000));
    t.equal(bytes.length, 44 + 14);
    t.equal(bytes.toString('latin1', 0, 4), 'RIFF');
    t.equal(bytes.readUInt32LE(4), 36 + 14);
    t.equal(bytes.toString('latin1', 8, 16), 'WAVEfmt ');
    t.equal(bytes.readUInt32LE(16), 16);
    t.equal(bytes.readUInt16LE(20), 1, 'PCM');
    t.equal(bytes.readUInt16LE(22), 1, 'mono');
    t.equal(bytes.readUInt32LE(24), 16000);
    t.equal(bytes.readUInt32LE(28), 32000);
    t.equal(bytes.readUInt16LE(32), 2);
    t.equal(bytes.readUInt16LE(34), 16);
    t.equal(bytes.toString('latin1', 36, 40), 'data');
    t.equal(bytes.readUInt32LE(40), 14);
    const samples = [];
    for (let i = 44; i < bytes.length; i += 2) samples.push(bytes.readInt16LE(i));
    t.same(samples, [0, 16384, -16383, 32767, -32767, 32767, -32767]);

    const other = Buffer.from(encodeWav(new Float32Array(0), 44100));
    t.equal(other.length, 44);
    t.equal(other.readUInt32LE(24), 44100);
    t.equal(other.readUInt32LE(28), 88200);
    t.end();
});

test('resample changes the rate, keeps speech frequencies and removes frequencies above the new limit', t => {
    const same = tone(0.1, 440, 0.5, 16000);
    t.equal(resample(same, 16000, 16000), same);

    t.equal(resample(tone(1, 440, 0.5, 48000), 48000, 16000).length, 16000);
    t.equal(resample(tone(1, 440, 0.5, 44100), 44100, 16000).length, 16000);
    t.equal(resample(tone(0.5, 440, 0.5, 8000), 8000, 16000).length, 8000);
    t.equal(resample(new Float32Array(0), 48000, 16000).length, 0);

    for (const rate of [48000, 44100, 8000]) {
        // A tone of 1000 Hz keeps its amplitude and its frequency.
        const out = resample(tone(1, 1000, 0.5, rate), rate, 16000);
        const middle = out.subarray(1000, 15000);
        t.ok(Math.abs(amplitudeOf(middle) - 0.5) < 0.03, `amplitude ${amplitudeOf(middle)} from ${rate} Hz`);
        let crossings = 0;
        for (let i = 1; i < middle.length; i++) {
            if (middle[i - 1] < 0 && middle[i] >= 0) crossings++;
        }
        t.ok(Math.abs(crossings - 875) <= 1, `${crossings} periods in 0.875 seconds from ${rate} Hz`);
    }

    // 16000 Hz holds frequencies up to 8000 Hz. A tone of 12000 Hz does not come through as a false tone.
    const high = resample(tone(1, 12000, 0.5, 48000), 48000, 16000);
    t.ok(amplitudeOf(high.subarray(1000, 15000)) < 0.01, `amplitude ${amplitudeOf(high)}`);
    t.end();
});
