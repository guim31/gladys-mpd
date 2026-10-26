// -----------------------------------------------------------------------------
// One TCP connection to MPD (src/mpd/connection.js), against the fake server:
// greeting, password, command lists, idle cut short by noidle, and every way
// a connection fails (refused, silent, not MPD, lost).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MpdConnection } from '../src/mpd/connection.js';
import { ERROR_KINDS } from '../src/mpd/protocol.js';
import { FakeMpd } from './helpers/fakeMpd.js';

async function server(t, options) {
  const mpd = new FakeMpd(options);
  await mpd.listen();
  t.after(() => mpd.close());
  return mpd;
}

function connection(t, mpd, options = {}) {
  const conn = new MpdConnection({
    host: '127.0.0.1',
    port: mpd.port,
    timings: { connectMs: 300, requestMs: 300 },
    ...options,
  });
  t.after(() => conn.close());
  return conn;
}

test('greeting, commands and command lists', async (t) => {
  const mpd = await server(t);
  const conn = connection(t, mpd);
  assert.equal(await conn.open(), '0.23.5');
  assert.deepEqual(await conn.command('ping'), []);
  const [status, song] = await conn.commandList([['status'], ['currentsong']]);
  assert.ok(status.includes('state: stop'));
  assert.deepEqual(song, []);
});

test('an idle waits for a change, and a command cuts it short with noidle', async (t) => {
  const mpd = await server(t);
  const conn = connection(t, mpd);
  await conn.open();
  const idle = conn.idle(['mixer']);
  const status = conn.command('status');
  assert.deepEqual(await idle, [], 'answered at once, with nothing changed');
  assert.ok((await status).includes('volume: 40'));
  assert.deepEqual(mpd.commandNames(), ['idle', 'status']);

  // A change made by another client wakes the next idle.
  const next = conn.idle(['mixer', 'player']);
  mpd.commands.setvol('55');
  assert.deepEqual(await next, ['mixer']);
});

test('the changes made while not idle are reported at the next idle', async (t) => {
  const mpd = await server(t);
  const conn = connection(t, mpd);
  await conn.open();
  mpd.commands.random('1');
  assert.deepEqual(await conn.idle(['options']), ['options']);
});

test('the password is sent after the greeting; a wrong one is an AUTH error', async (t) => {
  const mpd = await server(t, { password: 's3cret' });
  const good = connection(t, mpd, { password: 's3cret' });
  await good.open();
  assert.ok((await good.command('status')).length > 0);

  const bad = connection(t, mpd, { password: 'nope' });
  await assert.rejects(bad.open(), (err) => err.kind === ERROR_KINDS.AUTH);

  const none = connection(t, mpd);
  await none.open();
  await assert.rejects(none.command('status'), (err) => err.kind === ERROR_KINDS.PERMISSION);
});

test('a refused connection is UNREACHABLE', async (t) => {
  const mpd = await server(t);
  await mpd.goOffline();
  const conn = connection(t, mpd);
  await assert.rejects(
    conn.open(),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE && /refused/.test(err.message),
  );
});

test('a server that never answers times out', async (t) => {
  const mpd = await server(t);
  mpd.silent = true;
  const conn = connection(t, mpd);
  await assert.rejects(
    conn.open(),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE && /timed out/.test(err.message),
  );
});

test('a server that stops answering a command closes the connection', async (t) => {
  const mpd = await server(t);
  const conn = connection(t, mpd);
  await conn.open();
  mpd.silent = true;
  const closed = new Promise((resolve) => conn.once('close', resolve));
  await assert.rejects(conn.command('status'), /timeout/);
  await closed;
  assert.equal(conn.closed, true);
  await assert.rejects(conn.command('ping'), (err) => err.kind === ERROR_KINDS.UNREACHABLE);
});

test('something that is not MPD is NOT_MPD', async (t) => {
  const mpd = await server(t);
  mpd.greeting = 'HTTP/1.1 400 Bad Request\r\n';
  const conn = connection(t, mpd);
  await assert.rejects(conn.open(), (err) => err.kind === ERROR_KINDS.NOT_MPD);
});

test('a peer sending an endless line is cut off', async (t) => {
  const peer = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.write('x'.repeat(1_100_000));
  });
  await new Promise((resolve) => peer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => peer.close(resolve)));
  const conn = new MpdConnection({ host: '127.0.0.1', port: peer.address().port });
  await assert.rejects(conn.open(), (err) => err.kind === ERROR_KINDS.NOT_MPD);
});

test('a lost connection fails every pending request and emits close once', async (t) => {
  const mpd = await server(t);
  const conn = connection(t, mpd);
  await conn.open();
  let closes = 0;
  conn.on('close', () => {
    closes += 1;
  });
  const idle = conn.idle();
  const pending = conn.command('status');
  mpd.dropClients();
  await assert.rejects(idle, (err) => err.kind === ERROR_KINDS.UNREACHABLE);
  await assert.rejects(pending, (err) => err.kind === ERROR_KINDS.UNREACHABLE);
  assert.equal(closes, 1);
});

test('an ACK fails the command only, the connection goes on', async (t) => {
  const mpd = await server(t);
  const conn = connection(t, mpd);
  await conn.open();
  await assert.rejects(conn.command('load', ['No such list']), /No such playlist/);
  await assert.rejects(
    conn.commandList([['clear'], ['load', ['nope']], ['play']]),
    (err) => err.code === 50 && err.command === 'load',
  );
  assert.deepEqual(await conn.command('ping'), []);
});

test('binary chunks are read as bytes, text around them as UTF-8', async (t) => {
  const mpd = await server(t);
  const conn = connection(t, mpd);
  await conn.open();
  await conn.command('binarylimit', [100_000]);
  const file = 'Air/Moon Safari/01 La femme d’argent.flac';
  const { lines, data } = await conn.binary('readpicture', [file, 0]);
  assert.ok(lines.includes('binary: 100000'));
  assert.equal(data.length, 100_000);
  const { data: next } = await conn.binary('readpicture', [file, 100_000]);
  assert.ok(next.length > 0);
  // The connection goes on, multi-byte text included.
  const song = await conn.command('find', ['title', 'La femme d’argent']);
  assert.ok(song.includes('Title: La femme d’argent'));
  // No picture: no chunk.
  assert.deepEqual(await conn.binary('readpicture', ['Untagged/track07.mp3', 0]), {
    lines: [],
    data: null,
  });
});

test('an answer too large closes the connection with TOO_LARGE', async (t) => {
  const mpd = await server(t);
  const conn = connection(t, mpd);
  await conn.open();
  const closed = new Promise((resolve) => conn.once('close', resolve));
  mpd.extraCommands = { huge: () => 'file: x\n'.repeat(600_000) };
  await assert.rejects(conn.command('huge'), (err) => err.kind === ERROR_KINDS.TOO_LARGE);
  assert.equal((await closed).kind, ERROR_KINDS.TOO_LARGE);
});
