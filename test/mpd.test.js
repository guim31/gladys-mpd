// -----------------------------------------------------------------------------
// The MPD protocol and the reading of its answers, without network: the
// command lines written, the ACK errors, the answers of test/fixtures/mpd/.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ACK,
  ERROR_KINDS,
  formatCommand,
  parseAck,
  parseChanges,
  parseGreeting,
  parseObject,
  quote,
} from '../src/mpd/protocol.js';
import {
  baseName,
  describeSong,
  parsePlaylists,
  parseSong,
  parseStatus,
} from '../src/mpd/model.js';
import { splitArgs } from './helpers/fakeMpd.js';

const fixture = async (name) =>
  (await readFile(new URL(`./fixtures/mpd/${name}`, import.meta.url), 'utf8'))
    .split('\n')
    .filter((line) => line !== '' && line !== 'OK');

test('arguments are quoted only when needed, quotes and backslashes escaped', () => {
  assert.equal(quote('42'), '42');
  assert.equal(quote('Apéro'), 'Apéro');
  assert.equal(quote('Morning jazz'), '"Morning jazz"');
  assert.equal(quote(''), '""');
  assert.equal(quote('say "hi"'), '"say \\"hi\\""');
  assert.equal(quote('back\\slash'), '"back\\\\slash"');
  assert.equal(formatCommand('load', ['Morning jazz']), 'load "Morning jazz"');
  assert.equal(formatCommand('seekid', [21, '74.865']), 'seekid 21 74.865');
  // The fake server reads them back as MPD does.
  for (const value of ['Morning jazz', 'say "hi"', 'back\\slash', 'http://x/a b.mp3']) {
    assert.deepEqual(splitArgs(formatCommand('add', [value])), ['add', value]);
  }
});

test('a line break can never smuggle a second command', () => {
  assert.throws(() => formatCommand('add', ['a.mp3\nclear']), /line break/);
  assert.throws(() => formatCommand('add', ['a.mp3\r']), /line break/);
  assert.throws(() => formatCommand('add x', []), /Invalid MPD command/);
});

test('the greeting gives the version, anything else is not MPD', () => {
  assert.equal(parseGreeting('OK MPD 0.23.5'), '0.23.5');
  assert.equal(parseGreeting('OK MPD 0.24.0'), '0.24.0');
  assert.equal(parseGreeting('HTTP/1.1 400 Bad Request'), null);
  assert.equal(parseGreeting('SSH-2.0-OpenSSH_9.2'), null);
});

test('ACK errors carry their code, command and message, and a kind', () => {
  const wrong = parseAck('ACK [3@0] {password} incorrect password');
  assert.equal(wrong.kind, ERROR_KINDS.AUTH);
  assert.equal(wrong.code, ACK.PASSWORD);
  assert.equal(wrong.command, 'password');
  assert.equal(wrong.message, 'incorrect password');

  const permission = parseAck('ACK [4@0] {status} you don\'t have permission for "status"');
  assert.equal(permission.kind, ERROR_KINDS.PERMISSION);

  const missing = parseAck('ACK [50@1] {load} No such playlist');
  assert.equal(missing.kind, ERROR_KINDS.COMMAND);
  assert.equal(missing.code, ACK.NO_EXIST);

  // Seen in the wild without the {command} part.
  const bare = parseAck('ACK [4@0] not allowed');
  assert.equal(bare.kind, ERROR_KINDS.PERMISSION);
  assert.equal(bare.message, 'not allowed');
});

test('an idle answer lists the changed subsystems', () => {
  assert.deepEqual(parseChanges(['changed: player', 'changed: mixer']), ['player', 'mixer']);
  assert.deepEqual(parseChanges([]), []);
});

test('a repeated tag keeps every value', () => {
  assert.deepEqual(parseObject(['Artist: A', 'Artist: B', 'Title: T']), {
    Artist: ['A', 'B'],
    Title: 'T',
  });
});

test('status of MPD 0.23 playing a file', async () => {
  const status = parseStatus(await fixture('status-play.txt'));
  assert.deepEqual(status, {
    state: 'play',
    volume: 52,
    random: false,
    repeat: true,
    single: '0',
    consume: '0',
    song: 3,
    songId: 21,
    queueLength: 12,
    elapsed: 74.865,
    duration: 240.627,
    error: null,
  });
});

test('status of a web radio: no duration, single "oneshot"', async () => {
  const status = parseStatus(await fixture('status-stream.txt'));
  assert.equal(status.duration, null, '`time: 1312:0` means unknown, not zero');
  assert.equal(status.elapsed, 1312.408);
  assert.equal(status.single, 'oneshot');
  assert.equal(status.random, true);
});

test('status without mixer: volume -1 (MPD 0.21) or absent (MPD 0.23)', async () => {
  const old = parseStatus(await fixture('status-stop-no-mixer-0.21.txt'));
  assert.equal(old.volume, null);
  assert.equal(old.state, 'stop');
  assert.equal(old.song, null);
  assert.equal(old.songId, null);
  assert.equal(old.consume, '1');
  const recent = parseStatus(await fixture('status-pause-no-volume-0.23.txt'));
  assert.equal(recent.volume, null);
  assert.equal(recent.state, 'pause');
  assert.equal(recent.error, 'Failed to decode Untagged/broken.ogg');
});

test('current song: tags, a web radio, two artists, no tags at all', async () => {
  const file = parseSong(await fixture('currentsong-file.txt'));
  assert.deepEqual(file, {
    file: 'Daft Punk/Discovery/04 Digital Love.flac',
    title: 'Digital Love',
    artist: 'Daft Punk',
    album: 'Discovery',
    name: null,
    id: 21,
    position: 3,
  });
  assert.deepEqual(describeSong(file), {
    title: 'Digital Love',
    subtitle: 'Daft Punk · Discovery',
  });

  const radio = parseSong(await fixture('currentsong-stream.txt'));
  assert.deepEqual(describeSong(radio), {
    title: 'Nina Simone - Feeling Good',
    subtitle: 'Example Radio Hi-Fi',
  });

  const duet = parseSong(await fixture('currentsong-two-artists.txt'));
  assert.equal(duet.artist, 'Artist One, Artist Two');

  const untagged = parseSong(await fixture('currentsong-untagged.txt'));
  assert.deepEqual(describeSong(untagged), { title: 'track07.mp3', subtitle: null });

  assert.equal(parseSong([]), null);
  assert.deepEqual(describeSong(null), { title: null, subtitle: null });
});

test('a radio without title shows its station name', () => {
  const song = parseSong(['file: http://radio.example.com/live', 'Name: Example FM', 'Id: 4']);
  assert.deepEqual(describeSong(song), { title: 'Example FM', subtitle: null });
  assert.equal(baseName('http://radio.example.com/a%20b.mp3?token=x'), 'a b.mp3');
});

test('stored playlists, sorted for people', async () => {
  assert.deepEqual(parsePlaylists(await fixture('listplaylists.txt')), [
    '2010s hits',
    'Apéro',
    'Morning jazz',
    'zen',
  ]);
});
