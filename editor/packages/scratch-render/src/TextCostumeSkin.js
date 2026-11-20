const twgl = require('twgl.js');
const getFonts = require('scratch-render-fonts');

const CanvasMeasurementProvider = require('./util/canvas-measurement-provider');
const ShaderManager = require('./ShaderManager');
const Skin = require('./Skin');
const TextWrapper = require('./util/text-wrapper');

/**
 * The largest width or height of a rendered text, in canvas pixels.
 * A larger text renders at a smaller scale.
 * @constant {number}
 */
const MAX_TEXTURE_DIMENSION = 2048;

/**
 * The number of rendered scales that the skin keeps. The renderer asks for one scale when it draws and for
 * the native scale when it does a touching query. Two textures make sure that these requests do not render
 * the text again on each frame.
 * @constant {number}
 */
const MAX_TEXTURES = 2;

/**
 * The height of a line, as a proportion of the font size.
 * @constant {number}
 */
const LINE_HEIGHT_RATIO = 1.25;

/**
 * The space around the text box, as a proportion of the font size.
 * It keeps glyphs that go out of their line box (for example in a handwriting font) inside the canvas.
 * @constant {number}
 */
const PADDING_RATIO = 0.25;

/**
 * The CSS font family list of each font of the paint editor. The generic family is the fallback while the
 * font loads.
 * @type {{[key: string]: string}}
 */
const FONT_FAMILIES = {
    'Sans Serif': '"Sans Serif", sans-serif',
    'Serif': '"Serif", serif',
    'Handwriting': '"Handwriting", cursive',
    'Marker': '"Marker", sans-serif',
    'Curly': '"Curly", cursive',
    'Pixel': '"Pixel", monospace'
};

/**
 * The effects that move pixels. With one of them the texture is not drawn pixel for pixel.
 * @constant {number}
 */
const DISTORTION_EFFECTS = ShaderManager.EFFECT_INFO.fisheye.mask |
    ShaderManager.EFFECT_INFO.whirl.mask |
    ShaderManager.EFFECT_INFO.pixelate.mask |
    ShaderManager.EFFECT_INFO.mosaic.mask;

/**
 * @typedef {object} TextCostumeStyle
 * @property {string} text - the text. A line break character starts a new line.
 * @property {string} font - the name of a font of the paint editor, for example "Pixel".
 * @property {string} color - the color of the text as a CSS color, for example "#00ff00".
 * @property {number} size - the font size in Scratch units.
 * @property {number} width - the wrap width in Scratch units.
 * @property {string} align - "left", "center" or "right".
 */

/**
 * A skin that shows wrapped lines of text in place of a costume.
 * The rotation center is on the first line, at its middle height. Horizontally it is at the left edge, the
 * center or the right edge of the text box, as the alignment of the text.
 */
class TextCostumeSkin extends Skin {
    /**
     * Create a new text costume skin.
     * @param {!int} id - The ID for this Skin.
     * @param {!RenderWebGL} renderer - The renderer which will use this skin.
     * @class
     * @augments Skin
     */
    constructor (id, renderer) {
        super(id);

        /** @type {RenderWebGL} */
        this._renderer = renderer;

        /** @type {HTMLCanvasElement} */
        this._canvas = document.createElement('canvas');

        /** @type {CanvasRenderingContext2D} */
        this._context = this._canvas.getContext('2d');

        /** @type {?TextCostumeStyle} */
        this._style = null;

        /** @type {Array<string>} */
        this._lines = [];

        /** @type {Array<number>} */
        this._size = [0, 0];

        /**
         * The width of the text box in Scratch units. It is the wrap width, or more when one character is wider.
         * @type {number}
         */
        this._boxWidth = 0;

        /** @type {boolean} */
        this._layoutDirty = false;

        /**
         * The rendered textures, newest last.
         * @type {Array<{scale: number, texture: WebGLTexture}>}
         */
        this._textures = [];

        /**
         * The scale of the texture that made the silhouette. 0 when no texture made it since the last change.
         * @type {number}
         */
        this._silhouetteScale = 0;

        /**
         * The CSS fonts that are loading now.
         * @type {Set<string>}
         */
        this._loadingFonts = new Set();

        // The paint editor fonts are on the page only after this call.
        getFonts();
    }

    /**
     * Dispose of this object. Do not use it after calling this method.
     */
    dispose () {
        this._deleteTextures();
        if (this._emptyImageTexture) {
            this._renderer.gl.deleteTexture(this._emptyImageTexture);
            this._emptyImageTexture = null;
        }
        this._canvas = null;
        this._context = null;
        super.dispose();
    }

    /**
     * @returns {Array<number>} the dimensions, in Scratch units, of this skin.
     */
    get size () {
        if (this._layoutDirty) this._layout();
        return this._size;
    }

    /**
     * @returns {Array<number>} the origin, in Scratch units, of this skin.
     */
    get rotationCenter () {
        if (this._layoutDirty) this._layout();
        return this._rotationCenter;
    }

    /**
     * @returns {number} the number of wrapped lines of the text.
     */
    get lineCount () {
        if (this._layoutDirty) this._layout();
        return this._lines.length;
    }

    /**
     * Set the text and its style. A style that is the same as the current style changes nothing.
     * @param {TextCostumeStyle} style - the new text and style.
     * @fires Skin.event:WasAltered
     */
    setStyle (style) {
        const old = this._style;
        if (old && old.text === style.text && old.font === style.font && old.color === style.color &&
            old.size === style.size && old.width === style.width && old.align === style.align) {
            return;
        }
        this._style = Object.assign({}, style);
        this._deleteTextures();
        if (style.text === '') {
            // An empty text shows nothing. The empty image also makes an empty silhouette.
            this._lines = [];
            this._size = [0, 0];
            this._layoutDirty = false;
            this.setEmptyImageData();
            return;
        }
        this._layoutDirty = true;
        this.emit(Skin.Events.WasAltered);
    }

    /**
     * @returns {string} the CSS font of the current style.
     * @private
     */
    _cssFont () {
        const family = FONT_FAMILIES[this._style.font] || FONT_FAMILIES['Sans Serif'];
        return `${this._style.size}px ${family}`;
    }

    /**
     * Load a font that the page has not loaded yet. When it is loaded, lay out and render the text again.
     * Until then the canvas uses the fallback font.
     * @param {string} cssFont - the CSS font.
     * @private
     */
    _loadFont (cssFont) {
        const fonts = document.fonts;
        if (fonts.check(cssFont) || this._loadingFonts.has(cssFont)) return;
        this._loadingFonts.add(cssFont);
        fonts.load(cssFont).then(() => {
            this._loadingFonts.delete(cssFont);
            if (!this._context || !this._style || this._style.text === '' || this._cssFont() !== cssFont) return;
            this._deleteTextures();
            this._layoutDirty = true;
            this.emit(Skin.Events.WasAltered);
        });
    }

    /**
     * Wrap the text into lines, and set the size and the rotation center.
     * @private
     */
    _layout () {
        const style = this._style;
        const cssFont = this._cssFont();
        this._loadFont(cssFont);
        this._context.font = cssFont;

        // A new wrapper and measurement provider for each layout: their caches are only good for one font.
        const measurementProvider = new CanvasMeasurementProvider(this._context);
        const wrapper = new TextWrapper(measurementProvider);
        this._lines = wrapper.wrapText(style.width, style.text).map(line => line.replace(/\s+$/, ''));

        let longest = 0;
        for (const line of this._lines) {
            longest = Math.max(longest, measurementProvider.measureText(line));
        }
        this._boxWidth = Math.max(style.width, Math.ceil(longest));

        const padding = Math.ceil(style.size * PADDING_RATIO);
        const lineHeight = style.size * LINE_HEIGHT_RATIO;
        this._size = [
            this._boxWidth + (2 * padding),
            Math.ceil(lineHeight * this._lines.length) + (2 * padding)
        ];

        let anchorX = 0;
        if (style.align === 'center') anchorX = this._boxWidth / 2;
        if (style.align === 'right') anchorX = this._boxWidth;
        this._rotationCenter[0] = padding + anchorX;
        this._rotationCenter[1] = padding + (lineHeight / 2);

        this._layoutDirty = false;
    }

    /**
     * @param {Array<number>} scale - The scaling factors of a draw, each in the [0,100] range.
     * @returns {number} the scale of the canvas for this request.
     * @private
     */
    _textureScale (scale) {
        const scaleMax = scale ? Math.max(Math.abs(scale[0]), Math.abs(scale[1])) : 100;
        const size = this.size;
        const largest = Math.max(size[0], size[1]);
        return Math.min(scaleMax / 100, MAX_TEXTURE_DIMENSION / largest);
    }

    /**
     * Render the text at a scale to the canvas.
     * @param {number} scale - the scale of the canvas, in canvas pixels for each Scratch unit.
     * @returns {ImageData} the pixels of the canvas.
     * @private
     */
    _render (scale) {
        const style = this._style;
        const canvas = this._canvas;
        const ctx = this._context;
        canvas.width = Math.max(1, Math.ceil(this._size[0] * scale));
        canvas.height = Math.max(1, Math.ceil(this._size[1] * scale));

        // A canvas resize resets the context state.
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.clearRect(0, 0, this._size[0], this._size[1]);
        ctx.font = this._cssFont();
        ctx.fillStyle = style.color;
        ctx.textAlign = style.align;
        ctx.textBaseline = 'middle';

        const padding = Math.ceil(style.size * PADDING_RATIO);
        const lineHeight = style.size * LINE_HEIGHT_RATIO;
        let x = padding;
        if (style.align === 'center') x += this._boxWidth / 2;
        if (style.align === 'right') x += this._boxWidth;
        for (let i = 0; i < this._lines.length; i++) {
            ctx.fillText(this._lines[i], x, padding + (lineHeight * (i + 0.5)));
        }

        return ctx.getImageData(0, 0, canvas.width, canvas.height);
    }

    /**
     * Delete the rendered textures. The next draw renders the text again.
     * @private
     */
    _deleteTextures () {
        for (const entry of this._textures) {
            this._renderer.gl.deleteTexture(entry.texture);
        }
        this._textures.length = 0;
        this._silhouetteScale = 0;
    }

    useNearest (scale, drawable) {
        if ((drawable.enabledEffects & DISTORTION_EFFECTS) !== 0) return false;
        if (drawable._direction % 90 !== 0) return false;
        // The texture is drawn pixel for pixel when it has the requested scale.
        const scaleMax = Math.max(Math.abs(scale[0]), Math.abs(scale[1])) / 100;
        return this._textureScale(scale) === scaleMax;
    }

    updateSilhouette (scale = [100, 100]) {
        // Any rendered scale gives a good silhouette, so render only when there is no silhouette.
        if (this._silhouetteScale === 0) this.getTexture(scale);
    }

    /**
     * @param {Array<number>} scale - The scaling factors to be used, each in the [0,100] range.
     * @returns {WebGLTexture} The GL texture representation of this skin when drawing at the given scale.
     */
    getTexture (scale) {
        if (this._layoutDirty) this._layout();
        if (this._lines.length === 0) return super.getTexture();

        const textureScale = this._textureScale(scale);
        const found = this._textures.find(entry => entry.scale === textureScale);
        if (found) return found.texture;

        const textureData = this._render(textureScale);
        const gl = this._renderer.gl;
        const texture = twgl.createTexture(gl, {
            auto: false,
            wrap: gl.CLAMP_TO_EDGE,
            src: textureData,
            premultiplyAlpha: true
        });
        this._textures.push({scale: textureScale, texture});
        if (this._textures.length > MAX_TEXTURES) {
            gl.deleteTexture(this._textures.shift().texture);
        }
        if (textureScale > this._silhouetteScale) {
            this._silhouette.update(textureData);
            this._silhouetteScale = textureScale;
        }
        return texture;
    }
}

module.exports = TextCostumeSkin;
