const EventEmitter = require('events');
const test = require('tap').test;
const {setFetch} = require('../../src/util/fetch-with-timeout');
const Mastra = require('../../src/extensions/scratch3_mastra/index.js');
const collab = require('../../src/engine/collab');
const log = require('../../src/util/log');

/**
 * Make the extension with a short timeout, because fetchWithTimeout keeps its timer after a failed call.
 * @returns {{ext: Mastra, runtime: EventEmitter}} The extension and its runtime.
 */
const make = () => {
    const runtime = new EventEmitter();
    const ext = new Mastra(runtime);
    ext._timeoutMs = 200;
    return {ext, runtime};
};

/**
 * Make a fake fetch that records its calls.
 * @param {function(string, object): Promise} handler Answers a call.
 * @returns {Array} The list of calls. Each call has the url and the options.
 */
const fakeServer = handler => {
    // fetchWithTimeout reads window.AbortController. Node has no window, so the call has no abort signal.
    if (typeof global.window === 'undefined') global.window = {};
    const calls = [];
    setFetch((url, init) => {
        calls.push({url, init, body: init.body ? JSON.parse(init.body) : null});
        return handler(url, init, calls[calls.length - 1].body);
    });
    return calls;
};

const reply = (status, body) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
});

const answer = (extra = {}) => Object.assign({
    kind: 'mission',
    say: 'The panels are dusty.',
    action: 'point_to',
    target: 'airlock',
    offer: 'none',
    care: false,
    situation: 'need:power',
    level: 2,
    stale: false,
    fresh: false
}, extra);

const view = (extra = {}) => Object.assign({
    situation: '', level: 0, role: 'advisor', asleep: false, remark: false, remark_for: ''
}, extra);

/**
 * A fake server that answers each route with a good answer.
 * @param {object} [options] The options.
 * @param {function(object): object} [options.event] Makes the state view of an event from its body.
 * @param {function(object): object} [options.message] Makes the reply of a message from its body.
 * @returns {Array} The list of calls.
 */
const goodServer = ({event = () => view(), message = () => answer()} = {}) => fakeServer((url, init, body) => {
    if (url === '/api/game/start') return reply(200, view());
    if (url === '/api/game/event') return reply(200, event(body));
    if (url === '/api/game/message') return reply(200, message(body));
    return reply(404, {error: 'no route'});
});

test('getInfo: the id has no underscore and each block has a method', t => {
    const {ext} = make();
    const info = ext.getInfo();
    t.equal(info.id, 'mastra');
    t.equal(info.name, 'Mastra API');
    const opcodes = info.blocks.filter(b => typeof b === 'object').map(b => b.opcode);
    t.same(opcodes, ['startGame', 'startGameAgain', 'setValue', 'clearValues', 'sendValues', 'sendValuesAlways',
        'valuesText', 'setSensors', 'look', 'stationResult', 'setRole', 'sleepComputer', 'wakeComputer', 'reportFail',
        'addNote', 'situation', 'hintLevel', 'computerRole', 'isAsleep', 'remarkWanted', 'remarkFor', 'tellComputer',
        'sayRemark', 'replyToShow', 'computerSays', 'replyKind', 'computerAction', 'actionTarget', 'openOffer',
        'needsCare', 'isStale', 'isFresh', 'isThinking', 'speak', 'loadSpeech', 'playSpeech', 'stopSpeaking',
        'isSpeaking', 'speechReady', 'speechLength', 'speechTime', 'fact', 'status']);
    opcodes.forEach(opcode => t.equal(typeof ext[opcode], 'function', opcode));
    t.same(info.menus.parts.items, ['title', 'text', 'source']);
    t.same(info.menus.hows.items, ['near', 'open', 'leave']);
    t.ok(info.menus.roles.items.includes('none'));
    t.end();
});

test('the extension is built in and synced by collaboration', t => {
    t.ok(collab.BUILTIN_EXTENSIONS.includes('mastra'));
    t.notOk(collab.BUILTIN_EXTENSIONS.includes('api'));
    t.ok(collab.isSyncedOpcode('mastra_tellComputer'));
    t.end();
});

test('before any call: empty view, empty reply, status 0, nobody thinks', t => {
    const {ext} = make();
    t.equal(ext.status(), 0);
    t.equal(ext.computerSays(), '');
    t.equal(ext.replyKind(), '');
    t.equal(ext.computerAction(), 'none');
    t.equal(ext.actionTarget(), '');
    t.equal(ext.openOffer(), 'none');
    t.equal(ext.isThinking(), false);
    t.equal(ext.needsCare(), false);
    t.equal(ext.isStale(), false);
    t.equal(ext.isFresh(), false);
    t.equal(ext.replyToShow(), false);
    t.equal(ext.situation(), '');
    t.equal(ext.hintLevel(), 0);
    t.equal(ext.computerRole(), '');
    t.equal(ext.isAsleep(), false);
    t.equal(ext.remarkWanted(), false);
    t.equal(ext.remarkFor(), '');
    t.equal(ext.valuesText(), '');
    t.end();
});

test('startGame: the body has only the game, and the answer sets the state view', async t => {
    const calls = fakeServer(() => reply(200, view({
        situation: 'event:dust_storm', level: 1, role: 'low_power', asleep: true
    })));
    const {ext} = make();
    await ext.startGame({GAME: 'mars'});
    t.equal(calls.length, 1);
    t.equal(calls[0].url, '/api/game/start');
    t.equal(calls[0].init.method, 'POST');
    t.equal(calls[0].init.credentials, 'same-origin');
    t.same(calls[0].init.headers, {'Content-Type': 'application/json'}, 'the extension adds no test header');
    t.same(calls[0].body, {game: 'mars'});
    t.equal(ext.status(), 200);
    t.equal(ext.situation(), 'event:dust_storm');
    t.equal(ext.hintLevel(), 1);
    t.equal(ext.computerRole(), 'low_power');
    t.equal(ext.isAsleep(), true);
});

test('startGameAgain: the body has again true, and the answer sets the state view as startGame', async t => {
    const calls = fakeServer(() => reply(200, view({situation: 'event:dust_storm', role: 'low_power'})));
    const {ext} = make();
    await ext.startGameAgain({GAME: 'mars'});
    t.equal(calls.length, 1);
    t.equal(calls[0].url, '/api/game/start');
    t.equal(calls[0].init.method, 'POST');
    t.same(calls[0].body, {game: 'mars', again: true});
    t.equal(ext.status(), 200);
    t.equal(ext.situation(), 'event:dust_storm');
    t.equal(ext.computerRole(), 'low_power');
    await ext.startGame({GAME: 'mars'});
    t.same(calls[1].body, {game: 'mars'}, 'startGame after startGameAgain sends no again');
    t.notOk('again' in calls[1].body);
});

test('startGameAgain: an empty game is mars', async t => {
    const calls = fakeServer(() => reply(200, view()));
    const {ext} = make();
    await ext.startGameAgain({GAME: ''});
    t.same(calls[0].body, {game: 'mars', again: true});
});

test('startGameAgain clears the old reply, keeps the values, and the next send values sends them again', async t => {
    const calls = goodServer();
    const {ext} = make();
    ext.setValue({NAME: 'sol', VALUE: '4'});
    await ext.sendValues();
    await ext.setSensors({SENSORS: 'water'});
    await ext.tellComputer({TEXT: 'hi'});
    t.equal(ext.computerSays(), 'The panels are dusty.');
    await ext.startGameAgain({GAME: 'mars'});
    t.equal(ext.computerSays(), '');
    t.equal(ext.replyToShow(), false);
    await ext.sendValues();
    t.same(calls[4].body, {game: 'mars', event: 'set', values: 'sol=4'});
    t.equal(ext._sensors, '');
});

test('a failed startGameAgain keeps the old game', async t => {
    const calls = fakeServer(url => (url === '/api/game/start' ?
        reply(400, {error: 'no game with this id'}) : reply(200, answer())));
    const {ext} = make();
    await ext.startGameAgain({GAME: 'venus'});
    t.equal(ext.status(), 400);
    await ext.tellComputer({TEXT: 'hi'});
    t.equal(calls[1].body.game, 'mars');
});

test('startGame: an empty game is mars', async t => {
    const calls = fakeServer(() => reply(200, view()));
    const {ext} = make();
    await ext.startGame({GAME: ' '});
    t.same(calls[0].body, {game: 'mars'});
});

test('startGame clears the old reply, keeps the values, and the next send values sends them again', async t => {
    const calls = goodServer();
    const {ext} = make();
    ext.setValue({NAME: 'sol', VALUE: '4'});
    await ext.sendValues();
    await ext.setSensors({SENSORS: 'water'});
    await ext.tellComputer({TEXT: 'hi'});
    t.equal(ext.computerSays(), 'The panels are dusty.');
    await ext.startGame({GAME: 'mars'});
    t.equal(ext.computerSays(), '');
    t.equal(ext.replyToShow(), false);
    await ext.sendValues();
    t.same(calls[4].body, {game: 'mars', event: 'set', values: 'sol=4'});
    // A new game has no broken sensor, so a later recovery sends no sensors.
    t.equal(ext._sensors, '');
});

test('a failed startGame keeps the old game', async t => {
    const calls = fakeServer(url => (url === '/api/game/start' ?
        reply(400, {error: 'no game with this id'}) : reply(200, answer())));
    const {ext} = make();
    await ext.startGame({GAME: 'venus'});
    t.equal(ext.status(), 400);
    await ext.tellComputer({TEXT: 'hi'});
    t.equal(calls[1].body.game, 'mars');
});

test('the game of startGame is used by later calls', async t => {
    const calls = goodServer();
    const {ext} = make();
    await ext.startGame({GAME: 'moon'});
    await ext.tellComputer({TEXT: 'hi'});
    await ext.wakeComputer();
    await ext.look({STATION: 'Bunk', HOW: 'near'});
    t.equal(calls[1].body.game, 'moon');
    t.equal(calls[2].body.game, 'moon');
    t.equal(calls[3].body.game, 'moon');
});

test('values: set and clear make no call, and the text has all values in the order of their first set', t => {
    const calls = goodServer();
    const {ext} = make();
    ext.setValue({NAME: 'sol', VALUE: 1});
    ext.setValue({NAME: 'power_pct', VALUE: '12'});
    ext.setValue({NAME: 'room', VALUE: 'computer_room'});
    ext.setValue({NAME: 'sol', VALUE: 2});
    t.equal(ext.valuesText(), 'sol=2;power_pct=12;room=computer_room');
    ext.clearValues();
    t.equal(ext.valuesText(), '');
    t.equal(calls.length, 0);
    t.end();
});

test('values: a ; becomes a comma, = and ; leave a name, long values are cut, an empty value removes', t => {
    const {ext} = make();
    ext.setValue({NAME: 'no;te=', VALUE: 'a;b=c'});
    ext.setValue({NAME: 'long', VALUE: 'x'.repeat(60)});
    ext.setValue({NAME: 'line', VALUE: 'one\ntwo'});
    ext.setValue({NAME: 'sol', VALUE: 3});
    ext.setValue({NAME: '', VALUE: 'lost'});
    ext.setValue({NAME: ' ; ', VALUE: 'lost'});
    t.equal(ext.valuesText(), `note=a,b=c;long=${'x'.repeat(40)};line=one two;sol=3`);
    ext.setValue({NAME: 'sol', VALUE: ''});
    ext.setValue({NAME: 'long', VALUE: '  '});
    t.equal(ext.valuesText(), 'note=a,b=c;line=one two');
    t.end();
});

test('sendValues: one set event with all values, and only when the text changed', async t => {
    const calls = goodServer({event: () => view({situation: 'need:power', level: 1})});
    const {ext} = make();
    ext.setValue({NAME: 'sol', VALUE: 1});
    ext.setValue({NAME: 'power_pct', VALUE: 12});
    await ext.sendValues();
    t.equal(calls.length, 1);
    t.equal(calls[0].url, '/api/game/event');
    t.same(calls[0].body, {game: 'mars', event: 'set', values: 'sol=1;power_pct=12'});
    t.equal(ext.status(), 200);
    t.equal(ext.situation(), 'need:power');
    t.equal(ext.hintLevel(), 1);
    await ext.sendValues();
    ext.setValue({NAME: 'sol', VALUE: 1});
    await ext.sendValues();
    t.equal(calls.length, 1, 'the same text makes no call');
    ext.setValue({NAME: 'power_pct', VALUE: 11});
    await ext.sendValues();
    t.equal(calls.length, 2);
    t.equal(calls[1].body.values, 'sol=1;power_pct=11');
    await ext.sendValuesAlways();
    t.equal(calls.length, 3, 'send values again sends the same text');
    t.equal(calls[2].body.values, 'sol=1;power_pct=11');
});

test('sendValues: no values make no call, and a failed send is sent again', async t => {
    let status = 400;
    const calls = fakeServer(() => reply(status, status === 200 ? view() : {error: 'bad'}));
    const {ext} = make();
    await ext.sendValues();
    await ext.sendValuesAlways();
    t.equal(calls.length, 0, 'the server ignores an empty text');
    ext.setValue({NAME: 'bad_name', VALUE: 1});
    await ext.sendValues();
    t.equal(ext.status(), 400);
    status = 200;
    await ext.sendValues();
    t.equal(calls.length, 2, 'the text was not accepted, so the block sends it again');
    t.equal(ext.status(), 200);
});

test('each event has its body, waits for the answer and takes the state view', async t => {
    const calls = goodServer({event: body => view({situation: `after:${body.event}`, level: 3, role: 'hands'})});
    const {ext} = make();
    ext.setValue({NAME: 'sol', VALUE: 4});
    const cases = [
        [() => ext.setSensors({SENSORS: ' water,dose '}), {event: 'sensors', unreliable: 'water,dose'}],
        [() => ext.setSensors({SENSORS: ''}), {event: 'sensors', unreliable: ''}],
        [() => ext.look({STATION: ' SolarPanels ', HOW: 'near'}),
            {event: 'look', station: 'SolarPanels', how: 'near'}],
        [() => ext.look({STATION: 'IceSite', HOW: 'open'}), {event: 'look', station: 'IceSite', how: 'open'}],
        [() => ext.look({STATION: 'IceSite', HOW: 'leave'}), {event: 'look', station: 'IceSite', how: 'leave'}],
        [() => ext.stationResult({STATION: 'IceSite', VALUES: 'ice=3;water=3;dose=2.5'}),
            {event: 'result', station: 'IceSite', values: 'ice=3;water=3;dose=2.5'}],
        [() => ext.stationResult({STATION: 'Bunk', VALUES: ''}), {event: 'result', station: 'Bunk', values: ''}],
        [() => ext.setRole({ROLE: 'hands'}), {event: 'role', role: 'hands'}],
        [() => ext.setRole({ROLE: 'none'}), {event: 'role', role: ''}],
        [() => ext.sleepComputer(), {event: 'sleep'}],
        [() => ext.wakeComputer(), {event: 'wake'}],
        [() => ext.reportFail({CAUSE: 'The oxygen ran out.'}), {event: 'fail', cause: 'The oxygen ran out.'}],
        [() => ext.addNote({TEXT: 'The player built the shelter.'}),
            {event: 'note', text: 'The player built the shelter.'}]
    ];
    for (const [run, body] of cases) {
        const before = calls.length;
        const block = run();
        t.equal(typeof block.then, 'function', `${body.event}: the block gives a promise`);
        await block;
        t.equal(calls.length, before + 1, `${body.event}: one call, with no set event before it`);
        t.equal(calls[before].url, '/api/game/event');
        t.same(calls[before].body, Object.assign({game: 'mars'}, body));
        t.equal(ext.situation(), `after:${body.event}`);
    }
    t.equal(ext.hintLevel(), 3);
    t.equal(ext.computerRole(), 'hands');
    t.equal(ext.status(), 200);
});

test('sleep and wake: the state view sets and clears asleep', async t => {
    goodServer({event: body => view({asleep: body.event === 'sleep'})});
    const {ext} = make();
    await ext.sleepComputer();
    t.equal(ext.isAsleep(), true);
    await ext.wakeComputer();
    t.equal(ext.isAsleep(), false);
});

test('an event with 400, 409 or no network does not throw, keeps the view, and the status tells', async t => {
    let status = 200;
    fakeServer(() => {
        if (status === 0) return Promise.reject(new TypeError('Failed to fetch'));
        return reply(status, status === 200 ? view({situation: 'need:water', level: 2}) : {error: 'no'});
    });
    const {ext} = make();
    await ext.wakeComputer();
    for (status of [400, 409, 503, 0]) {
        await ext.addNote({TEXT: 'x'});
        t.equal(ext.status(), status);
        t.equal(ext.situation(), 'need:water', 'the old view stays');
        t.equal(ext.hintLevel(), 2);
    }
});

test('tellComputer: the body has game, text and all values, and the reply reports', async t => {
    const calls = goodServer({message: () => answer({offer: 'open', care: true})});
    const {ext} = make();
    ext.setValue({NAME: 'sol', VALUE: 1});
    ext.setValue({NAME: 'power_pct', VALUE: '12'});
    await ext.tellComputer({TEXT: 'why is it so dark in here?'});
    t.equal(calls.length, 1);
    t.equal(calls[0].url, '/api/game/message');
    t.same(calls[0].body, {game: 'mars', text: 'why is it so dark in here?', values: 'sol=1;power_pct=12'});
    t.equal(ext.status(), 200);
    t.equal(ext.computerSays(), 'The panels are dusty.');
    t.equal(ext.replyKind(), 'mission');
    t.equal(ext.computerAction(), 'point_to');
    t.equal(ext.actionTarget(), 'airlock');
    t.equal(ext.openOffer(), 'open');
    t.equal(ext.needsCare(), true);
    t.equal(ext.isStale(), false);
    t.equal(ext.isFresh(), false);
    t.equal(ext.replyToShow(), true);
    t.equal(ext.situation(), 'need:power', 'the reply has the situation after the message');
    t.equal(ext.hintLevel(), 2);
    // The server took the values with the message, so the same text needs no set event.
    await ext.sendValues();
    t.equal(calls.length, 1);
});

test('tellComputer: no values give a body with the game and the text only; empty text is sent', async t => {
    const calls = goodServer();
    const {ext} = make();
    await ext.tellComputer({TEXT: ''});
    t.same(calls[0].body, {game: 'mars', text: ''});
});

test('a reply with the action go_to_sleep, or the kind asleep, makes the computer sleep', async t => {
    goodServer({message: () => answer({action: 'go_to_sleep', target: '', offer: 'accepted'})});
    const first = make().ext;
    await first.tellComputer({TEXT: 'yes'});
    t.equal(first.isAsleep(), true);
    goodServer({message: () => answer({kind: 'asleep', action: 'none'})});
    const second = make().ext;
    await second.tellComputer({TEXT: 'hello?'});
    t.equal(second.isAsleep(), true);
    t.equal(second.replyToShow(), true, 'the last words of a sleeping computer show');
});

test('computer thinking is true from the call until the reply, and not for a remark', async t => {
    let release = null;
    fakeServer((url, init, body) => {
        if (url === '/api/game/event') return reply(200, view({remark: true, remark_for: 'Bunk'}));
        if (body.remark) return reply(200, answer());
        return new Promise(resolve => {
            release = () => resolve(reply(200, answer()));
        });
    });
    const {ext} = make();
    await ext.look({STATION: 'Bunk', HOW: 'near'});
    const remark = ext.sayRemark();
    t.equal(ext.isThinking(), false);
    await remark;
    const block = ext.tellComputer({TEXT: 'hi'});
    t.equal(ext.isThinking(), true);
    await new Promise(resolve => setTimeout(resolve, 5));
    t.equal(ext.isThinking(), true);
    release();
    await block;
    t.equal(ext.isThinking(), false);
});

test('the remark flow: an event grants it, sayRemark sends the subject with no text, and the reply shows', async t => {
    const calls = goodServer({
        event: () => view({situation: 'need:power', level: 1, remark: true, remark_for: 'need:power'}),
        message: () => answer({say: 'Hmm, the lights look dim.', action: 'none', target: ''})
    });
    const {ext} = make();
    ext.setValue({NAME: 'power_pct', VALUE: 12});
    await ext.sendValues();
    t.equal(ext.remarkWanted(), true);
    t.equal(ext.remarkFor(), 'need:power');
    await ext.sayRemark();
    t.equal(calls.length, 2);
    t.equal(calls[1].url, '/api/game/message');
    t.same(calls[1].body, {game: 'mars', remark: 'need:power'}, 'a remark has no text and no values');
    t.equal(ext.computerSays(), 'Hmm, the lights look dim.');
    t.equal(ext.replyToShow(), true);
    t.equal(ext.remarkWanted(), false, 'a grant is good for one message');
    t.equal(ext.remarkFor(), 'need:power', 'the subject stays for the game');
    await ext.sayRemark();
    t.equal(calls.length, 2, 'no grant, no call');
    t.equal(ext.replyKind(), 'silent');
    t.equal(ext.computerSays(), '');
    t.equal(ext.replyToShow(), false);
});

test('a station remark: look near grants it, and each later state view replaces the grant', async t => {
    const calls = goodServer({
        event: body => (body.how === 'near' ?
            view({remark: true, remark_for: body.station}) : view())
    });
    const {ext} = make();
    await ext.look({STATION: 'SolarPanels', HOW: 'near'});
    t.equal(ext.remarkWanted(), true);
    t.equal(ext.remarkFor(), 'SolarPanels');
    await ext.look({STATION: 'SolarPanels', HOW: 'open'});
    t.equal(ext.remarkWanted(), false);
    t.equal(ext.remarkFor(), '');
    await ext.sayRemark();
    t.equal(calls.length, 2);
    await ext.look({STATION: 'Bunk', HOW: 'near'});
    await ext.sayRemark();
    t.same(calls[3].body, {game: 'mars', remark: 'Bunk'});
});

test('a message of the player makes the grant of a remark out of date', async t => {
    const calls = goodServer({event: () => view({remark: true, remark_for: 'Bunk'})});
    const {ext} = make();
    await ext.look({STATION: 'Bunk', HOW: 'near'});
    await ext.tellComputer({TEXT: 'hi'});
    t.equal(ext.remarkWanted(), false);
    await ext.sayRemark();
    t.equal(calls.length, 2);
});

test('a silent reply and a stale reply are not for the screen', async t => {
    let next = null;
    goodServer({
        event: () => view({remark: true, remark_for: 'SolarPanels'}),
        message: () => next
    });
    const {ext} = make();
    await ext.look({STATION: 'SolarPanels', HOW: 'near'});
    next = answer({kind: 'silent', say: '', action: 'none', target: ''});
    await ext.sayRemark();
    t.equal(ext.status(), 200);
    t.equal(ext.replyKind(), 'silent');
    t.equal(ext.replyToShow(), false);
    await ext.look({STATION: 'SolarPanels', HOW: 'near'});
    next = answer({say: 'These are our solar panels.', stale: true});
    await ext.sayRemark();
    t.equal(ext.isStale(), true);
    t.equal(ext.computerSays(), 'These are our solar panels.');
    t.equal(ext.replyToShow(), false);
    next = answer({kind: 'fallback', say: 'Hmm, my thoughts got stuck in the dust.', action: 'none'});
    await ext.tellComputer({TEXT: 'hi'});
    t.equal(ext.replyKind(), 'fallback');
    t.equal(ext.replyToShow(), true, 'a fallback line shows');
});

test('a message with 409 or 429 does not throw, empties the reply, and the status tells', async t => {
    for (const status of [409, 429, 400, 503]) {
        fakeServer(url => (url === '/api/game/message' ?
            reply(status, {error: 'no'}) : reply(200, view({remark: true, remark_for: 'Bunk'}))));
        const {ext} = make();
        ext._reply.say = 'old words';
        await ext.tellComputer({TEXT: 'hi'});
        t.equal(ext.status(), status);
        t.equal(ext.computerSays(), '');
        t.equal(ext.replyToShow(), false);
        t.equal(ext.isThinking(), false);
        await ext.look({STATION: 'Bunk', HOW: 'near'});
        await ext.sayRemark();
        t.equal(ext.status(), status, 'a remark with an error status');
        t.equal(ext.replyToShow(), false);
        ext.setValue({NAME: 'sol', VALUE: 1});
        await ext.tellComputer({TEXT: 'hi'});
        await ext.look({STATION: 'Bunk', HOW: 'leave'});
        t.equal(ext.status(), 200, 'the next call works');
    }
});

test('tellComputer: a network failure gives status 0 and an empty reply', async t => {
    fakeServer(() => Promise.reject(new TypeError('Failed to fetch')));
    const {ext} = make();
    await ext.tellComputer({TEXT: 'hi'});
    t.equal(ext.status(), 0);
    t.equal(ext.computerSays(), '');
    t.equal(ext.isThinking(), false);
});

test('tellComputer: a call that never answers times out, and the script does not hang', async t => {
    fakeServer(() => new Promise(() => {}));
    const {ext} = make();
    ext._timeoutMs = 30;
    await ext.tellComputer({TEXT: 'hi'});
    t.equal(ext.status(), 0);
    t.equal(ext.isThinking(), false);
});

test('the default timeout is a little longer than the 8 s of the server', t => {
    const ext = new Mastra(new EventEmitter());
    t.equal(ext._timeoutMs, 12000);
    t.end();
});

test('tellComputer: an answer that is not JSON, or has no say, empties the reply and keeps the status', async t => {
    for (const body of ['<html>', {kind: 'mission'}, '[1]']) {
        fakeServer(() => reply(200, body));
        const {ext} = make();
        await ext.tellComputer({TEXT: 'hi'});
        t.equal(ext.status(), 200);
        t.equal(ext.computerSays(), '');
        t.equal(ext.replyToShow(), false);
    }
});

test('fresh: true makes the extension send the values and the broken sensors again', async t => {
    let fresh = false;
    const calls = goodServer({
        event: body => view({situation: body.event === 'sensors' ? 'sensor:water' : 'need:power', level: 1}),
        message: () => answer({fresh, situation: '', level: 0})
    });
    const {ext} = make();
    ext.setValue({NAME: 'sol', VALUE: 3});
    ext.setValue({NAME: 'power_pct', VALUE: 12});
    await ext.sendValues();
    await ext.setSensors({SENSORS: 'water'});
    await ext.tellComputer({TEXT: 'hi'});
    t.equal(calls.length, 3, 'no recovery without fresh');
    fresh = true;
    await ext.tellComputer({TEXT: 'are you there?'});
    t.equal(calls.length, 6);
    t.same(calls[4].body, {game: 'mars', event: 'set', values: 'sol=3;power_pct=12'});
    t.same(calls[5].body, {game: 'mars', event: 'sensors', unreliable: 'water'});
    t.equal(ext.isFresh(), true);
    t.equal(ext.computerSays(), 'The panels are dusty.', 'the reply of the message stays');
    t.equal(ext.replyToShow(), true);
    t.equal(ext.situation(), 'sensor:water', 'the view of the last recovery event');
    t.equal(ext.status(), 200);
    fresh = false;
    await ext.sendValues();
    t.equal(calls.length, 6, 'the recovery sent the values');
});

test('fresh on a remark: the recovery runs too, and no sensors event when no sensor is broken', async t => {
    const calls = goodServer({
        event: body => (body.event === 'look' ? view({remark: true, remark_for: 'Bunk'}) : view()),
        message: () => answer({fresh: true})
    });
    const {ext} = make();
    ext.setValue({NAME: 'sol', VALUE: 3});
    await ext.look({STATION: 'Bunk', HOW: 'near'});
    await ext.sayRemark();
    t.equal(calls.length, 3);
    t.same(calls[1].body, {game: 'mars', remark: 'Bunk'});
    t.same(calls[2].body, {game: 'mars', event: 'set', values: 'sol=3'});
});

test('fresh: a recovery that fails runs again before the next call, and the status is of the block', async t => {
    let setStatus = 409;
    const calls = fakeServer((url, init, body) => {
        if (url === '/api/game/message') return reply(200, answer({fresh: calls.length === 1}));
        if (body.event === 'set') return reply(setStatus, setStatus === 200 ? view() : {error: 'busy'});
        return reply(200, view());
    });
    const {ext} = make();
    ext.setValue({NAME: 'sol', VALUE: 3});
    ext._sensors = 'dose';
    await ext.tellComputer({TEXT: 'hi'});
    t.equal(calls.length, 2, 'the set event failed, so no sensors event');
    t.equal(ext.status(), 200, 'the status of the message');
    setStatus = 200;
    await ext.addNote({TEXT: 'x'});
    t.same(calls.slice(2).map(call => call.body.event), ['set', 'sensors', 'note']);
    t.same(calls[3].body, {game: 'mars', event: 'sensors', unreliable: 'dose'});
    await ext.addNote({TEXT: 'y'});
    t.equal(calls.length, 6, 'the recovery is done');
});

test('the main queue: messages and events never overlap, and each block waits for its own answer', async t => {
    let inFlight = 0;
    let most = 0;
    const calls = fakeServer((url, init, body) => {
        inFlight++;
        most = Math.max(most, inFlight);
        return new Promise(resolve => {
            setTimeout(() => {
                inFlight--;
                resolve(url === '/api/game/message' ? reply(200, answer({say: `re: ${body.text}`})) :
                    reply(200, view()));
            }, 10);
        });
    });
    const {ext} = make();
    ext.setValue({NAME: 'sol', VALUE: 1});
    const blocks = [
        ext.tellComputer({TEXT: 'one'}),
        ext.sendValuesAlways(),
        ext.wakeComputer(),
        ext.tellComputer({TEXT: 'two'}),
        ext.sayRemark()
    ];
    await blocks[0];
    t.equal(ext.computerSays(), 're: one');
    t.ok(calls.length <= 2, 'the next call starts only after the answer');
    await Promise.all(blocks);
    t.equal(most, 1);
    t.same(calls.map(call => call.body.event || call.body.text), ['one', 'set', 'wake', 'two']);
    t.equal(ext.computerSays(), '', 'the remark without a grant is the last reply');
});

test('look and result do not wait for a message, and they keep their own order', async t => {
    let release = null;
    const calls = fakeServer((url, init, body) => {
        if (url === '/api/game/message') {
            return new Promise(resolve => {
                release = () => resolve(reply(200, answer()));
            });
        }
        return reply(200, view({situation: body.event}));
    });
    const {ext} = make();
    const message = ext.tellComputer({TEXT: 'hi'});
    const note = ext.addNote({TEXT: 'x'});
    await Promise.all([
        ext.look({STATION: 'IceSite', HOW: 'open'}),
        ext.stationResult({STATION: 'IceSite', VALUES: 'ice=2'})
    ]);
    t.same(calls.map(call => call.body.event || 'message'), ['message', 'look', 'result']);
    t.equal(ext.isThinking(), true);
    release();
    await Promise.all([message, note]);
    t.equal(calls[3].body.event, 'note');
});

test('a failure of a call does not stop the next call of the queue', async t => {
    let count = 0;
    fakeServer(() => {
        count++;
        if (count === 1) return Promise.reject(new TypeError('Failed to fetch'));
        return reply(200, answer());
    });
    const {ext} = make();
    const first = ext.tellComputer({TEXT: 'one'});
    const second = ext.tellComputer({TEXT: 'two'});
    await first;
    t.equal(ext.status(), 0);
    await second;
    t.equal(ext.status(), 200);
    t.equal(ext.computerSays(), 'The panels are dusty.');
});

test('fact: a GET with the game and the id, and the part reports', async t => {
    const calls = fakeServer(() => reply(200, {
        id: 'insight_dust', title: 'Dust', text: 'Dust covered the panels.', source: 'https://nasa.gov/x'
    }));
    const {ext} = make();
    t.equal(await ext.fact({ID: ' insight_dust ', PART: 'text'}), 'Dust covered the panels.');
    t.equal(calls[0].url, '/api/game/fact?game=mars&id=insight_dust');
    t.notOk(calls[0].init.method, 'a GET');
    t.equal(calls[0].init.credentials, 'same-origin');
    t.equal(await ext.fact({ID: 'insight_dust', PART: 'title'}), 'Dust');
    t.equal(await ext.fact({ID: 'insight_dust', PART: 'source'}), 'https://nasa.gov/x');
    t.equal(await ext.fact({ID: 'insight_dust', PART: 'id'}), '', 'only the parts of the menu report');
    t.equal(ext.status(), 200);
});

test('fact: the id is escaped, and an error gives an empty string and the status', async t => {
    const calls = fakeServer(() => reply(404, {error: 'no fact card with this id'}));
    const {ext} = make();
    t.equal(await ext.fact({ID: 'a&b=c', PART: 'text'}), '');
    t.equal(calls[0].url, '/api/game/fact?game=mars&id=a%26b%3Dc');
    t.equal(ext.status(), 404);
    fakeServer(() => Promise.reject(new TypeError('Failed to fetch')));
    t.equal(await ext.fact({ID: 'x', PART: 'text'}), '');
    t.equal(ext.status(), 0);
});

test('the green flag resets the state of the run', async t => {
    const calls = goodServer({event: () => view({situation: 'need:food', level: 2, remark: true, remark_for: 'x'})});
    const {ext, runtime} = make();
    ext.setValue({NAME: 'sol', VALUE: 4});
    await ext.sendValues();
    await ext.setSensors({SENSORS: 'water'});
    await ext.tellComputer({TEXT: 'hi'});
    runtime.emit('PROJECT_START');
    t.equal(ext.computerSays(), '');
    t.equal(ext.status(), 0);
    t.equal(ext.situation(), '');
    t.equal(ext.hintLevel(), 0);
    t.equal(ext.remarkWanted(), false);
    t.equal(ext.valuesText(), '');
    t.equal(ext._sensors, '');
    await ext.tellComputer({TEXT: 'hi'});
    t.same(calls[3].body, {game: 'mars', text: 'hi'});
});

test('stop all: a call that has not started does not start, and an answer in flight is dropped', async t => {
    const calls = fakeServer(() => new Promise(resolve => {
        setTimeout(() => resolve(reply(200, answer({fresh: true}))), 30);
    }));
    const {ext, runtime} = make();
    ext.setValue({NAME: 'sol', VALUE: 4});
    const first = ext.tellComputer({TEXT: 'one'});
    const second = ext.tellComputer({TEXT: 'two'});
    const third = ext.sendValues();
    await new Promise(resolve => setTimeout(resolve, 5));
    runtime.emit('PROJECT_STOP_ALL');
    t.equal(ext.isThinking(), false);
    await Promise.all([first, second, third]);
    t.equal(calls.length, 1, 'the other calls never started, and the dropped answer starts no recovery');
    t.equal(ext.computerSays(), '');
    t.equal(ext.status(), 0);
    // The next run starts after the call in flight, so the server never answers 409.
    fakeServer(() => reply(200, answer({say: 'new run'})));
    await ext.tellComputer({TEXT: 'three'});
    t.equal(ext.computerSays(), 'new run');
});

test('the extension never logs the words of the player or the reply', async t => {
    const lines = [];
    const originals = {};
    for (const level of ['debug', 'info', 'warn', 'error', 'log']) {
        originals[level] = log[level];
        log[level] = (...args) => lines.push(args.join(' '));
    }
    const consoleOriginals = {};
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
        consoleOriginals[level] = console[level];
        console[level] = (...args) => lines.push(args.join(' '));
    }
    try {
        fakeServer(() => Promise.reject(new TypeError('Failed to fetch')));
        const {ext} = make();
        ext.setValue({NAME: 'sol', VALUE: 'secretvalue'});
        await ext.sendValues();
        await ext.tellComputer({TEXT: 'secretwords'});
        await ext.reportFail({CAUSE: 'secretcause'});
        await ext.addNote({TEXT: 'secretnote'});
        await ext.look({STATION: 'secretstation', HOW: 'near'});
        await ext.stationResult({STATION: 'secretstation', VALUES: 'secretresult=1'});
        await ext.fact({ID: 'secretid', PART: 'text'});
        fakeServer(() => reply(200, answer({say: 'secretreply'})));
        await ext.tellComputer({TEXT: 'secretwords'});
    } finally {
        for (const level of Object.keys(originals)) log[level] = originals[level];
        for (const level of Object.keys(consoleOriginals)) console[level] = consoleOriginals[level];
    }
    t.ok(lines.length > 0, 'a failed call logs a short warning');
    t.notOk(lines.some(line => /secret/.test(line)), lines.join('\n'));
});

/**
 * A fake audio engine. Each decoded line is a fake sound player that plays until `end()` or `stop()`.
 * @param {object} [options] The options.
 * @param {boolean} [options.badAudio] Decoding fails.
 * @returns {{engine: object, players: Array}} The engine and the players that it made.
 */
const fakeAudio = ({badAudio = false} = {}) => {
    const players = [];
    const engine = {
        decodeSoundPlayer: sound => {
            if (badAudio) return Promise.reject(new Error('EncodingError'));
            const player = new EventEmitter();
            Object.assign(player, {
                bytes: sound.data.buffer.byteLength,
                buffer: {duration: 0.05},
                target: null,
                playing: false,
                stopped: false,
                connect: target => {
                    player.target = target;
                },
                play: () => {
                    player.playing = true;
                },
                stop: () => {
                    if (!player.playing) return;
                    player.playing = false;
                    player.stopped = true;
                    player.emit('stop');
                },
                end: () => {
                    player.playing = false;
                    player.emit('stop');
                }
            });
            players.push(player);
            return Promise.resolve(player);
        }
    };
    return {engine, players};
};

/**
 * Make the extension with a runtime that has a fake audio engine.
 * @param {object} [options] The options of the fake audio engine.
 * @returns {{ext: Mastra, runtime: EventEmitter, players: Array}} The extension, its runtime and the players.
 */
const makeWithAudio = options => {
    const runtime = new EventEmitter();
    const {engine, players} = fakeAudio(options);
    runtime.audioEngine = engine;
    const ext = new Mastra(runtime);
    ext._timeoutMs = 200;
    return {ext, runtime, players, engine};
};

const audioReply = (status = 200) => Promise.resolve({
    ok: status === 200,
    status,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)),
    text: () => Promise.resolve(status === 200 ? '' : '{"error":"x"}')
});

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Tell if a promise has settled.
 * @param {Promise} promise The promise.
 * @returns {Promise.<boolean>} True when it has settled.
 */
const settled = promise => Promise.race([promise.then(() => true), tick().then(() => false)]);

test('speak: a POST with the text, and the block waits until the line has played', async t => {
    const calls = fakeServer(() => audioReply());
    const {ext, players, engine} = makeWithAudio();
    t.equal(ext.isSpeaking(), false);
    const block = ext.speak({TEXT: ' Oh good, you are awake. '});
    await tick();
    t.equal(calls.length, 1);
    t.equal(calls[0].url, '/api/speak');
    t.equal(calls[0].init.method, 'POST');
    t.equal(calls[0].init.credentials, 'same-origin');
    t.same(calls[0].body, {text: 'Oh good, you are awake.'});
    t.equal(players.length, 1);
    t.equal(players[0].target, engine, 'the line plays through the audio engine');
    t.equal(players[0].playing, true);
    t.equal(ext.isSpeaking(), true);
    t.equal(await settled(block), false, 'the block waits while the line plays');
    players[0].end();
    t.equal(await settled(block), true);
    t.equal(ext.isSpeaking(), false);
    t.equal(ext.status(), 200);
});

test('speak: stop speaking stops the line and ends the block at once', async t => {
    fakeServer(() => audioReply());
    const {ext, players} = makeWithAudio();
    const block = ext.speak({TEXT: 'one'});
    await tick();
    ext.stopSpeaking();
    t.equal(players[0].stopped, true);
    t.equal(ext.isSpeaking(), false);
    t.equal(await settled(block), true);
    ext.stopSpeaking();
});

test('speak: a new line replaces the line that plays, and the old block ends at once', async t => {
    fakeServer(() => audioReply());
    const {ext, players} = makeWithAudio();
    const first = ext.speak({TEXT: 'one'});
    await tick();
    const second = ext.speak({TEXT: 'two'});
    t.equal(players[0].stopped, true);
    t.equal(await settled(first), true);
    await tick();
    t.equal(players.length, 2);
    t.equal(players[1].playing, true);
    t.equal(ext.isSpeaking(), true);
    players[1].end();
    t.equal(await settled(second), true);
    t.equal(ext.isSpeaking(), false);
});

test('speak: a new line drops a line that still waits for its audio', async t => {
    let answerFirst = null;
    const calls = fakeServer((url, init, body) => {
        if (body.text !== 'one') return audioReply();
        return new Promise(resolve => {
            answerFirst = () => resolve(audioReply());
        });
    });
    const {ext, players} = makeWithAudio();
    const first = ext.speak({TEXT: 'one'});
    await tick();
    const second = ext.speak({TEXT: 'two'});
    t.equal(await settled(first), true, 'the old block ends before its answer');
    await tick();
    answerFirst();
    await tick();
    t.equal(calls.length, 2);
    t.equal(players.length, 1, 'the old line never plays');
    players[0].end();
    t.equal(await settled(second), true);
});

test('speak: stop all stops the line and ends the block', async t => {
    fakeServer(() => audioReply());
    const {ext, runtime, players} = makeWithAudio();
    const block = ext.speak({TEXT: 'one'});
    await tick();
    runtime.emit('PROJECT_STOP_ALL');
    t.equal(players[0].stopped, true);
    t.equal(ext.isSpeaking(), false);
    t.equal(await settled(block), true);
});

test('speak: each failure ends the block at once, and the status tells it', async t => {
    for (const status of [400, 429, 502, 503, 204]) {
        fakeServer(() => audioReply(status));
        const {ext, players} = makeWithAudio();
        await ext.speak({TEXT: 'one'});
        t.equal(ext.status(), status, String(status));
        t.equal(players.length, 0, String(status));
        t.equal(ext.isSpeaking(), false);
    }
    fakeServer(() => Promise.reject(new TypeError('Failed to fetch')));
    const offline = makeWithAudio();
    await offline.ext.speak({TEXT: 'one'});
    t.equal(offline.ext.status(), 0, 'no network');
    fakeServer(() => new Promise(() => {}));
    const slow = makeWithAudio();
    await slow.ext.speak({TEXT: 'one'});
    t.equal(slow.ext.status(), 0, 'a call that never answers times out');
    fakeServer(() => audioReply());
    const bad = makeWithAudio({badAudio: true});
    await bad.ext.speak({TEXT: 'one'});
    t.equal(bad.ext.status(), 0, 'audio that does not decode');
    t.equal(bad.ext.isSpeaking(), false);
});

test('speak: no audio engine or an empty text makes no call', async t => {
    const calls = fakeServer(() => audioReply());
    const {ext} = make();
    ext._status = 200;
    t.notOk(ext.speak({TEXT: 'one'}), 'the block ends at once');
    t.equal(ext.status(), 0);
    const withAudio = makeWithAudio();
    t.notOk(withAudio.ext.speak({TEXT: '   '}));
    t.equal(calls.length, 0);
});

test('speak: a line that never ends (a suspended audio context) ends after its length and a grace time', async t => {
    fakeServer(() => audioReply());
    const {ext, players} = makeWithAudio();
    ext._speakGraceMs = 20;
    const block = ext.speak({TEXT: 'one'});
    await tick();
    t.equal(ext.isSpeaking(), true);
    await tick(100);
    t.equal(await settled(block), true);
    t.equal(players[0].stopped, true);
    t.equal(ext.isSpeaking(), false);
});

test('speak: the extension never logs the words of the line', async t => {
    const lines = [];
    const original = log.warn;
    log.warn = (...args) => lines.push(args.join(' '));
    try {
        fakeServer(() => Promise.reject(new TypeError('Failed to fetch')));
        const {ext} = makeWithAudio();
        await ext.speak({TEXT: 'secretline'});
    } finally {
        log.warn = original;
    }
    t.ok(lines.length > 0);
    t.notOk(lines.some(line => /secret/.test(line)), lines.join('\n'));
});

test('get voice ready: the block waits for the audio, plays nothing, and the reporters tell the line', async t => {
    const calls = fakeServer(() => audioReply());
    const {ext, players} = makeWithAudio();
    t.equal(ext.speechReady(), false);
    t.equal(ext.speechLength(), 0);
    t.equal(ext.speechTime(), 0);
    await ext.loadSpeech({TEXT: ' Oh good, you are awake. '});
    t.equal(calls.length, 1);
    t.equal(calls[0].url, '/api/speak');
    t.same(calls[0].body, {text: 'Oh good, you are awake.'});
    t.equal(ext.status(), 200);
    t.equal(players.length, 1);
    t.equal(players[0].playing, false, 'the line does not play yet');
    t.equal(ext.speechReady(), true);
    t.equal(ext.speechLength(), 0.05);
    t.equal(ext.isSpeaking(), false);
    t.equal(ext.speechTime(), 0);
});

test('play voice: it plays the ready line, waits until the end, and voice time runs', async t => {
    fakeServer(() => audioReply());
    const {ext, players, engine} = makeWithAudio();
    await ext.loadSpeech({TEXT: 'one'});
    const block = ext.playSpeech();
    t.equal(players[0].target, engine);
    t.equal(players[0].playing, true);
    t.equal(ext.speechReady(), false, 'the line is not ready any more: it plays');
    t.equal(ext.isSpeaking(), true);
    t.equal(ext.speechLength(), 0.05, 'the length of the line that plays');
    await tick(20);
    t.ok(ext.speechTime() > 0.01 && ext.speechTime() <= 0.05, String(ext.speechTime()));
    t.equal(await settled(block), false, 'the block waits while the line plays');
    await tick(60);
    t.equal(ext.speechTime(), 0.05, 'voice time is at most the length');
    players[0].end();
    t.equal(await settled(block), true);
    t.equal(ext.isSpeaking(), false);
    t.equal(ext.speechLength(), 0);
    t.equal(ext.speechTime(), 0);
});

test('play voice: with no ready line the block ends at once and makes no call', async t => {
    const calls = fakeServer(() => audioReply());
    const {ext, players} = makeWithAudio();
    t.notOk(ext.playSpeech());
    await ext.loadSpeech({TEXT: 'one'});
    const block = ext.playSpeech();
    t.notOk(ext.playSpeech(), 'a line plays one time only');
    t.equal(players[0].stopped, true, 'and a second play voice stops the line, as stop speaking');
    t.equal(await settled(block), true);
    t.equal(calls.length, 1);
});

test('get voice ready: the line that plays continues, and play voice replaces it', async t => {
    fakeServer(() => audioReply());
    const {ext, players} = makeWithAudio();
    const first = ext.speak({TEXT: 'one'});
    await tick();
    await ext.loadSpeech({TEXT: 'two'});
    t.equal(players[0].playing, true, 'the old line still plays');
    t.equal(ext.speechReady(), true);
    t.equal(await settled(first), false);
    const second = ext.playSpeech();
    t.equal(players[0].stopped, true);
    t.equal(await settled(first), true, 'the block of the old line ends');
    t.equal(players[1].playing, true);
    players[1].end();
    t.equal(await settled(second), true);
});

test('get voice ready: a newer block drops the older line, and the older block ends at once', async t => {
    let answerFirst = null;
    fakeServer((url, init, body) => {
        if (body.text !== 'one') return audioReply();
        return new Promise(resolve => {
            answerFirst = () => resolve(audioReply());
        });
    });
    const {ext, players} = makeWithAudio();
    const first = ext.loadSpeech({TEXT: 'one'});
    await tick();
    const second = ext.loadSpeech({TEXT: 'two'});
    t.equal(await settled(first), true, 'the old block ends before its answer');
    await second;
    answerFirst();
    await tick();
    t.equal(players.length, 1, 'the audio of the old line is not decoded');
    t.equal(ext.speechReady(), true);
    ext.playSpeech();
    t.equal(players[0].playing, true);
    ext.stopSpeaking();
});

test('get voice ready: stop speaking, a new speak and stop all drop the ready line', async t => {
    fakeServer(() => audioReply());
    const {ext, runtime, players} = makeWithAudio();
    await ext.loadSpeech({TEXT: 'one'});
    ext.stopSpeaking();
    t.equal(ext.speechReady(), false);
    t.notOk(ext.playSpeech());
    await ext.loadSpeech({TEXT: 'two'});
    runtime.emit('PROJECT_STOP_ALL');
    t.equal(ext.speechReady(), false);
    await ext.loadSpeech({TEXT: 'three'});
    const line = ext.speak({TEXT: 'four'});
    t.equal(ext.speechReady(), false);
    await tick();
    t.equal(players[3].playing, true);
    t.notOk(players.slice(0, 3).some(player => player.playing));
    players[3].end();
    await line;
    const waiting = ext.loadSpeech({TEXT: 'five'});
    ext.stopSpeaking();
    t.equal(await settled(waiting), true, 'a block that waits for its audio ends at a stop');
    await tick();
    t.equal(ext.speechReady(), false);
});

test('get voice ready: each failure ends the block with no ready line, and the status tells it', async t => {
    for (const status of [400, 429, 502, 503, 204]) {
        fakeServer(() => audioReply(status));
        const {ext, players} = makeWithAudio();
        await ext.loadSpeech({TEXT: 'one'});
        t.equal(ext.status(), status, String(status));
        t.equal(players.length, 0, String(status));
        t.equal(ext.speechReady(), false);
        t.equal(ext.speechLength(), 0);
    }
    fakeServer(() => new Promise(() => {}));
    const slow = makeWithAudio();
    await slow.ext.loadSpeech({TEXT: 'one'});
    t.equal(slow.ext.status(), 0, 'a call that never answers times out');
    fakeServer(() => audioReply());
    const bad = makeWithAudio({badAudio: true});
    await bad.ext.loadSpeech({TEXT: 'one'});
    t.equal(bad.ext.status(), 0, 'audio that does not decode');
    t.equal(bad.ext.speechReady(), false);
    const calls = fakeServer(() => audioReply());
    const {ext} = make();
    ext._status = 200;
    t.notOk(ext.loadSpeech({TEXT: 'one'}), 'no audio engine: the block ends at once');
    t.equal(ext.status(), 0);
    t.notOk(makeWithAudio().ext.loadSpeech({TEXT: '  '}), 'an empty text');
    t.equal(calls.length, 0);
});

test('play voice: a line that never ends (a suspended audio context) ends after its length and a grace', async t => {
    fakeServer(() => audioReply());
    const {ext, players} = makeWithAudio();
    ext._speakGraceMs = 20;
    await ext.loadSpeech({TEXT: 'one'});
    const block = ext.playSpeech();
    await tick(100);
    t.equal(await settled(block), true);
    t.equal(players[0].stopped, true);
    t.equal(ext.isSpeaking(), false);
});
