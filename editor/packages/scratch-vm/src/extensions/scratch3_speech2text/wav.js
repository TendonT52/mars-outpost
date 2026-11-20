/**
 * The number of filter taps on each side of the center tap, for each source sample of one output sample.
 * @type {number}
 */
const TAPS_PER_STEP = 8;

/**
 * Remove the frequencies above a limit, with a windowed-sinc filter.
 * @param {Float32Array} samples The samples.
 * @param {number} cutoff The limit, as a part of the sample rate (0 to 0.5).
 * @param {number} halfWidth The number of taps on each side of the center tap.
 * @returns {Float32Array} The filtered samples.
 */
const lowPass = (samples, cutoff, halfWidth) => {
    const kernel = new Float32Array((2 * halfWidth) + 1);
    let sum = 0;
    for (let i = -halfWidth; i <= halfWidth; i++) {
        const sinc = i === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * i) / (Math.PI * i);
        // A Hamming window.
        const tap = sinc * (0.54 + (0.46 * Math.cos(Math.PI * i / halfWidth)));
        kernel[i + halfWidth] = tap;
        sum += tap;
    }
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        const from = Math.max(0, i - halfWidth);
        const to = Math.min(samples.length - 1, i + halfWidth);
        let value = 0;
        for (let j = from; j <= to; j++) value += samples[j] * kernel[j - i + halfWidth];
        out[i] = value / sum;
    }
    return out;
};

/**
 * Change the sample rate of mono audio.
 * For a lower rate, a low-pass filter first removes the frequencies that the new rate cannot hold.
 * @param {Float32Array} samples The samples.
 * @param {number} fromRate The sample rate of the samples, in Hz.
 * @param {number} toRate The new sample rate, in Hz.
 * @returns {Float32Array} The samples at the new sample rate.
 */
const resample = (samples, fromRate, toRate) => {
    if (fromRate === toRate) return samples;
    const step = fromRate / toRate;
    const source = step > 1 ? lowPass(samples, 0.45 / step, Math.ceil(TAPS_PER_STEP * step)) : samples;
    const out = new Float32Array(Math.round(samples.length / step));
    const last = source.length - 1;
    for (let i = 0; i < out.length; i++) {
        const position = Math.min(i * step, last);
        const index = Math.floor(position);
        const next = Math.min(index + 1, last);
        out[i] = source[index] + ((source[next] - source[index]) * (position - index));
    }
    return out;
};

/**
 * Make a WAV file with mono 16-bit PCM audio.
 * @param {Float32Array} samples The samples, from -1 to 1. A sample outside of these limits gets the limit.
 * @param {number} sampleRate The sample rate, in Hz.
 * @returns {Uint8Array} The bytes of the WAV file.
 */
const encodeWav = (samples, sampleRate) => {
    const HEADER_BYTES = 44;
    const BYTES_PER_SAMPLE = 2;
    const dataBytes = samples.length * BYTES_PER_SAMPLE;
    const view = new DataView(new ArrayBuffer(HEADER_BYTES + dataBytes));
    const writeText = (offset, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeText(0, 'RIFF');
    view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    // The size of the format chunk.
    view.setUint32(16, 16, true);
    // The format: PCM.
    view.setUint16(20, 1, true);
    // The number of channels.
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    // The bytes for each second.
    view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true);
    // The bytes for each sample of all channels.
    view.setUint16(32, BYTES_PER_SAMPLE, true);
    // The bits for each sample.
    view.setUint16(34, 8 * BYTES_PER_SAMPLE, true);
    writeText(36, 'data');
    view.setUint32(40, dataBytes, true);
    for (let i = 0; i < samples.length; i++) {
        const sample = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(HEADER_BYTES + (i * BYTES_PER_SAMPLE), Math.round(sample * 0x7FFF), true);
    }
    return new Uint8Array(view.buffer);
};

module.exports = {encodeWav, resample};
