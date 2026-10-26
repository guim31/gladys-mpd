// -----------------------------------------------------------------------------
// The Gladys 5.3 music player: the now-playing features published by
// publishNowPlaying, their commands, and the catalog of the music panel
// (browse, search, play, queue, artwork), against the SDK's fake Gladys and
// the fake MPD (shaped after a real MPD 0.24, see src/catalog.js).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MUSIC_PLAYBACK_STATE,
  MUSIC_REPEAT_MODE,
  validateMediaItems,
} from '@gladysassistant/integration-sdk';
import { imageInfo } from '../src/artwork-resize.js';
import { ROOTS, albumId, mixResults, parseId } from '../src/catalog.js';
import { FEATURE_KEYS } from '../src/devices.js';
import { HUGE_JPEG, SMALL_JPEG } from './helpers/fakeMpd.js';
import {
  FakeMpd,
  RADIO,
  createAll,
  createWorld,
  deviceId,
  eventually,
  featureId,
  featureOf,
  settle,
} from './helpers/world.js';

const ONE_MORE_TIME = 'Daft Punk/Discovery/01 One More Time.flac';
const AERODYNAMIC = 'Daft Punk/Discovery/02 Aerodynamic.flac';
const FEMME = 'Air/Moon Safari/01 La femme d’argent.flac';

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.stop());
  await createAll(w);
  return w;
}

const state = (w, key) => w.fake.lastState(featureId(w.gladys, key));
const device = (w) => ({ external_id: deviceId(w.gladys), selector: 'salon', params: [] });
const published = (w, key) =>
  w.fake.states.filter((s) => s.device_feature_external_id === featureId(w.gladys, key)).length;
const set = (w, key, value) => {
  const { device: d, feature } = featureOf(w, key);
  return w.fake.setValue(d, feature, value);
};
const valid = (ack) => {
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(validateMediaItems(ack.data.items), []);
  return ack.data.items;
};
const titles = (items) => items.map((item) => item.title);

test('the device carries the music features of Gladys 5.3, writable ones confirmed by MPD', async (t) => {
  const w = await world(t);
  const [player] = w.fake.discoveredDevices;
  const byKey = (key) => player.features.find((f) => f.external_id === featureId(w.gladys, key));
  // The SDK convention `${device}:${type}` for the new ones.
  for (const type of ['title', 'artist', 'album', 'artwork', 'duration', 'position']) {
    assert.equal(byKey(type).external_id, `${deviceId(w.gladys)}:${type}`);
    assert.equal(byKey(type).type, type);
  }
  // The playback state of 1.0 (same external id) becomes writable, with IDLE.
  const playback = byKey(FEATURE_KEYS.PLAYBACK_STATE);
  assert.deepEqual([playback.read_only, playback.max], [false, MUSIC_PLAYBACK_STATE.IDLE]);
  assert.equal(byKey(FEATURE_KEYS.REPEAT).max, MUSIC_REPEAT_MODE.ONE);
  // MPD has no mute: none published.
  assert.ok(!player.features.some((f) => f.type === 'mute'));
  for (const feature of player.features.filter((f) => !f.read_only)) {
    const legacy = ['play', 'pause', 'previous', 'next', 'play_notification', 'select'];
    assert.equal(feature.has_feedback, !legacy.includes(feature.type), feature.external_id);
  }
});

test('what plays is published once per change, cleared when nothing is loaded', async (t) => {
  const w = await world(t);
  assert.equal(state(w, FEATURE_KEYS.PLAYBACK_STATE), MUSIC_PLAYBACK_STATE.IDLE);
  assert.equal(state(w, FEATURE_KEYS.TITLE), '');
  assert.equal(state(w, FEATURE_KEYS.ARTWORK), '');

  w.mpd.enqueue(ONE_MORE_TIME, AERODYNAMIC);
  w.mpd.commands.play();
  await eventually(() => state(w, FEATURE_KEYS.TITLE) === 'One More Time');
  assert.equal(state(w, FEATURE_KEYS.ARTIST), 'Daft Punk');
  assert.equal(state(w, FEATURE_KEYS.ALBUM), 'Discovery');
  assert.equal(state(w, FEATURE_KEYS.DURATION), 320);
  assert.equal(state(w, FEATURE_KEYS.POSITION), 0);
  assert.equal(state(w, FEATURE_KEYS.PLAYBACK_STATE), MUSIC_PLAYBACK_STATE.PLAYING);
  // The cover file of the folder: one key for every song of it.
  const key = state(w, FEATURE_KEYS.ARTWORK);
  assert.match(key, /^art-[0-9a-f]{12}$/);

  // A reading 1 s later: the position moved as Gladys extrapolates it, nothing sent.
  const positions = published(w, FEATURE_KEYS.POSITION);
  const sent = published(w, FEATURE_KEYS.TITLE);
  w.mpd.play(1);
  await w.hub.tick();
  assert.equal(published(w, FEATURE_KEYS.POSITION), positions);
  assert.equal(published(w, FEATURE_KEYS.TITLE), sent);

  // A seek elsewhere (another client): the new position is published.
  w.mpd.elapsed = 200;
  w.mpd.emit('player');
  await eventually(() => state(w, FEATURE_KEYS.POSITION) === 200);

  // Next song of the same folder: same artwork key.
  w.mpd.commands.next();
  await eventually(() => state(w, FEATURE_KEYS.TITLE) === 'Aerodynamic');
  assert.equal(state(w, FEATURE_KEYS.ARTWORK), key);
  assert.equal(state(w, FEATURE_KEYS.POSITION), 0);

  // Pause, then stop: the song stays shown while MPD keeps it current.
  w.mpd.commands.pause('1');
  await eventually(() => state(w, FEATURE_KEYS.PLAYBACK_STATE) === MUSIC_PLAYBACK_STATE.PAUSED);
  w.mpd.commands.stop();
  await eventually(() => state(w, FEATURE_KEYS.PLAYBACK_STATE) === MUSIC_PLAYBACK_STATE.IDLE);
  assert.equal(state(w, FEATURE_KEYS.TITLE), 'Aerodynamic');
  assert.equal(state(w, FEATURE_KEYS.DURATION), 212);

  // The queue cleared: every text is emptied explicitly.
  w.mpd.commands.clear();
  await eventually(() => state(w, FEATURE_KEYS.TITLE) === '');
  assert.equal(state(w, FEATURE_KEYS.ARTIST), '');
  assert.equal(state(w, FEATURE_KEYS.ALBUM), '');
  assert.equal(state(w, FEATURE_KEYS.ARTWORK), '');
  assert.equal(state(w, FEATURE_KEYS.DURATION), 0);
});

test('a web radio: the song it announces as title, the station as album, live', async (t) => {
  const w = await world(t);
  w.mpd.enqueue(RADIO);
  w.mpd.commands.play();
  await eventually(() => state(w, FEATURE_KEYS.TITLE) === 'Some Artist - Some Song');
  assert.equal(state(w, FEATURE_KEYS.ALBUM), 'Example Radio');
  assert.equal(state(w, FEATURE_KEYS.DURATION), 0);
  assert.equal(state(w, FEATURE_KEYS.ARTWORK), '');
  assert.ok(!w.mpd.commandNames().includes('readpicture'), 'no artwork asked for a stream');
});

test('playback state, position, shuffle and repeat are commands', async (t) => {
  const w = await world(t);
  w.mpd.enqueue(ONE_MORE_TIME, AERODYNAMIC);
  w.mpd.commands.play();
  await eventually(() => state(w, FEATURE_KEYS.PLAYBACK_STATE) === MUSIC_PLAYBACK_STATE.PLAYING);
  w.mpd.play(30);

  await set(w, FEATURE_KEYS.PLAYBACK_STATE, MUSIC_PLAYBACK_STATE.PAUSED);
  assert.equal(w.mpd.state, 'pause');
  await set(w, FEATURE_KEYS.PLAYBACK_STATE, MUSIC_PLAYBACK_STATE.PLAYING);
  assert.equal(w.mpd.state, 'play');
  assert.equal(w.mpd.elapsed, 30, 'resumed, not restarted');

  await set(w, FEATURE_KEYS.POSITION, 120);
  assert.equal(w.mpd.elapsed, 120);
  await eventually(() => state(w, FEATURE_KEYS.POSITION) === 120);

  await set(w, FEATURE_KEYS.SHUFFLE, 1);
  assert.equal(w.mpd.random, true);
  await eventually(() => state(w, FEATURE_KEYS.SHUFFLE) === 1);

  await set(w, FEATURE_KEYS.REPEAT, MUSIC_REPEAT_MODE.ONE);
  assert.deepEqual([w.mpd.repeat, w.mpd.single], [true, '1']);
  await eventually(() => state(w, FEATURE_KEYS.REPEAT) === MUSIC_REPEAT_MODE.ONE);
  await set(w, FEATURE_KEYS.REPEAT, MUSIC_REPEAT_MODE.ALL);
  assert.deepEqual([w.mpd.repeat, w.mpd.single], [true, '0']);
  await set(w, FEATURE_KEYS.REPEAT, MUSIC_REPEAT_MODE.OFF);
  assert.equal(w.mpd.repeat, false);
  const refused = await set(w, FEATURE_KEYS.REPEAT, 7);
  assert.equal(refused.success, false);

  await set(w, FEATURE_KEYS.PLAYBACK_STATE, MUSIC_PLAYBACK_STATE.IDLE);
  assert.equal(w.mpd.state, 'stop');
  await eventually(() => state(w, FEATURE_KEYS.PLAYBACK_STATE) === MUSIC_PLAYBACK_STATE.IDLE);
  // A seek while stopped does nothing (it must not start the music).
  const seek = await set(w, FEATURE_KEYS.POSITION, 10);
  assert.equal(seek.success, true);
  assert.equal(w.mpd.state, 'stop');
  assert.equal((await set(w, FEATURE_KEYS.PLAYBACK_STATE, 3)).success, false);
});

test('during a notification, the repeat mode shown is the one it put aside', async (t) => {
  const w = await world(t);
  w.mpd.enqueue(ONE_MORE_TIME);
  w.mpd.commands.repeat('1');
  w.mpd.commands.play();
  await eventually(() => state(w, FEATURE_KEYS.REPEAT) === MUSIC_REPEAT_MODE.ALL);
  const repeats = published(w, FEATURE_KEYS.REPEAT);
  await set(w, FEATURE_KEYS.NOTIFICATION, 'sounds/doorbell.mp3');
  await eventually(() => state(w, FEATURE_KEYS.TITLE) === 'Doorbell');
  assert.equal(w.mpd.repeat, false, 'MPD repeat off while the doorbell plays');
  assert.equal(published(w, FEATURE_KEYS.REPEAT), repeats, 'the repeat mode never flickers');
});

test('a player that stops answering is shown stopped, its song kept', async (t) => {
  const w = await world(t);
  w.mpd.enqueue(ONE_MORE_TIME);
  w.mpd.commands.play();
  await eventually(() => state(w, FEATURE_KEYS.PLAYBACK_STATE) === MUSIC_PLAYBACK_STATE.PLAYING);
  w.mpd.dropClients();
  await eventually(() => state(w, FEATURE_KEYS.PLAYBACK_STATE) === MUSIC_PLAYBACK_STATE.IDLE);
  assert.equal(state(w, FEATURE_KEYS.TITLE), 'One More Time');
});

test('browse: our entry points, folders, artists, albums and playlists, page by page', async (t) => {
  const w = await world(t);
  const browse = async (parentId, options = {}) =>
    valid(await w.fake.musicBrowse(device(w), { parentId, ...options }));

  const root = await browse(null);
  assert.deepEqual(
    root.map((item) => item.id),
    [ROOTS.FOLDERS, ROOTS.ARTISTS, ROOTS.ALBUMS, ROOTS.PLAYLISTS],
  );
  assert.ok(root.every((item) => item.browsable && !item.playable));

  // Folders: the stored playlists of the root are left to their own folder.
  const folders = await browse(ROOTS.FOLDERS);
  assert.deepEqual(titles(folders), ['Daft Punk', 'Air', 'Untagged', 'sounds']);
  assert.ok(folders.every((item) => item.type === 'folder' && item.playable && item.artwork_key));
  const daft = await browse('dir:Daft Punk');
  assert.deepEqual(titles(daft), ['Discovery']);
  const discovery = await w.fake.musicBrowse(device(w), {
    parentId: 'dir:Daft Punk/Discovery',
    offset: 1,
    limit: 1,
  });
  assert.deepEqual(titles(discovery.data.items), ['Aerodynamic']);
  assert.equal(discovery.data.total, 2);
  const [song] = discovery.data.items;
  assert.deepEqual(
    { ...song, artwork_key: undefined },
    {
      id: `song:${AERODYNAMIC}`,
      type: 'track',
      title: 'Aerodynamic',
      subtitle: 'Daft Punk',
      duration: 212,
      browsable: false,
      playable: true,
      artwork_key: undefined,
    },
  );
  // Untagged: the file name.
  assert.deepEqual(titles(await browse('dir:Untagged')), ['track07.mp3']);

  const artists = await browse(ROOTS.ARTISTS);
  assert.deepEqual(titles(artists), ['Air', 'Daft Punk']);
  const daftAlbums = await browse('artist:Daft Punk');
  assert.deepEqual(daftAlbums[0].id, albumId('artist', 'Daft Punk', 'Discovery'));
  assert.deepEqual(titles(await browse(daftAlbums[0].id)), ['One More Time', 'Aerodynamic']);

  const albums = await browse(ROOTS.ALBUMS);
  assert.deepEqual(
    albums.map((item) => [item.title, item.subtitle]),
    [
      ['Discovery', 'Daft Punk'],
      ['Moon Safari', 'Air'],
    ],
  );
  assert.deepEqual(titles(await browse(albums[1].id)), ['La femme d’argent']);

  const playlists = await browse(ROOTS.PLAYLISTS);
  assert.deepEqual(titles(playlists), ['Apéro', 'Morning jazz']);
  assert.deepEqual(titles(await browse(playlists[0].id)), ['One More Time', 'La femme d’argent']);

  // An id that is not ours is an error, never a crash.
  const unknown = await w.fake.musicBrowse(device(w), { parentId: 'spotify:album:1' });
  assert.equal(unknown.success, false);
});

test('the ids carry the MPD names back, quotes and all', () => {
  assert.deepEqual(parseId('song:Air/x "y".flac'), { kind: 'song', value: 'Air/x "y".flac' });
  assert.deepEqual(parseId(albumId('albumartist', 'A:B', 'C')), {
    kind: 'album',
    value: { tag: 'albumartist', name: 'A:B', album: 'C' },
  });
  assert.equal(parseId('album:[not json'), null);
  assert.equal(parseId('album:["genre","x","y"]'), null);
  assert.equal(parseId('song:'), null);
  assert.equal(parseId(42), null);
});

test('search: songs through MPD, artists, albums and playlists by name', async (t) => {
  const w = await world(t);
  const search = async (query, type) =>
    valid(await w.fake.musicSearch(device(w), { query, type, limit: 20 }));

  const daft = await search('daft');
  assert.deepEqual(
    daft.map((item) => `${item.type}:${item.title}`),
    ['artist:Daft Punk', 'album:Discovery', 'track:One More Time', 'track:Aerodynamic'],
  );
  // Accents and case aside for what the integration matches itself.
  assert.deepEqual(titles(await search('APERO', 'playlist')), ['Apéro']);
  assert.deepEqual(titles(await search('moon', 'album')), ['Moon Safari']);
  assert.deepEqual(await search('daft', 'radio'), []);
  assert.deepEqual(await search('   '), []);
  const share = mixResults({ artist: [1, 2, 3, 4], track: [5, 6] }, 4);
  assert.deepEqual(share, [1, 5, 6, 2]);
});

test('play: replace, next and append, a removed song skipped, nothing lost on a refusal', async (t) => {
  const w = await world(t);
  const play = (id, type, mode) => w.fake.musicPlay(device(w), { id, type }, mode);
  const files = () => w.mpd.queue.map((song) => song.file);

  assert.equal((await play(albumId('artist', 'Daft Punk', 'Discovery'), 'album')).success, true);
  assert.deepEqual(files(), [ONE_MORE_TIME, AERODYNAMIC]);
  assert.equal(w.mpd.state, 'play');
  await eventually(() => state(w, FEATURE_KEYS.TITLE) === 'One More Time');

  assert.equal((await play(`song:${FEMME}`, 'track', 'next')).success, true);
  assert.deepEqual(files(), [ONE_MORE_TIME, FEMME, AERODYNAMIC]);
  assert.equal((await play('playlist:Morning jazz', 'playlist', 'append')).success, true);
  assert.deepEqual(files(), [ONE_MORE_TIME, FEMME, AERODYNAMIC, 'Untagged/track07.mp3']);

  // A playlist with a song MPD no longer has: the others are queued.
  w.mpd.playlists.Mixed = ['Gone/missing.flac', AERODYNAMIC];
  assert.equal((await play('playlist:Mixed', 'playlist')).success, true);
  assert.deepEqual(files(), [AERODYNAMIC]);
  assert.equal(w.mpd.state, 'play');

  // Nothing playable (a song removed since a scene saved it): the queue stays.
  const refused = await play('song:Gone/missing.flac', 'track');
  assert.equal(refused.success, false);
  assert.match(refused.error, /nothing to play/);
  assert.deepEqual(files(), [AERODYNAMIC]);
  const removed = await play('playlist:Deleted', 'playlist');
  assert.equal(removed.success, false);

  const folder = await play(ROOTS.ARTISTS, 'folder');
  assert.equal(folder.success, false);
  assert.match(folder.error, /cannot be played/);
  assert.equal((await play('dir:Daft Punk', 'folder', 'append')).success, true);
  assert.deepEqual(files(), [AERODYNAMIC, ONE_MORE_TIME, AERODYNAMIC]);
  assert.equal((await play('artist:Air', 'artist', 'next')).success, true);
  assert.deepEqual(files(), [AERODYNAMIC, FEMME, ONE_MORE_TIME, AERODYNAMIC]);
});

test('the queue: a page around the current song, a jump, no row ever dropped', async (t) => {
  const w = await world(t);
  w.mpd.enqueue(ONE_MORE_TIME, AERODYNAMIC, FEMME, ONE_MORE_TIME);
  w.mpd.commands.play('2');
  await eventually(() => state(w, FEATURE_KEYS.TITLE) === 'La femme d’argent');

  const first = await w.fake.musicQueueGet(device(w), { offset: 0, limit: 3 });
  valid(first);
  assert.deepEqual(titles(first.data.items), ['One More Time', 'Aerodynamic', 'La femme d’argent']);
  assert.equal(first.data.current_index, 2);
  assert.equal(first.data.total, 4);
  const last = await w.fake.musicQueueGet(device(w), { offset: 3, limit: 3 });
  assert.deepEqual(titles(last.data.items), ['One More Time'], 'a song queued twice is two rows');
  const past = await w.fake.musicQueueGet(device(w), { offset: 9, limit: 3 });
  assert.deepEqual([past.data.items, past.data.total], [[], 4]);

  assert.equal((await w.fake.musicQueuePlay(device(w), 1)).success, true);
  await eventually(() => state(w, FEATURE_KEYS.TITLE) === 'Aerodynamic');
  const gone = await w.fake.musicQueuePlay(device(w), 12);
  assert.equal(gone.success, false);
  assert.match(gone.error, /no longer in the queue/);

  w.mpd.commands.clear();
  const empty = await w.fake.musicQueueGet(device(w));
  assert.deepEqual([empty.data.items, empty.data.current_index, empty.data.total], [[], null, 0]);
});

test('artworks: a folder cover as it is, an embedded picture made smaller, read once', async (t) => {
  const w = await world(t);
  const art = async (key) => {
    const ack = await w.fake.musicGetArtwork(key);
    assert.equal(ack.success, true, ack.error);
    return Buffer.from(ack.data.image, 'base64');
  };
  const [folder] = valid(await w.fake.musicBrowse(device(w), { parentId: 'dir:Daft Punk' }));
  assert.deepEqual(await art(folder.artwork_key), SMALL_JPEG);

  // The embedded picture (about 1.5 MB, above the 300 KB of Gladys), read
  // in chunks of the binarylimit asked.
  const [femme] = valid(await w.fake.musicBrowse(device(w), { parentId: 'dir:Air/Moon Safari' }));
  assert.ok(HUGE_JPEG.length > 300 * 1024);
  const image = await art(femme.artwork_key);
  assert.ok(image.length <= 300 * 1024, `${image.length} bytes`);
  assert.ok(imageInfo(image).width <= 400);
  assert.ok(w.mpd.commandNames().includes('binarylimit'));

  // The album of the same song: same picture, the resized copy is reused.
  const [, moon] = valid(await w.fake.musicBrowse(device(w), { parentId: ROOTS.ALBUMS }));
  const reads = w.mpd.commandNames().filter((name) => name === 'readpicture').length;
  assert.deepEqual(await art(moon.artwork_key), image);
  const chunks = w.mpd.log.filter(([name, , offset]) => name === 'readpicture' && offset !== '0');
  assert.equal(chunks.length, 1, 'the rest of the picture read once');
  assert.equal(
    w.mpd.commandNames().filter((name) => name === 'readpicture').length,
    reads,
    'the lookup of the song saw its first chunk: nothing read again',
  );

  // A song without any artwork, and a key Gladys never got from us.
  const [untagged] = valid(await w.fake.musicBrowse(device(w), { parentId: 'dir:Untagged' }));
  assert.equal((await w.fake.musicGetArtwork(untagged.artwork_key)).success, false);
  assert.equal((await w.fake.musicGetArtwork('art-000000000000')).success, false);
});

test('an MPD without readpicture (before 0.22) still shows the folder cover', async (t) => {
  const mpd = new FakeMpd();
  mpd.missing = ['readpicture', 'binarylimit'];
  const w = await world(t, { servers: [mpd] });
  mpd.enqueue(ONE_MORE_TIME);
  mpd.commands.play();
  await eventually(() => state(w, FEATURE_KEYS.TITLE) === 'One More Time');
  const key = state(w, FEATURE_KEYS.ARTWORK);
  assert.notEqual(key, '');
  const ack = await w.fake.musicGetArtwork(key);
  assert.deepEqual(Buffer.from(ack.data.image, 'base64'), SMALL_JPEG);
  await settle();
});

test('the artwork keys of a long level: only the page shown is recorded', async (t) => {
  const w = await world(t);
  const before = w.gladys.artworkUrls.size;
  valid(await w.fake.musicBrowse(device(w), { parentId: ROOTS.ALBUMS, offset: 1, limit: 1 }));
  assert.equal(w.gladys.artworkUrls.size, before + 1);
});

test('play next during random play: a priority makes the songs play next', async (t) => {
  const w = await world(t);
  w.mpd.enqueue(ONE_MORE_TIME, AERODYNAMIC);
  w.mpd.commands.random('1');
  w.mpd.commands.play();
  await eventually(() => state(w, FEATURE_KEYS.SHUFFLE) === 1);
  const ack = await w.fake.musicPlay(device(w), { id: `song:${FEMME}`, type: 'track' }, 'next');
  assert.equal(ack.success, true, ack.error);
  assert.equal(w.mpd.queue.find((song) => song.file === FEMME).priority, 255);
});

test('a queuing refused midway takes back what it added', async (t) => {
  const w = await world(t);
  w.mpd.enqueue(ONE_MORE_TIME);
  w.mpd.playlists.Broken = [AERODYNAMIC, 'file:///etc/passwd', FEMME];
  const ack = await w.fake.musicPlay(
    device(w),
    { id: 'playlist:Broken', type: 'playlist' },
    'append',
  );
  assert.equal(ack.success, false);
  assert.deepEqual(
    w.mpd.queue.map((song) => song.file),
    [ONE_MORE_TIME],
  );
});

test('a player offline from the start, or removed, is shown stopped', async (t) => {
  const mpd = new FakeMpd();
  await mpd.listen();
  const w = await createWorld({ servers: [mpd], connect: false });
  t.after(() => w.stop());
  await mpd.goOffline();
  await w.gladys.connect();
  await w.app.ready;
  await createAll(w);
  await eventually(() => state(w, FEATURE_KEYS.PLAYBACK_STATE) === MUSIC_PLAYBACK_STATE.IDLE);

  await mpd.goOnline();
  await w.hub.tick();
  await eventually(() => w.hub.records.get(1).player.connected);
  mpd.enqueue(ONE_MORE_TIME);
  mpd.commands.play();
  await eventually(() => state(w, FEATURE_KEYS.PLAYBACK_STATE) === MUSIC_PLAYBACK_STATE.PLAYING);
  await w.fake.configUpdated({ language: 'en', player_1_address: '' });
  await eventually(() => state(w, FEATURE_KEYS.PLAYBACK_STATE) === MUSIC_PLAYBACK_STATE.IDLE);
});
