#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Read-only probe of a real MPD player, with the client of the integration.
//
//   node scripts/probe.mjs <host> [port]
//   MPD_PASSWORD=… node scripts/probe.mjs <host> [port]    (if mpd.conf has one)
//
// Sends only commands that change nothing: the password (when given),
// `status`, `currentsong`, `listplaylists`, `commands` (what the connection
// is allowed to do), then one `idle` of 10 s (prints what changes meanwhile:
// change the volume or the song from another app to see it). Prints the raw
// answers, to compare with test/fixtures/mpd/, and what the integration
// reads from them. The password is never printed.
// -----------------------------------------------------------------------------

import { MpdConnection } from '../src/mpd/connection.js';
import { describeSong, parsePlaylists, parseSong, parseStatus } from '../src/mpd/model.js';

const [host, portText = '6600'] = process.argv.slice(2);
if (!host) {
  console.error('Usage: node scripts/probe.mjs <host> [port]   (MPD_PASSWORD=… if needed)');
  process.exit(2);
}
const port = Number(portText);
const password = process.env.MPD_PASSWORD ?? '';
const IDLE_SECONDS = 10;

const section = (title) => console.log(`\n=== ${title} ===`);
const raw = (lines) => console.log(lines.length ? lines.join('\n') : '(empty)');

const conn = new MpdConnection({ host, port, password });
try {
  const version = await conn.open();
  section('greeting');
  console.log(`OK MPD ${version}${password ? ' (password accepted)' : ''}`);

  section('status');
  const status = await conn.command('status');
  raw(status);
  console.log('->', JSON.stringify(parseStatus(status)));

  section('currentsong');
  const song = await conn.command('currentsong');
  raw(song);
  console.log('->', JSON.stringify(describeSong(parseSong(song))));

  section('listplaylists');
  try {
    const playlists = await conn.command('listplaylists');
    raw(playlists);
    console.log('->', JSON.stringify(parsePlaylists(playlists)));
  } catch (err) {
    console.log(`refused: ${err.message} (no playlist directory, or no "read" right)`);
  }

  section('commands allowed');
  const commands = (await conn.command('commands')).map((line) => line.replace(/^command: /, ''));
  const needed = [
    'play',
    'pause',
    'next',
    'previous',
    'setvol',
    'load',
    'addid',
    'playid',
    'deleteid',
    'seekid',
    'single',
    'consume',
    'idle',
  ];
  const missing = needed.filter((name) => !commands.includes(name));
  console.log(
    `${commands.length} commands; missing for the integration: ${missing.join(', ') || 'none'}`,
  );

  section(`idle (${IDLE_SECONDS} s: change something on the player)`);
  const timer = setTimeout(() => conn.command('ping').catch(() => {}), IDLE_SECONDS * 1000);
  const changes = await conn.idle(['player', 'mixer', 'options', 'playlist', 'stored_playlist']);
  clearTimeout(timer);
  console.log(changes.length ? `changed: ${changes.join(', ')}` : 'nothing changed');
} catch (err) {
  console.error(`\nFailed (${err.kind ?? 'error'}): ${err.message}`);
  process.exitCode = 1;
} finally {
  conn.close();
}
