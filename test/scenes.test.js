// -----------------------------------------------------------------------------
// The scene actions (manifest `scene_actions`), as the scene engine of Gladys
// calls them: resolved fields, a device external id from `source: "devices"`.
// The address one (play_url) is tested with the notifications.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeMpd, LIBRARY, createWorld, deviceId } from './helpers/world.js';

const [ONE_MORE_TIME] = Object.keys(LIBRARY);

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.stop());
  return w;
}

test('play_playlist: the name is found without case nor accents, the queue is replaced', async (t) => {
  const w = await world(t);
  w.mpd.enqueue(ONE_MORE_TIME);
  const ack = await w.fake.sceneAction('play_playlist', {
    device: deviceId(w.gladys),
    playlist: '  APERO ',
  });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { songs: 2 });
  assert.equal(w.mpd.state, 'play');
  assert.deepEqual(
    w.mpd.log.filter(([name]) => name === 'load'),
    [['load', 'Apéro']],
  );
});

test('play_playlist: an unknown name lists the playlists, in the configured language', async (t) => {
  const w = await world(t, { config: { language: 'fr' } });
  const ack = await w.fake.sceneAction('play_playlist', {
    device: deviceId(w.gladys),
    playlist: 'Nope',
  });
  assert.equal(ack.success, false);
  assert.equal(ack.error, 'Aucune playlist « Nope » dans MPD. Playlists : Apéro, Morning jazz');
});

test('clear_queue empties the queue', async (t) => {
  const w = await world(t);
  w.mpd.enqueue(ONE_MORE_TIME);
  w.mpd.commands.play();
  const ack = await w.fake.sceneAction('clear_queue', { device: deviceId(w.gladys) });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(w.mpd.queue, []);
  assert.equal(w.mpd.state, 'stop');
});

test('set_random: on, off and toggle, with the result as output', async (t) => {
  const w = await world(t);
  const run = async (mode) => {
    const ack = await w.fake.sceneAction('set_random', { device: deviceId(w.gladys), mode });
    assert.equal(ack.success, true, ack.error);
    return ack.data.outputs.random;
  };
  assert.equal(await run('on'), true);
  assert.equal(w.mpd.random, true);
  assert.equal(await run('toggle'), false);
  assert.equal(w.mpd.random, false);
  assert.equal(await run('off'), false);
});

test('set_repeat: off, the whole queue, one song', async (t) => {
  const w = await world(t);
  const run = async (mode) => {
    const ack = await w.fake.sceneAction('set_repeat', { device: deviceId(w.gladys), mode });
    assert.equal(ack.success, true, ack.error);
    return [w.mpd.repeat, w.mpd.single];
  };
  assert.deepEqual(await run('one'), [true, '1']);
  assert.deepEqual(await run('all'), [true, '0']);
  assert.deepEqual(await run('off'), [false, '0']);
});

test('a player that does not answer fails the action with a sentence, the scene goes on', async (t) => {
  const w = await world(t);
  await w.mpd.goOffline();
  const ack = await w.fake.sceneAction('clear_queue', { device: deviceId(w.gladys) });
  assert.equal(ack.success, false);
  assert.equal(ack.error, 'The player does not answer.');
});

test('a device of a slot no longer configured is refused', async (t) => {
  const w = await world(t, { servers: [new FakeMpd()] });
  const ack = await w.fake.sceneAction('clear_queue', { device: deviceId(w.gladys, 3) });
  assert.equal(ack.success, false);
  assert.match(ack.error, /no longer in the configuration/);
});
