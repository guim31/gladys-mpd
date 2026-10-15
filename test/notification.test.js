// -----------------------------------------------------------------------------
// The notification of a player (music/play_notification, the "Talk on a
// speaker" scene action of Gladys, and the "Play an address" scene action):
// the address plays, then what was playing comes back exactly as it was —
// queue, song, position, paused or playing, volume and options.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_KEYS } from '../src/devices.js';
import {
  FakeMpd,
  LIBRARY,
  RADIO,
  createAll,
  createWorld,
  deviceId,
  eventually,
  featureOf,
  settle,
} from './helpers/world.js';

const [ONE_MORE_TIME, AERODYNAMIC] = Object.keys(LIBRARY);
const DOORBELL = 'sounds/doorbell.mp3';
const BROKEN = 'http://192.0.2.1/missing.mp3';

async function world(t, { mpd = new FakeMpd(), config = {}, playerTimings } = {}) {
  const w = await createWorld({
    servers: [mpd],
    config,
    // Player timers on (stream detection, timeout); the hub refresh far away.
    timers: true,
    timings: { refreshMs: 60_000 },
    ...(playerTimings ? { playerTimings } : {}),
  });
  t.after(() => w.stop());
  await createAll(w);
  return w;
}

/** The music the user listens to: song 1 of 2, at 30 s, playing. */
function listening(mpd, { state = 'play' } = {}) {
  mpd.enqueue(ONE_MORE_TIME, AERODYNAMIC);
  mpd.commands.play();
  mpd.play(30);
  if (state === 'pause') {
    mpd.commands.pause('1');
  }
}

async function notify(w, uri) {
  const { device, feature } = featureOf(w, FEATURE_KEYS.NOTIFICATION);
  const ack = await w.fake.setValue(device, feature, uri);
  assert.equal(ack.success, true, ack.error);
}

const titles = (mpd) => mpd.queue.map((song) => song.Title ?? song.file);
const player = (w) => w.hub.records.get(1).player;

test('a doorbell sound plays at the notification volume, then the song resumes where it was', async (t) => {
  const w = await world(t, { config: { notification_volume: '70' } });
  listening(w.mpd);
  await settle();
  await notify(w, DOORBELL);

  assert.deepEqual(titles(w.mpd), ['One More Time', 'Aerodynamic', 'Doorbell']);
  assert.equal(w.mpd.queue[w.mpd.current].Title, 'Doorbell');
  assert.equal(w.mpd.state, 'play');
  assert.equal(w.mpd.single, '1', 'MPD stops after the notification');
  assert.equal(w.mpd.volume, 70);

  w.mpd.play(1);
  w.mpd.finishSong();
  await eventually(() => player(w).notification === null && w.mpd.state === 'play');
  await settle();

  assert.deepEqual(titles(w.mpd), ['One More Time', 'Aerodynamic']);
  assert.equal(w.mpd.current, 0);
  assert.equal(w.mpd.elapsed, 30);
  assert.equal(w.mpd.single, '0');
  assert.equal(w.mpd.volume, 40);
});

test('paused music stays paused, at its position', async (t) => {
  const w = await world(t);
  listening(w.mpd, { state: 'pause' });
  await settle();
  await notify(w, DOORBELL);
  w.mpd.finishSong();
  await eventually(() => player(w).notification === null);
  await settle();
  assert.equal(w.mpd.state, 'pause');
  assert.equal(w.mpd.current, 0);
  assert.equal(w.mpd.elapsed, 30);
  assert.equal(w.mpd.volume, 40, 'volume unchanged ("keep")');
});

test('on a stopped player with an empty queue, nothing is left behind', async (t) => {
  const w = await world(t);
  await notify(w, DOORBELL);
  w.mpd.finishSong();
  await eventually(() => player(w).notification === null);
  await settle();
  assert.deepEqual(w.mpd.queue, []);
  assert.equal(w.mpd.state, 'stop');
});

test('consume and repeat are put back, and the interrupted song is not consumed', async (t) => {
  const w = await world(t);
  listening(w.mpd);
  w.mpd.commands.consume('1');
  w.mpd.commands.repeat('1');
  await settle();
  await notify(w, DOORBELL);
  assert.equal(w.mpd.consume, '0');
  assert.equal(w.mpd.repeat, false);
  w.mpd.finishSong();
  await eventually(() => player(w).notification === null);
  await settle();
  assert.equal(w.mpd.consume, '1');
  assert.equal(w.mpd.repeat, true);
  assert.deepEqual(titles(w.mpd), ['One More Time', 'Aerodynamic']);
  assert.equal(w.mpd.elapsed, 30);
});

test('a second notification replaces the first, and the music comes back once', async (t) => {
  const w = await world(t, { config: { notification_volume: '70' } });
  listening(w.mpd);
  await settle();
  await notify(w, DOORBELL);
  await notify(w, 'Untagged/track07.mp3');
  assert.deepEqual(titles(w.mpd), ['One More Time', 'Aerodynamic', 'Untagged/track07.mp3']);
  w.mpd.play(1);
  w.mpd.finishSong();
  await eventually(() => player(w).notification === null && w.mpd.state === 'play');
  await settle();
  assert.deepEqual(titles(w.mpd), ['One More Time', 'Aerodynamic']);
  assert.equal(w.mpd.elapsed, 30);
  assert.equal(w.mpd.volume, 40, 'the volume saved by the first one');
  assert.equal(w.mpd.single, '0');
});

test('someone taking over the player ends the notification without touching the playback', async (t) => {
  const w = await world(t);
  listening(w.mpd);
  await settle();
  await notify(w, DOORBELL);
  // Another client plays the second song.
  w.mpd.commands.playid(String(w.mpd.queue[1].id));
  await eventually(() => player(w).notification === null);
  await settle();
  assert.deepEqual(titles(w.mpd), ['One More Time', 'Aerodynamic']);
  assert.equal(w.mpd.current, 1);
  assert.equal(w.mpd.elapsed, 0);
  assert.equal(w.mpd.single, '0');
});

test('a web radio sent as a notification keeps playing', async (t) => {
  const w = await world(t);
  listening(w.mpd);
  await settle();
  await notify(w, RADIO);
  w.mpd.play(1);
  await eventually(() => player(w).notification === null, 3_000);
  await settle();
  assert.equal(w.mpd.queue[w.mpd.current].file, RADIO);
  assert.equal(w.mpd.state, 'play');
  assert.equal(w.mpd.single, '0', 'options put back');
});

test('a notification paused by someone ends after the longest wait', async (t) => {
  const w = await world(t, {
    playerTimings: {
      reconnectMs: [30],
      notificationMaxMs: 200,
      streamAfterMs: 150,
      startTimeoutMs: 1_000,
      startCheckMs: 20,
    },
  });
  listening(w.mpd);
  await settle();
  await notify(w, DOORBELL);
  w.mpd.commands.pause('1');
  await eventually(() => player(w).notification === null && w.mpd.state === 'play');
  await settle();
  assert.deepEqual(titles(w.mpd), ['One More Time', 'Aerodynamic']);
  assert.equal(w.mpd.elapsed, 30);
});

test('the "Play an address" scene action reports an address MPD cannot play, and puts the music back', async (t) => {
  const w = await world(t);
  w.mpd.urls[BROKEN] = { fail: 'Failed to open "http://192.0.2.1/missing.mp3" (404 Not Found)' };
  listening(w.mpd);
  await settle();
  const ack = await w.fake.sceneAction('play_url', { device: deviceId(w.gladys), url: BROKEN });
  assert.equal(ack.success, false);
  assert.match(ack.error, /could not play this address/);
  await eventually(() => w.mpd.state === 'play' && w.mpd.current === 0);
  assert.deepEqual(titles(w.mpd), ['One More Time', 'Aerodynamic']);
  assert.equal(w.mpd.elapsed, 30);
});

test('the scene action waits for the address to play, with its own volume', async (t) => {
  const w = await world(t);
  listening(w.mpd);
  await settle();
  const pending = w.fake.sceneAction('play_url', {
    device: deviceId(w.gladys),
    url: DOORBELL,
    volume: 25,
    after: 'resume',
  });
  await eventually(() => w.mpd.queue.length === 3);
  w.mpd.play(0.5);
  const ack = await pending;
  assert.equal(ack.success, true, ack.error);
  assert.equal(w.mpd.volume, 25);
  w.mpd.finishSong();
  await eventually(() => player(w).notification === null && w.mpd.volume === 40);
});

test('"Keep playing it" replaces the queue with the address', async (t) => {
  const w = await world(t);
  listening(w.mpd);
  const ack = await w.fake.sceneAction('play_url', {
    device: deviceId(w.gladys),
    url: RADIO,
    after: 'keep',
  });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    w.mpd.queue.map((song) => song.file),
    [RADIO],
  );
  assert.equal(w.mpd.state, 'play');
});

test('an address MPD refuses (file://, unknown path) changes nothing', async (t) => {
  const w = await world(t);
  listening(w.mpd);
  await settle();
  const { device, feature } = featureOf(w, FEATURE_KEYS.NOTIFICATION);
  let ack = await w.fake.setValue(device, feature, 'file:///etc/passwd');
  assert.equal(ack.success, false);
  assert.match(ack.error, /web address/);
  ack = await w.fake.setValue(device, feature, 'no/such/file.mp3');
  assert.equal(ack.success, false);
  assert.match(ack.error, /refused the command/);
  assert.deepEqual(titles(w.mpd), ['One More Time', 'Aerodynamic']);
  assert.equal(w.mpd.single, '0');
  assert.equal(w.mpd.state, 'play');
});

test('two notifications sent at the same instant: the music still comes back', async (t) => {
  const w = await world(t, { config: { notification_volume: '70' } });
  listening(w.mpd);
  await settle();
  await Promise.all([notify(w, DOORBELL), notify(w, 'Untagged/track07.mp3')]);
  assert.equal(w.mpd.queue.length, 3, 'the first one was replaced');
  w.mpd.play(1);
  w.mpd.finishSong();
  await eventually(() => player(w).notification === null && w.mpd.state === 'play');
  await settle();
  assert.deepEqual(titles(w.mpd), ['One More Time', 'Aerodynamic']);
  assert.equal(w.mpd.elapsed, 30);
  assert.equal(w.mpd.volume, 40);
});
