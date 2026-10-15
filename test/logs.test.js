// -----------------------------------------------------------------------------
// What the integration writes at the default level (info): the lifecycle
// only. A normal cycle (idle events, readings, states) writes nothing, a
// player that stays away is logged once, and its return once. Never a
// password, nor credentials of an address.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_KEYS } from '../src/devices.js';
import {
  FakeMpd,
  LIBRARY,
  createAll,
  createWorld,
  deviceId,
  eventually,
  featureOf,
  settle,
} from './helpers/world.js';

/** Capture the lines of the SDK logger at LOG_LEVEL=info (or another level). */
function captureLogs(t, level = 'info') {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  const lines = [];
  const record =
    (stream) =>
    (...args) =>
      lines.push({
        stream,
        text: args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '),
      });
  t.mock.method(console, 'log', record('out'));
  t.mock.method(console, 'error', record('err'));
  t.mock.method(console, 'warn', record('err'));
  t.mock.method(console, 'info', record('out'));
  t.mock.method(console, 'debug', record('out'));
  return {
    lines,
    clear: () => lines.splice(0),
    texts: () => lines.map((line) => line.text),
  };
}

async function world(t, options = {}) {
  const w = await createWorld({ timers: true, timings: { refreshMs: 50 }, ...options });
  t.after(() => w.stop());
  return w;
}

test('a normal cycle writes nothing at info', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  assert.ok(
    logs.texts().some((text) => /Player 1 \(Salon\): connected \(MPD 0\.23\.5\)/.test(text)),
    `the start is logged: ${logs.texts().join('\n')}`,
  );
  await createAll(w);
  logs.clear();

  // Songs change, the volume moves, the timer reads the player, the widget is drawn.
  w.mpd.enqueue(...Object.keys(LIBRARY).slice(0, 3));
  w.mpd.commands.play();
  for (let i = 0; i < 3; i += 1) {
    w.mpd.play(10);
    w.mpd.commands.setvol(String(50 + i));
    w.mpd.finishSong();
    await settle(80);
  }
  await w.fake.widgetGet('player', { settings: {}, language: 'en' });
  await eventually(
    () => w.fake.lastState(w.gladys.externalIds('mpd', '1').feature('volume')) === 52,
  );
  assert.deepEqual(logs.texts(), []);
});

test('a player that stays away is logged once, and once when it is back', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  logs.clear();
  await w.mpd.goOffline();
  // Several reconnection attempts and timer ticks.
  await settle(400);
  const down = logs.lines.filter((line) => line.stream === 'err');
  assert.equal(down.length, 1, logs.texts().join('\n'));
  assert.match(down[0].text, /connection lost/);
  assert.equal(logs.lines.length, 1, logs.texts().join('\n'));

  logs.clear();
  await w.mpd.goOnline();
  await eventually(() => logs.lines.length > 0, 3_000);
  await settle(200);
  assert.equal(logs.lines.length, 1, logs.texts().join('\n'));
  assert.match(logs.lines[0].text, /connection restored/);
});

test('a refused password is logged once, never the password', async (t) => {
  const logs = captureLogs(t);
  const mpd = new FakeMpd({ password: 'right-password' });
  const w = await world(t, { servers: [mpd], config: { player_1_password: 'wrong-password' } });
  await settle(300);
  await w.fake.action('test_connection', {});
  const warnings = logs.lines.filter((line) => line.stream === 'err');
  assert.equal(warnings.length, 1, logs.texts().join('\n'));
  assert.match(warnings[0].text, /incorrect password/);
  const all = logs.texts().join('\n');
  assert.ok(
    !all.includes('wrong-password') && !all.includes('right-password'),
    'never the password',
  );
});

test('one info line per command of the user, and never the credentials of an address', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t, { timings: { refreshMs: 60_000 } });
  await createAll(w);
  logs.clear();
  const { device, feature } = featureOf(w, FEATURE_KEYS.PLAY);
  await w.fake.setValue(device, feature, 1);
  await w.fake.sceneAction('play_url', {
    device: deviceId(w.gladys),
    url: 'http://user:secret-token@radio.example.com/stream.mp3',
    after: 'keep',
  });
  const texts = logs.texts();
  assert.equal(texts.length, 2, texts.join('\n'));
  assert.match(texts[0], /Player 1 \(Salon\): play$/);
  assert.match(texts[1], /play http:\/\/radio\.example\.com\/stream\.mp3/);
  assert.ok(!texts.join('\n').includes('secret-token'));
});

test('LOG_LEVEL=debug shows the idle events and the readings', async (t) => {
  const logs = captureLogs(t, 'debug');
  const w = await world(t, { timings: { refreshMs: 60_000 } });
  logs.clear();
  w.mpd.commands.setvol('61');
  await eventually(() => logs.texts().some((text) => /\[DEBUG\].*changed mixer/.test(text)));
  await w.fake.widgetGet('player', { settings: {}, language: 'en' });
  assert.ok(!logs.texts().join('\n').includes('password'));
});
