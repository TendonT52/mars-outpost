const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');
const TargetType = require('../../extension-support/target-type');
const Cast = require('../../util/cast');
const Clone = require('../../util/clone');
const Color = require('../../util/color');
const MathUtil = require('../../util/math-util');
const formatMessage = require('format-message');

/**
 * Make an icon with a capital letter T and two text lines, encoded as a data URI.
 * @param {string} color The color of the icon.
 * @returns {string} The data URI of the icon.
 */
const makeIconURI = color => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">' +
        `<g fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round">` +
        '<path d="M7 8h16M15 8v18"/><path d="M27 20h7M7 32h27"/>' +
        '</g></svg>';
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
 * The fonts of the paint editor. The renderer has them as web fonts.
 * @type {Array.<string>}
 */
const FONTS = ['Sans Serif', 'Serif', 'Handwriting', 'Marker', 'Curly', 'Pixel'];

/**
 * The alignments of the lines in the text box.
 * @type {Array.<string>}
 */
const ALIGNMENTS = ['left', 'center', 'right'];

/**
 * The limits of the font size, in stage pixels at 100% sprite size.
 * @type {{min: number, max: number}}
 */
const SIZE_LIMIT = {min: 4, max: 200};

/**
 * The limits of the wrap width, in stage pixels at 100% sprite size.
 * @type {{min: number, max: number}}
 */
const WIDTH_LIMIT = {min: 10, max: 1000};

/**
 * The largest number of characters of a text. A longer text is cut at the end.
 * @type {number}
 */
const MAX_TEXT_LENGTH = 10000;

/**
 * @typedef {object} TextState
 * @property {?string} text - the text that the sprite shows, or null when the sprite shows its costume.
 * @property {string} font - the font, one of FONTS.
 * @property {string} color - the color as a hex string, for example "#575e75".
 * @property {number} size - the font size.
 * @property {number} width - the wrap width.
 * @property {string} align - the alignment, one of ALIGNMENTS.
 * @property {?number} skinId - the ID of the text skin, or null when the sprite has no text skin.
 */

/**
 * Count the lines of a text without a renderer: only line break characters start a new line.
 * A line break at the end of the text does not add an empty line, as in the renderer.
 * @param {string} text The text.
 * @returns {number} The number of lines.
 */
const countExplicitLines = text => {
    if (text === '') return 0;
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.length;
};

/**
 * Find an item of a list. The match ignores the case.
 * @param {Array.<string>} list The list.
 * @param {*} value The value to find.
 * @returns {?string} The item of the list, or null when no item matches.
 */
const findItem = (list, value) => {
    const wanted = Cast.toString(value).toLowerCase();
    return list.find(item => item.toLowerCase() === wanted) || null;
};

/**
 * Class for the Text blocks in Scratch 3.0.
 * A sprite can show wrapped lines of text in place of its costume. All other sprite blocks keep working on it.
 * The text is run-time state: the project does not save it, and the stop button and the green flag show
 * the costume of each sprite again and reset the text style.
 * @class
 */
class Scratch3StageTextBlocks {
    /**
     * @param {Runtime} runtime The runtime.
     */
    constructor (runtime) {
        /**
         * The runtime instantiating this block package.
         * @type {Runtime}
         */
        this.runtime = runtime;

        this._onStopAll = this._onStopAll.bind(this);
        this._onTargetCloned = this._onTargetCloned.bind(this);
        this._onTargetRemoved = this._onTargetRemoved.bind(this);

        runtime.on('PROJECT_STOP_ALL', this._onStopAll);
        runtime.on('targetWasCloned', this._onTargetCloned);
        runtime.on('targetWasRemoved', this._onTargetRemoved);
    }

    /**
     * The state of a sprite that has not used the Text blocks.
     * @type {TextState}
     */
    static get DEFAULT_STATE () {
        return {
            text: null,
            font: 'Sans Serif',
            color: '#575e75',
            size: 20,
            width: 200,
            align: 'center',
            skinId: null
        };
    }

    /**
     * The key to load and store the text state of a target.
     * @type {string}
     */
    static get STATE_KEY () {
        return 'Scratch.stageText';
    }

    /**
     * @returns {object} metadata for this extension and its blocks.
     */
    getInfo () {
        return {
            id: 'stageText',
            name: formatMessage({
                id: 'stageText.categoryName',
                default: 'Text',
                description: 'Name of extension that lets a sprite show text in place of its costume'
            }),
            blockIconURI: blockIconURI,
            menuIconURI: menuIconURI,
            blocks: [
                {
                    opcode: 'showText',
                    text: formatMessage({
                        id: 'stageText.showText',
                        default: 'show text [TEXT]',
                        description: 'Show text in place of the costume of the sprite'
                    }),
                    blockType: BlockType.COMMAND,
                    filter: [TargetType.SPRITE],
                    arguments: {
                        TEXT: {
                            type: ArgumentType.STRING,
                            defaultValue: formatMessage({
                                id: 'stageText.defaultText',
                                default: 'Hello!',
                                description: 'Default text to show in place of the costume of the sprite'
                            })
                        }
                    }
                },
                {
                    opcode: 'showCostume',
                    text: formatMessage({
                        id: 'stageText.showCostume',
                        default: 'show costume',
                        description: 'Stop showing text, and show the costume of the sprite again'
                    }),
                    blockType: BlockType.COMMAND,
                    filter: [TargetType.SPRITE]
                },
                '---',
                {
                    opcode: 'setFont',
                    text: formatMessage({
                        id: 'stageText.setFont',
                        default: 'set font to [FONT]',
                        description: 'Set the font of the text of the sprite'
                    }),
                    blockType: BlockType.COMMAND,
                    filter: [TargetType.SPRITE],
                    arguments: {
                        FONT: {
                            type: ArgumentType.STRING,
                            menu: 'fonts',
                            defaultValue: 'Pixel'
                        }
                    }
                },
                {
                    opcode: 'setColor',
                    text: formatMessage({
                        id: 'stageText.setColor',
                        default: 'set text color to [COLOR]',
                        description: 'Set the color of the text of the sprite'
                    }),
                    blockType: BlockType.COMMAND,
                    filter: [TargetType.SPRITE],
                    arguments: {
                        COLOR: {
                            type: ArgumentType.COLOR,
                            defaultValue: Scratch3StageTextBlocks.DEFAULT_STATE.color
                        }
                    }
                },
                {
                    opcode: 'setSize',
                    text: formatMessage({
                        id: 'stageText.setSize',
                        default: 'set text size to [SIZE]',
                        description: 'Set the font size of the text of the sprite'
                    }),
                    blockType: BlockType.COMMAND,
                    filter: [TargetType.SPRITE],
                    arguments: {
                        SIZE: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 20
                        }
                    }
                },
                {
                    opcode: 'setWidth',
                    text: formatMessage({
                        id: 'stageText.setWidth',
                        default: 'set text width to [WIDTH]',
                        description: 'Set the width where the lines of the text wrap'
                    }),
                    blockType: BlockType.COMMAND,
                    filter: [TargetType.SPRITE],
                    arguments: {
                        WIDTH: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 200
                        }
                    }
                },
                {
                    opcode: 'setAlign',
                    text: formatMessage({
                        id: 'stageText.setAlign',
                        default: 'align text [ALIGN]',
                        description: 'Set the alignment of the lines of the text'
                    }),
                    blockType: BlockType.COMMAND,
                    filter: [TargetType.SPRITE],
                    arguments: {
                        ALIGN: {
                            type: ArgumentType.STRING,
                            menu: 'alignments',
                            defaultValue: 'center'
                        }
                    }
                },
                '---',
                {
                    opcode: 'lineCount',
                    text: formatMessage({
                        id: 'stageText.lineCount',
                        default: 'number of text lines',
                        description: 'Report the number of wrapped lines of the text that the sprite shows'
                    }),
                    blockType: BlockType.REPORTER,
                    filter: [TargetType.SPRITE],
                    disableMonitor: true
                },
                {
                    opcode: 'isShowingText',
                    text: formatMessage({
                        id: 'stageText.isShowingText',
                        default: 'showing text?',
                        description: 'Report true when the sprite shows text in place of its costume'
                    }),
                    blockType: BlockType.BOOLEAN,
                    filter: [TargetType.SPRITE],
                    disableMonitor: true
                }
            ],
            menus: {
                fonts: {
                    acceptReporters: true,
                    items: this._buildFontMenu()
                },
                alignments: {
                    acceptReporters: true,
                    items: [
                        {
                            text: formatMessage({
                                id: 'stageText.alignLeft',
                                default: 'left',
                                description: 'Menu item: the lines of the text start at the left edge'
                            }),
                            value: 'left'
                        },
                        {
                            text: formatMessage({
                                id: 'stageText.alignCenter',
                                default: 'center',
                                description: 'Menu item: the lines of the text are in the center'
                            }),
                            value: 'center'
                        },
                        {
                            text: formatMessage({
                                id: 'stageText.alignRight',
                                default: 'right',
                                description: 'Menu item: the lines of the text end at the right edge'
                            }),
                            value: 'right'
                        }
                    ]
                }
            }
        };
    }

    /**
     * @returns {Array.<object>} the items of the font menu. The values are the font names of the paint editor.
     * @private
     */
    _buildFontMenu () {
        const names = {
            'Sans Serif': formatMessage({
                id: 'stageText.fontSansSerif',
                default: 'Sans Serif',
                description: 'Menu item: the name of a font without serifs'
            }),
            'Serif': formatMessage({
                id: 'stageText.fontSerif',
                default: 'Serif',
                description: 'Menu item: the name of a font with serifs'
            }),
            'Handwriting': formatMessage({
                id: 'stageText.fontHandwriting',
                default: 'Handwriting',
                description: 'Menu item: the name of a font that looks like handwriting'
            }),
            'Marker': formatMessage({
                id: 'stageText.fontMarker',
                default: 'Marker',
                description: 'Menu item: the name of a font that looks like a marker pen'
            }),
            'Curly': formatMessage({
                id: 'stageText.fontCurly',
                default: 'Curly',
                description: 'Menu item: the name of a font with curly letters'
            }),
            'Pixel': formatMessage({
                id: 'stageText.fontPixel',
                default: 'Pixel',
                description: 'Menu item: the name of a font with square pixels, as on an old computer screen'
            })
        };
        return FONTS.map(font => ({text: names[font], value: font}));
    }

    /**
     * @param {Target} target A target.
     * @returns {TextState} the mutable text state of the target. This will be created if necessary.
     * @private
     */
    _getState (target) {
        let state = target.getCustomState(Scratch3StageTextBlocks.STATE_KEY);
        if (!state) {
            state = Clone.simple(Scratch3StageTextBlocks.DEFAULT_STATE);
            target.setCustomState(Scratch3StageTextBlocks.STATE_KEY, state);
        }
        return state;
    }

    /**
     * @param {TextState} state A text state that shows text.
     * @returns {object} the style for the text skin of the renderer.
     * @private
     */
    _styleOf (state) {
        return {
            text: state.text,
            font: state.font,
            color: state.color,
            size: state.size,
            width: state.width,
            align: state.align
        };
    }

    /**
     * Make the drawable of a target show its text state: the text skin, or the costume.
     * @param {RenderedTarget} target The target.
     * @private
     */
    _update (target) {
        const renderer = this.runtime.renderer;
        if (!renderer) return;
        const state = this._getState(target);
        if (state.text === null) {
            if (state.skinId === null) return;
            target.setOverrideSkin(null);
            renderer.destroySkin(state.skinId);
            state.skinId = null;
            return;
        }
        if (state.skinId === null) {
            state.skinId = renderer.createTextCostumeSkin(this._styleOf(state));
            target.setOverrideSkin(state.skinId);
            return;
        }
        renderer.updateTextCostumeSkin(state.skinId, this._styleOf(state));
        // The skin has a new size, so a say bubble of the sprite moves.
        target.setOverrideSkin(state.skinId);
    }

    /**
     * Show the costume of each sprite again and reset the text style, as the stop button and the green flag do
     * for say bubbles and graphic effects.
     * @private
     */
    _onStopAll () {
        for (const target of this.runtime.targets) {
            const state = target.getCustomState(Scratch3StageTextBlocks.STATE_KEY);
            if (!state) continue;
            state.text = null;
            this._update(target);
            const reset = Clone.simple(Scratch3StageTextBlocks.DEFAULT_STATE);
            target.setCustomState(Scratch3StageTextBlocks.STATE_KEY, reset);
        }
    }

    /**
     * Give a new clone the text state of its parent, with its own text skin.
     * @param {RenderedTarget} newClone The new clone. It has no drawable yet.
     * @param {RenderedTarget} parent The target that made the clone.
     * @private
     */
    _onTargetCloned (newClone, parent) {
        const parentState = parent.getCustomState(Scratch3StageTextBlocks.STATE_KEY);
        if (!parentState) return;
        const state = Object.assign(Clone.simple(parentState), {skinId: null});
        newClone.setCustomState(Scratch3StageTextBlocks.STATE_KEY, state);
        this._update(newClone);
    }

    /**
     * Destroy the text skin of a target that is removed.
     * @param {RenderedTarget} target The target.
     * @private
     */
    _onTargetRemoved (target) {
        const state = target.getCustomState(Scratch3StageTextBlocks.STATE_KEY);
        if (!state || state.skinId === null || !this.runtime.renderer) return;
        this.runtime.renderer.destroySkin(state.skinId);
        state.skinId = null;
    }

    showText (args, util) {
        // The stage shows only its backdrop.
        if (util.target.isStage) return;
        const state = this._getState(util.target);
        const text = Cast.toString(args.TEXT).slice(0, MAX_TEXT_LENGTH);
        if (state.text === text) return;
        state.text = text;
        this._update(util.target);
    }

    showCostume (args, util) {
        this._getState(util.target).text = null;
        this._update(util.target);
    }

    /**
     * Set style properties. Only a sprite that shows text renders again, and only when a property changes.
     * @param {RenderedTarget} target The target.
     * @param {object} changes The new values of properties of the text state.
     * @private
     */
    _setStyle (target, changes) {
        const state = this._getState(target);
        const changed = Object.keys(changes).filter(key => state[key] !== changes[key]);
        if (changed.length === 0) return;
        Object.assign(state, changes);
        if (state.text !== null) this._update(target);
    }

    setFont (args, util) {
        const font = findItem(FONTS, args.FONT);
        if (font) this._setStyle(util.target, {font});
    }

    setColor (args, util) {
        this._setStyle(util.target, {color: Color.rgbToHex(Cast.toRgbColorObject(args.COLOR))});
    }

    setSize (args, util) {
        this._setStyle(util.target, {size: MathUtil.clamp(Cast.toNumber(args.SIZE), SIZE_LIMIT.min, SIZE_LIMIT.max)});
    }

    setWidth (args, util) {
        const width = MathUtil.clamp(Cast.toNumber(args.WIDTH), WIDTH_LIMIT.min, WIDTH_LIMIT.max);
        this._setStyle(util.target, {width});
    }

    setAlign (args, util) {
        const align = findItem(ALIGNMENTS, args.ALIGN);
        if (align) this._setStyle(util.target, {align});
    }

    lineCount (args, util) {
        const state = this._getState(util.target);
        if (state.text === null) return 0;
        if (state.skinId !== null) return this.runtime.renderer.getTextCostumeLineCount(state.skinId);
        return countExplicitLines(state.text);
    }

    isShowingText (args, util) {
        return this._getState(util.target).text !== null;
    }
}

module.exports = Scratch3StageTextBlocks;
