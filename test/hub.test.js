// -----------------------------------------------------------------------------
// The integration end to end: the SDK's fake Gladys on one side, fake MPD
// servers on real sockets on the other — discovery, states pushed by idle,
// the container's own refresh, commands, reconnection, configuration changes.
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
  featureId,
  featureOf,
  settle,
} from './helpers/world.js';

const [ONE_MORE_TIME, AERODYNAMIC] = Object.keys(LIBRARY);

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.stop());
  return w;
}

test('one device per configured player, published at start', async (t) => {
  const w = await world(t, { servers: [new FakeMpd(), new FakeMpd({ volume: null })] });
  const devices = w.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((device) => device.name),
    ['Salon', 'Cuisine'],
  );
  assert.equal(devices[0].external_id, deviceId(w.gladys, 1));
  assert.equal(w.fake.connectionStatus.connected, true);
  // The playlist select lists the stored playlists, sorted.
  const playlist = devices[0].features.find(
    (f) => f.external_id === featureId(w.gladys, FEATURE_KEYS.PLAYLIST),
  );
  assert.deepEqual(
    playlist.supported_options.map((o) => o.value),
    ['Apéro', 'Morning jazz'],
  );
});

test('the states of an added device follow the player through idle, without any poll', async (t) => {
  const w = await world(t);
  await createAll(w);
  const volume = featureId(w.gladys, FEATURE_KEYS.VOLUME);
  const playback = featureId(w.gladys, FEATURE_KEYS.PLAYBACK_STATE);
  assert.equal(w.fake.lastState(volume), 40);
  assert.equal(w.fake.lastState(playback), 0);

  // Another client (moOde, a phone app) plays a song and turns the volume up.
  w.mpd.enqueue(ONE_MORE_TIME, AERODYNAMIC);
  w.mpd.commands.play();
  w.mpd.commands.setvol('65');
  await eventually(() => w.fake.lastState(playback) === 1 && w.fake.lastState(volume) === 65);
});

test('the container refreshes on its own timer when an event is lost (no onPoll)', async (t) => {
  const w = await world(t, { timers: true, timings: { refreshMs: 100 } });
  await createAll(w);
  const volume = featureId(w.gladys, FEATURE_KEYS.VOLUME);
  w.mpd.setVolumeSilently(12);
  await eventually(() => w.fake.lastState(volume) === 12);
  assert.ok(
    !w.fake.wsMessages.some((message) => message.type?.includes('poll')),
    'no poll was needed',
  );
});

test('the core onPoll is a fallback, skipped right after a reading', async (t) => {
  const w = await world(t);
  await createAll(w);
  const before = w.mpd.commandNames().filter((name) => name === 'status').length;
  const { device } = featureOf(w, FEATURE_KEYS.VOLUME);
  assert.equal((await w.fake.poll(device)).success, true);
  await settle();
  const after = w.mpd.commandNames().filter((name) => name === 'status').length;
  assert.equal(after, before, 'read less than half a period ago: skipped');
});

test('play, pause, next, previous and volume reach MPD', async (t) => {
  const w = await world(t);
  await createAll(w);
  w.mpd.enqueue(ONE_MORE_TIME, AERODYNAMIC);
  const set = async (key, value) => {
    const { device, feature } = featureOf(w, key);
    const ack = await w.fake.setValue(device, feature, value);
    assert.equal(ack.success, true, ack.error);
  };
  await set(FEATURE_KEYS.PLAY, 1);
  assert.equal(w.mpd.state, 'play');
  await set(FEATURE_KEYS.NEXT, 1);
  assert.equal(w.mpd.current, 1);
  await set(FEATURE_KEYS.PREVIOUS, 1);
  assert.equal(w.mpd.current, 0);
  w.mpd.play(30);
  await set(FEATURE_KEYS.PAUSE, 1);
  assert.equal(w.mpd.state, 'pause');
  // Play after pause resumes (pause 0), it does not restart the song.
  await set(FEATURE_KEYS.PLAY, 1);
  assert.equal(w.mpd.state, 'play');
  assert.equal(w.mpd.elapsed, 30);
  await set(FEATURE_KEYS.VOLUME, 72);
  assert.equal(w.mpd.volume, 72);
  await eventually(() => w.fake.lastState(featureId(w.gladys, FEATURE_KEYS.VOLUME)) === 72);
});

test('picking a playlist in the select replaces the queue and plays it', async (t) => {
  const w = await world(t);
  await createAll(w);
  w.mpd.enqueue(AERODYNAMIC);
  const { device, feature } = featureOf(w, FEATURE_KEYS.PLAYLIST);
  const ack = await w.fake.setValue(device, feature, 'Apéro');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    w.mpd.queue.map((song) => song.Title),
    ['One More Time', 'La femme d’argent'],
  );
  assert.equal(w.mpd.state, 'play');
});

test('a player without mixer has no volume state, and a clear refusal', async (t) => {
  const w = await world(t, { servers: [new FakeMpd({ volume: null })] });
  await createAll(w);
  assert.equal(w.fake.lastState(featureId(w.gladys, FEATURE_KEYS.VOLUME)), undefined);
  const { device, feature } = featureOf(w, FEATURE_KEYS.VOLUME);
  const ack = await w.fake.setValue(device, feature, 50);
  assert.equal(ack.success, false);
  assert.match(ack.error, /no volume control/);
});

test('a saved playlist updates the options of the select', async (t) => {
  const w = await world(t);
  await createAll(w);
  w.mpd.commands.save('Soirée');
  await eventually(() => {
    const { feature } = featureOf(w, FEATURE_KEYS.PLAYLIST);
    return feature.supported_options.some((option) => option.value === 'Soirée');
  });
});

test('a password is sent, and a wrong one is reported without being logged', async (t) => {
  const mpd = new FakeMpd({ password: 'right-password' });
  const w = await world(t, { servers: [mpd], config: { player_1_password: 'wrong-password' } });
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /password refused/);
  await w.fake.configUpdated({ ...w.fake.config, player_1_password: 'right-password' });
  assert.equal(w.fake.connectionStatus.connected, true);
});

test('a lost player comes back on its own, and its device follows', async (t) => {
  const w = await world(t, { timers: true, timings: { refreshMs: 100 } });
  await createAll(w);
  const id = deviceId(w.gladys);
  const transport = () =>
    w.fake.transports.filter((e) => e.device_external_id === id).at(-1)?.transport;
  assert.equal(transport(), 'local');
  await w.mpd.goOffline();
  await eventually(() => w.fake.connectionStatus.connected === false);
  assert.equal(transport(), 'unreachable');
  await w.mpd.goOnline();
  await eventually(() => w.fake.connectionStatus.connected === true, 3_000);
  assert.equal(transport(), 'local');
  w.mpd.commands.setvol('33');
  await eventually(() => w.fake.lastState(featureId(w.gladys, FEATURE_KEYS.VOLUME)) === 33);
});

test('removing a player from the configuration closes its connection', async (t) => {
  const w = await world(t, { servers: [new FakeMpd(), new FakeMpd()] });
  assert.equal(w.mpds[1].clients.size, 1);
  await w.fake.configUpdated({ ...w.fake.config, player_2_address: '' });
  await eventually(() => w.mpds[1].clients.size === 0);
  assert.deepEqual(
    w.fake.discoveredDevices.map((device) => device.name),
    ['Salon'],
  );
});

test('the "Test the connection" button reports every player', async (t) => {
  const w = await world(t, {
    servers: [new FakeMpd()],
    config: { player_2_address: '127.0.0.1:1' },
  });
  const ack = await w.fake.action('test_connection', {});
  assert.equal(ack.success, true, ack.error);
  const lines = ack.data.message.en.split('\n');
  assert.match(
    lines[0],
    /^Salon \(127\.0\.0\.1:\d+\): MPD 0\.23\.5, stopped, volume 40 %, 2 playlist\(s\)$/,
  );
  assert.match(lines[1], /does not answer/);
});

test('a device updated in Gladys gets its states again', async (t) => {
  const w = await world(t);
  await createAll(w);
  const volume = featureId(w.gladys, FEATURE_KEYS.VOLUME);
  const before = w.fake.states.filter((s) => s.device_feature_external_id === volume).length;
  await w.fake.deviceUpdated(w.fake.discoveredDevices[0]);
  const after = w.fake.states.filter((s) => s.device_feature_external_id === volume).length;
  assert.equal(after, before + 1);
});
