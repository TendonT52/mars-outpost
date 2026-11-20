const test = require('tap').test;
const Runtime = require('../../src/engine/runtime');
const Sprite = require('../../src/sprites/sprite');
const StageText = require('../../src/extensions/scratch3_stage_text/index.js');
const collab = require('../../src/engine/collab');

const COSTUME_SKINS = [101, 102];

/**
 * Make a fake renderer that records the skins and the skin of each drawable.
 * Each character of a text is size / 2 wide, so a line has width / (size / 2) characters.
 * @returns {object} The fake renderer.
 */
const makeRenderer = () => {
    const renderer = {
        skins: new Map(),
        drawableSkins: new Map(),
        created: 0,
        updated: 0,
        nextId: 1,
        createDrawable () {
            return renderer.nextId++;
        },
        destroyDrawable (id) {
            renderer.drawableSkins.delete(id);
        },
        updateDrawableSkinId (id, skinId) {
            renderer.drawableSkins.set(id, skinId);
        },
        createTextCostumeSkin (style) {
            const id = 1000 + renderer.nextId++;
            renderer.skins.set(id, Object.assign({}, style));
            renderer.created++;
            return id;
        },
        updateTextCostumeSkin (id, style) {
            renderer.skins.set(id, Object.assign({}, style));
            renderer.updated++;
        },
        destroySkin (id) {
            renderer.skins.delete(id);
        },
        getTextCostumeLineCount (id) {
            const style = renderer.skins.get(id);
            if (style.text === '') return 0;
            const perLine = Math.floor(style.width / (style.size / 2));
            return style.text.replace(/\n$/, '').split('\n')
                .reduce((count, part) => count + Math.max(1, Math.ceil(part.length / perLine)), 0);
        },
        getCurrentSkinSize: () => [10, 10],
        getFencedPositionOfDrawable: (id, position) => position
    };
    // The target calls more renderer methods. They change nothing for these tests.
    return new Proxy(renderer, {
        get: (target, prop) => (prop in target ? target[prop] : () => {})
    });
};

/**
 * Make a runtime with a sprite of two costumes, and the extension.
 * @param {boolean} withRenderer False for a runtime without a renderer.
 * @returns {{runtime: Runtime, ext: StageText, target: RenderedTarget, renderer: ?object}} The parts.
 */
const setup = (withRenderer = true) => {
    const runtime = new Runtime();
    const renderer = withRenderer ? makeRenderer() : null;
    runtime.renderer = renderer;
    const ext = new StageText(runtime);
    const sprite = new Sprite(null, runtime);
    sprite.costumes = COSTUME_SKINS.map((skinId, i) => ({name: `costume${i + 1}`, skinId}));
    const target = sprite.createClone();
    runtime.addTarget(target);
    target.updateAllDrawableProperties();
    return {runtime, ext, target, renderer};
};

const shownSkin = (renderer, target) => renderer.drawableSkins.get(target.drawableID);

test('getInfo: the id has no underscore, and each block has a method', t => {
    const info = new StageText(new Runtime()).getInfo();
    t.equal(info.id, 'stageText');
    t.notOk(info.id.includes('_'));
    const opcodes = info.blocks.filter(block => typeof block === 'object').map(block => block.opcode);
    t.same(opcodes, ['showText', 'showCostume', 'setFont', 'setColor', 'setSize', 'setWidth', 'setAlign', 'lineCount',
        'isShowingText']);
    for (const opcode of opcodes) t.type(StageText.prototype[opcode], 'function', opcode);
    t.same(info.menus.fonts.items.map(item => item.value),
        ['Sans Serif', 'Serif', 'Handwriting', 'Marker', 'Curly', 'Pixel']);
    t.end();
});

test('collaboration syncs the blocks, and the core text shadow block is not of this extension', t => {
    t.ok(collab.isSyncedOpcode('stageText_showText'));
    t.ok(collab.isSyncedOpcode('stageText_menu_fonts'));
    t.ok(collab.isSyncedOpcode('text'));
    t.end();
});

test('show text shows a text skin, and show costume shows the costume again', t => {
    const {ext, target, renderer} = setup();
    const util = {target};
    t.equal(shownSkin(renderer, target), COSTUME_SKINS[0]);
    t.equal(ext.isShowingText({}, util), false);
    t.equal(ext.lineCount({}, util), 0);

    ext.showText({TEXT: 'Hello'}, util);
    const skinId = target.overrideSkinId;
    t.ok(renderer.skins.has(skinId));
    t.equal(shownSkin(renderer, target), skinId);
    t.same(renderer.skins.get(skinId), {
        text: 'Hello', font: 'Sans Serif', color: '#575e75', size: 20, width: 200, align: 'center'
    });
    t.equal(ext.isShowingText({}, util), true);
    t.equal(ext.lineCount({}, util), 1);

    ext.showCostume({}, util);
    t.equal(shownSkin(renderer, target), COSTUME_SKINS[0]);
    t.equal(target.overrideSkinId, null);
    t.notOk(renderer.skins.has(skinId), 'the text skin is destroyed');
    t.equal(ext.isShowingText({}, util), false);
    t.end();
});

test('a new text or style updates the same skin, and the same text changes nothing', t => {
    const {ext, target, renderer} = setup();
    const util = {target};
    ext.showText({TEXT: 'one'}, util);
    const skinId = target.overrideSkinId;
    ext.showText({TEXT: 'one'}, util);
    t.equal(renderer.updated, 0, 'the same text does not render again');
    ext.showText({TEXT: 'two'}, util);
    ext.setFont({FONT: 'pixel'}, util);
    ext.setColor({COLOR: '#00ff00'}, util);
    ext.setSize({SIZE: 16}, util);
    ext.setWidth({WIDTH: 300}, util);
    ext.setAlign({ALIGN: 'left'}, util);
    t.equal(renderer.created, 1);
    t.equal(target.overrideSkinId, skinId);
    t.same(renderer.skins.get(skinId), {
        text: 'two', font: 'Pixel', color: '#00ff00', size: 16, width: 300, align: 'left'
    });
    ext.setSize({SIZE: 16}, util);
    t.equal(renderer.updated, 6, 'the same style does not render again');
    t.end();
});

test('the style blocks clamp the values and ignore unknown menu values', t => {
    const {ext, target, renderer} = setup();
    const util = {target};
    ext.setSize({SIZE: 1000}, util);
    ext.setWidth({WIDTH: -5}, util);
    ext.setAlign({ALIGN: 'middle'}, util);
    ext.setFont({FONT: 'Comic'}, util);
    t.equal(renderer.created, 0, 'a sprite that shows its costume gets no skin for a style change');
    ext.showText({TEXT: 'x'}, util);
    t.same(renderer.skins.get(target.overrideSkinId), {
        text: 'x', font: 'Sans Serif', color: '#575e75', size: 200, width: 10, align: 'center'
    });
    ext.setSize({SIZE: 0}, util);
    t.equal(renderer.skins.get(target.overrideSkinId).size, 4);
    t.end();
});

test('number of text lines reports the wrapped lines of the renderer', t => {
    const {ext, target} = setup();
    const util = {target};
    ext.setSize({SIZE: 10}, util);
    ext.setWidth({WIDTH: 50}, util);
    ext.setAlign({ALIGN: 'left'}, util);
    // 10 characters fit on a line.
    ext.showText({TEXT: 'abcdefghijklmnopqrstuvwxy\nshort\n'}, util);
    t.equal(ext.lineCount({}, util), 4);
    ext.showText({TEXT: ''}, util);
    t.equal(ext.lineCount({}, util), 0);
    t.equal(ext.isShowingText({}, util), true, 'an empty text shows nothing, in place of the costume');
    t.end();
});

test('a costume switch while the text shows keeps the text, until show costume', t => {
    const {ext, target, renderer} = setup();
    const util = {target};
    ext.showText({TEXT: 'Hello'}, util);
    const skinId = target.overrideSkinId;
    target.setCostume(1);
    t.equal(target.currentCostume, 1);
    t.equal(shownSkin(renderer, target), skinId);
    target.updateAllDrawableProperties();
    t.equal(shownSkin(renderer, target), skinId);
    ext.showCostume({}, util);
    t.equal(shownSkin(renderer, target), COSTUME_SKINS[1], 'the sprite shows its new costume');
    t.end();
});

test('a clone copies the text state of its parent and gets its own skin', t => {
    const {ext, target, renderer} = setup();
    ext.setSize({SIZE: 30}, {target});
    ext.showText({TEXT: 'parent'}, {target});
    const clone = target.makeClone();
    t.ok(clone);
    t.not(clone.overrideSkinId, target.overrideSkinId);
    t.equal(shownSkin(renderer, clone), clone.overrideSkinId);
    t.same(renderer.skins.get(clone.overrideSkinId), renderer.skins.get(target.overrideSkinId));

    // A clone of a clone copies its parent clone, not the original.
    ext.showText({TEXT: 'child'}, {target: clone});
    const grandchild = clone.makeClone();
    t.equal(renderer.skins.get(grandchild.overrideSkinId).text, 'child');
    t.equal(renderer.skins.get(target.overrideSkinId).text, 'parent');

    // A clone of a sprite that shows its costume shows its costume.
    ext.showCostume({}, {target});
    const plain = target.makeClone();
    t.equal(plain.overrideSkinId, null);
    t.equal(shownSkin(renderer, plain), COSTUME_SKINS[0]);
    t.equal(ext.lineCount({}, {target: plain}), 0);
    t.end();
});

test('a removed clone destroys its text skin', t => {
    const {runtime, ext, target, renderer} = setup();
    ext.showText({TEXT: 'Hello'}, {target});
    const clone = target.makeClone();
    runtime.addTarget(clone);
    const cloneSkin = clone.overrideSkinId;
    runtime.disposeTarget(clone);
    t.notOk(renderer.skins.has(cloneSkin));
    t.ok(renderer.skins.has(target.overrideSkinId));
    t.end();
});

test('stop all shows the costumes again, resets the style and destroys all text skins', t => {
    const {runtime, ext, target, renderer} = setup();
    ext.setFont({FONT: 'Pixel'}, {target});
    ext.showText({TEXT: 'Hello'}, {target});
    const clone = target.makeClone();
    runtime.addTarget(clone);
    runtime.stopAll();
    t.equal(renderer.skins.size, 0);
    t.equal(target.overrideSkinId, null);
    t.equal(shownSkin(renderer, target), COSTUME_SKINS[0]);
    t.equal(ext.isShowingText({}, {target}), false);
    ext.showText({TEXT: 'again'}, {target});
    t.equal(renderer.skins.get(target.overrideSkinId).font, 'Sans Serif', 'the style is reset');
    t.end();
});

test('runtime dispose destroys all text skins', t => {
    const {runtime, ext, target, renderer} = setup();
    ext.showText({TEXT: 'Hello'}, {target});
    runtime.dispose();
    t.equal(renderer.skins.size, 0);
    t.end();
});

test('the stage shows no text', t => {
    const {runtime, ext, renderer} = setup();
    const sprite = new Sprite(null, runtime);
    sprite.costumes = [{name: 'backdrop1', skinId: 200}];
    const stage = sprite.createClone();
    stage.isStage = true;
    ext.showText({TEXT: 'Hello'}, {target: stage});
    t.equal(renderer.created, 0);
    t.equal(ext.isShowingText({}, {target: stage}), false);
    t.end();
});

test('without a renderer the blocks keep the state and count only the line breaks', t => {
    const {runtime, ext, target} = setup(false);
    const util = {target};
    ext.setWidth({WIDTH: 20}, util);
    ext.setAlign({ALIGN: 'right'}, util);
    ext.showText({TEXT: 'a long first line\nsecond\n'}, util);
    t.equal(ext.isShowingText({}, util), true);
    t.equal(ext.lineCount({}, util), 2);
    ext.showText({TEXT: 'a\n\n'}, util);
    t.equal(ext.lineCount({}, util), 2);
    const clone = target.makeClone();
    t.equal(ext.lineCount({}, {target: clone}), 2);
    runtime.stopAll();
    t.equal(ext.isShowingText({}, util), false);
    t.end();
});
