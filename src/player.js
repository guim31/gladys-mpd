// -----------------------------------------------------------------------------
// One MPD player: a connection kept open, in idle, so every change on the
// player (another app, the moOde interface, a button on the amplifier) is
// seen at once; a reconnection with back-off when it drops; the commands of
// Gladys; and the notifications that play an address, then put back what
// was playing.
//
// Events (the hub listens to them, the player itself never logs above
// debug):
//   - `connected`    the connection is up and the first reading done;
//   - `failed`       a connection attempt failed (err);
//   - `disconnected` an open connection was lost (err);
//   - `update`       a new reading of status, current song or playlists;
//   - `notification` a notification ended ({ reason, error }).
//
// A second, short-lived connection (`side()`) serves what may be long or
// large: the catalog of the Gladys 5.3 music panel and the artworks (binary
// chunks). The connection in idle stays free for the commands, and an answer
// MPD finds too large only closes the side one.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createLogger } from '@gladysassistant/integration-sdk';
import { MpdConnection } from './mpd/connection.js';
import { ACK, ERROR_KINDS, MpdError, parsePairs } from './mpd/protocol.js';
import { STATES, isStream, parsePlaylists, parseSong, parseStatus } from './mpd/model.js';

const logger = createLogger({ name: 'mpd-player' });

export const PLAYER_TIMINGS = {
  // Waits between connection attempts, then the last one again and again.
  reconnectMs: [2_000, 5_000, 15_000, 30_000, 60_000],
  // A notification still playing after this long is ended (a stream that is
  // not a radio, a song paused by someone): what was playing comes back.
  notificationMaxMs: 5 * 60_000,
  // A notification playing this long without a known duration is a web
  // radio: it keeps playing, nothing is put back.
  streamAfterMs: 4_000,
  // How long a scene action waits for its address to start playing.
  startTimeoutMs: 10_000,
  startCheckMs: 500,
  // How long a reading waits for the artwork lookup of a new song: past it,
  // the song is shown without, and the next reading asks again.
  artworkTimeoutMs: 2_000,
  // The side connection (catalog, artworks) is closed after this long unused.
  sideIdleMs: 20_000,
  // How long a song's artwork lookup is remembered.
  artworkCacheMs: 10 * 60_000,
};

// What a catalog command may queue at most (an album, an artist, a folder,
// a playlist): a folder may hold the whole library.
export const MAX_QUEUED_SONGS = 500;

// Bytes asked per binary chunk (`binarylimit`, MPD ≥ 0.22.4; 8 KB before):
// a cover of a few megabytes comes in a few round trips.
export const ARTWORK_CHUNK = 1_048_576;
// A cover is read up to this size (then made smaller, artwork-resize.js).
export const MAX_ARTWORK_BYTES = 10 * 1024 * 1024;

const ARTWORK_LOOKUPS_KEPT = 500;

// What the idle waits for: playback, volume, options, queue, stored playlists.
const IDLE_SUBSYSTEMS = ['player', 'mixer', 'options', 'playlist', 'stored_playlist'];
const STATUS_SUBSYSTEMS = new Set(['player', 'mixer', 'options', 'playlist']);

/** Repeat modes offered to scenes, as MPD's `repeat` and `single`. */
export const REPEAT_MODES = Object.freeze({
  off: { repeat: '0', single: '0' },
  all: { repeat: '1', single: '0' },
  one: { repeat: '1', single: '1' },
});

/** The repeat mode of a status. */
export function repeatMode(status) {
  if (!status?.repeat) {
    return 'off';
  }
  return status.single === '1' ? 'one' : 'all';
}

/**
 * Can MPD play this address? A URL (http, https…) or a path of its music
 * library. `file://` only works on a local socket, which the container has
 * not; a line break would split the command.
 * @param {unknown} uri
 */
export function checkUri(uri) {
  if (typeof uri !== 'string' || uri.trim() === '' || /[\r\n]/.test(uri)) {
    return null;
  }
  const text = uri.trim();
  if (/^file:/i.test(text)) {
    return null;
  }
  return text;
}

export class Player extends EventEmitter {
  /**
   * @param {object} options
   * @param {{ slot: number, host: string, port: number, password: string }} options.server
   * @param {boolean} [options.timers] reconnection and notification timers (off in some tests)
   * @param {object} [options.timings] PLAYER_TIMINGS overrides
   * @param {object} [options.connectionTimings] CONNECTION_TIMINGS overrides
   * @param {Function} [options.connect] socket seam
   * @param {() => number} [options.now]
   */
  constructor({ server, timers = true, timings, connectionTimings, connect, now }) {
    super();
    this.server = server;
    this.timers = timers;
    this.timings = { ...PLAYER_TIMINGS, ...timings };
    this.connectionTimings = connectionTimings;
    this.connectSocket = connect;
    this.now = now ?? (() => Date.now());
    /** @type {MpdConnection|null} */
    this.conn = null;
    this.connecting = null;
    this.stopped = false;
    this.version = null;
    /** Last error of the connection, null while connected. */
    this.error = null;
    this.failures = 0;
    this.everConnected = false;
    this.reconnectTimer = null;
    this.status = null;
    this.song = null;
    /** Stored playlists, null until read (or when the server refuses to list them). */
    this.playlists = null;
    this.refreshedAt = null;
    this.refreshing = null;
    this.pendingRefresh = null;
    this.wantPlaylists = false;
    /** The notification playing, if any. */
    this.notification = null;
    /** The last notification being started (they start one after the other). */
    this.notifying = Promise.resolve();
    /** The side connection (catalog, artworks), opened on demand. */
    this.sideConn = null;
    this.sideOpening = null;
    this.sideTimer = null;
    /** The artwork of the current song: the file it was looked up for, its source. */
    this.artworkFor = null;
    this.artwork = null;
    /** Artwork lookups by song file: { source, at }. */
    this.artworkLookups = new Map();
    /** Lookups running, by song file: one at a time per song. */
    this.artworkSearches = new Map();
  }

  get connected() {
    return this.conn !== null;
  }

  // --- Connection ------------------------------------------------------------

  /**
   * Connect, unless connected or connecting. Never throws: a failure is the
   * `failed` event, and a new attempt is scheduled.
   */
  connect() {
    if (this.stopped || this.conn) {
      return Promise.resolve();
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connecting ??= this.attempt().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async attempt() {
    const conn = new MpdConnection({
      host: this.server.host,
      port: this.server.port,
      password: this.server.password,
      timings: this.connectionTimings,
      connect: this.connectSocket,
    });
    // Until the first reading is done, a lost connection is a failed attempt
    // (handled below), not a disconnection.
    let ready = false;
    conn.on('close', (err) => {
      if (ready) {
        this.onClose(conn, err);
      }
    });
    try {
      this.version = await conn.open();
      if (this.stopped) {
        conn.close();
        return;
      }
      this.conn = conn;
      await this.refresh({ playlists: true });
    } catch (err) {
      if (this.conn === conn) {
        this.conn = null;
      }
      conn.close();
      if (this.stopped) {
        return;
      }
      this.failures += 1;
      this.error = asMpdError(err);
      this.emit('failed', this.error);
      this.scheduleReconnect();
      return;
    }
    if (conn.closed) {
      // Lost between the reading and now: try again later.
      this.conn = null;
      this.failures += 1;
      this.error = new MpdError(ERROR_KINDS.UNREACHABLE, 'connection closed');
      this.emit('failed', this.error);
      this.scheduleReconnect();
      return;
    }
    ready = true;
    const restored = this.everConnected;
    this.everConnected = true;
    this.failures = 0;
    this.error = null;
    this.emit('connected', { restored });
    this.idleLoop(conn);
  }

  onClose(conn, err) {
    if (this.conn !== conn) {
      return;
    }
    this.conn = null;
    this.error = asMpdError(err);
    // A notification cannot be put back on a connection that is gone: MPD
    // keeps playing it, the user sees it in the queue.
    this.dropNotification();
    if (this.stopped) {
      return;
    }
    this.failures = 1;
    this.emit('disconnected', this.error);
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (!this.timers || this.stopped || this.reconnectTimer) {
      return;
    }
    const delays = this.timings.reconnectMs;
    const delay = delays[Math.min(this.failures - 1, delays.length - 1)] ?? delays[0];
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** Stop for good: close the connection, no more attempts. */
  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.dropNotification();
    const conn = this.conn;
    this.conn = null;
    conn?.close();
    this.closeSide();
  }

  // --- Side connection -------------------------------------------------------

  /**
   * The side connection, opened when needed (with the password), closed
   * after sideIdleMs unused. Refused at once while the player is offline.
   * @returns {Promise<MpdConnection>}
   */
  async side() {
    this.requireConnection();
    clearTimeout(this.sideTimer);
    if (this.sideConn && !this.sideConn.closed) {
      this.armSideTimer();
      return this.sideConn;
    }
    this.sideOpening ??= this.openSide().finally(() => {
      this.sideOpening = null;
    });
    const conn = await this.sideOpening;
    this.armSideTimer();
    return conn;
  }

  async openSide() {
    const conn = new MpdConnection({
      host: this.server.host,
      port: this.server.port,
      password: this.server.password,
      timings: this.connectionTimings,
      connect: this.connectSocket,
    });
    conn.on('close', () => {
      if (this.sideConn === conn) {
        this.sideConn = null;
      }
    });
    try {
      await conn.open();
      // Bigger binary chunks (MPD ≥ 0.22.4); older servers send 8 KB ones.
      await conn.command('binarylimit', [ARTWORK_CHUNK]).catch((err) => {
        if (err.kind === ERROR_KINDS.UNREACHABLE) {
          throw err;
        }
      });
    } catch (err) {
      conn.close();
      throw asMpdError(err);
    }
    if (this.stopped) {
      conn.close();
      throw new MpdError(ERROR_KINDS.UNREACHABLE, 'stopped');
    }
    this.sideConn = conn;
    return conn;
  }

  armSideTimer() {
    clearTimeout(this.sideTimer);
    if (this.timers) {
      this.sideTimer = setTimeout(() => {
        // Still busy (covers read chunk after chunk): wait for it to be idle.
        if (this.sideConn && this.sideConn.queue.length > 0) {
          this.armSideTimer();
          return;
        }
        this.closeSide();
      }, this.timings.sideIdleMs);
      this.sideTimer.unref?.();
    }
  }

  closeSide() {
    clearTimeout(this.sideTimer);
    const conn = this.sideConn;
    this.sideConn = null;
    conn?.close();
  }

  /**
   * One read-only command on the side connection (catalog).
   * @param {string} name
   * @param {Array<string|number>} [args]
   * @returns {Promise<string[]>}
   */
  async query(name, args = []) {
    const conn = await this.side();
    return conn.command(name, args);
  }

  async idleLoop(conn) {
    while (this.conn === conn && !conn.closed) {
      let changes;
      try {
        changes = await conn.idle(IDLE_SUBSYSTEMS);
      } catch {
        // Lost connection (the `close` event handles it) or an idle the
        // server refused: either way, this loop is over.
        if (this.conn === conn && !conn.closed) {
          conn.close();
        }
        return;
      }
      if (changes.length === 0) {
        continue;
      }
      logger.debug(`Player ${this.server.slot}: changed ${changes.join(', ')}`);
      const playlists = changes.includes('stored_playlist');
      if (playlists || changes.some((change) => STATUS_SUBSYSTEMS.has(change))) {
        this.refresh({ playlists }).catch(() => {});
      }
    }
  }

  /**
   * The periodic check of the hub (and the core's onPoll): a reading when
   * connected — it is also the ping that notices a server gone silent —, a
   * connection attempt otherwise, unless one is already planned.
   */
  async tick() {
    if (this.stopped) {
      return;
    }
    if (this.conn) {
      await this.refresh().catch(() => {});
      return;
    }
    if (!this.connecting && !this.reconnectTimer) {
      await this.connect();
    }
  }

  requireConnection() {
    if (!this.conn) {
      throw this.error ?? new MpdError(ERROR_KINDS.UNREACHABLE, 'not connected');
    }
    return this.conn;
  }

  // --- Reading ---------------------------------------------------------------

  /**
   * Read status and current song (and the stored playlists when asked).
   * Calls made while a reading runs share the next one, which starts after
   * it: whoever sent a command then asks for a reading sees its effect.
   * @param {{ playlists?: boolean }} [options]
   */
  refresh({ playlists = false } = {}) {
    if (playlists) {
      this.wantPlaylists = true;
    }
    if (!this.pendingRefresh) {
      const previous = this.refreshing ?? Promise.resolve();
      this.pendingRefresh = previous
        .catch(() => {})
        .then(() => {
          this.pendingRefresh = null;
          this.refreshing = this.read().finally(() => {
            this.refreshing = null;
          });
          return this.refreshing;
        });
    }
    return this.pendingRefresh;
  }

  async read() {
    const conn = this.requireConnection();
    const [statusLines, songLines] = await conn.commandList([['status'], ['currentsong']]);
    let playlists = this.playlists;
    if (this.wantPlaylists) {
      this.wantPlaylists = false;
      try {
        playlists = parsePlaylists(await conn.command('listplaylists'));
      } catch (err) {
        if (err.kind === ERROR_KINDS.UNREACHABLE) {
          throw err;
        }
        // No playlist directory, or a password without the `read` right.
        logger.debug(`Player ${this.server.slot}: playlists not listed (${err.message})`);
        playlists = null;
      }
    }
    const song = parseSong(songLines);
    const file = song?.file ?? null;
    if (file !== this.artworkFor) {
      // Once per song, awaited so that a song change is one batch of
      // states, but briefly: a command waits for this reading.
      const found = await this.lookupArtwork(file, {
        timeoutMs: this.timings.artworkTimeoutMs,
        // Found after the reading gave up waiting: read again to show it.
        late: () => {
          if (this.song?.file === file && this.conn) {
            this.refresh().catch(() => {});
          }
        },
      });
      this.artwork = found.source;
      // Not read (error, timeout): asked again at the next reading.
      this.artworkFor = found.failed ? null : file;
    }
    this.status = parseStatus(statusLines);
    this.song = song;
    this.playlists = playlists;
    this.refreshedAt = this.now();
    this.emit('update');
    this.checkNotification();
  }

  // --- Commands ----------------------------------------------------------------

  /**
   * Run commands as one list, then read the new state.
   * @param {Array<[string, Array<string|number>?]>} commands
   */
  async run(commands) {
    const conn = this.requireConnection();
    const answers = await conn.commandList(commands);
    await this.refresh().catch(() => {});
    return answers;
  }

  play() {
    // `play` would restart a paused song from its beginning.
    return this.run(this.status?.state === STATES.PAUSE ? [['pause', ['0']]] : [['play']]);
  }

  pause() {
    return this.run([['pause', ['1']]]);
  }

  /** Play or pause, from the state at the time of the tap. */
  async toggle() {
    await this.refresh();
    return this.status?.state === STATES.PLAY ? this.pause() : this.play();
  }

  next() {
    return this.run([['next']]);
  }

  previous() {
    return this.run([['previous']]);
  }

  stopPlayback() {
    return this.run([['stop']]);
  }

  setVolume(volume) {
    const value = Math.round(Math.min(100, Math.max(0, Number(volume))));
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid volume ${volume}`);
    }
    return this.run([['setvol', [value]]]);
  }

  clearQueue() {
    return this.run([['clear']]);
  }

  /** @param {boolean} enabled */
  setRandom(enabled) {
    return this.run([['random', [enabled ? '1' : '0']]]);
  }

  /** @param {'off'|'all'|'one'} mode */
  setRepeat(mode) {
    const { repeat, single } = REPEAT_MODES[mode] ?? REPEAT_MODES.off;
    return this.run([
      ['repeat', [repeat]],
      ['single', [single]],
    ]);
  }

  /**
   * Seek in the current song (`seekcur`, MPD ≥ 0.17). Nothing while stopped:
   * MPD answers "Not playing", and seeking must not start the music.
   * @param {number} seconds
   */
  async seek(seconds) {
    await this.refresh();
    if (this.status?.state === STATES.STOP) {
      return;
    }
    await this.run([['seekcur', [Math.max(0, seconds).toFixed(3)]]]);
  }

  /**
   * Queue songs (Gladys 5.3 catalog): in place of the queue (`replace`, the
   * old queue removed only once the new songs are in), after the current
   * song (`next`) or at the end (`append`). A song MPD does not know (moved
   * since a scene saved it) is skipped, like MPD's own `load` does.
   * @param {string[]} uris
   * @param {'replace'|'next'|'append'} mode
   * @returns {Promise<number>} songs queued
   */
  async queueSongs(uris, mode) {
    const conn = this.requireConnection();
    if (mode === 'replace') {
      this.endNotificationQuietly();
    }
    await this.refresh();
    const length = this.status?.queueLength ?? 0;
    const current = this.status?.song ?? null;
    const at = mode === 'next' && current !== null ? current + 1 : length;
    const ids = [];
    const idOf = (lines) => Number(parsePairs(lines ?? []).find(([key]) => key === 'Id')?.[1]);
    let rest = uris.slice(0, MAX_QUEUED_SONGS);
    while (rest.length > 0) {
      const base = at + ids.length;
      try {
        const answers = await conn.commandList(
          rest.map((uri, index) => ['addid', [uri, base + index]]),
        );
        ids.push(...answers.map(idOf));
        rest = [];
      } catch (err) {
        // An ACK (refused, or a right missing) carries the index of the
        // failing command; a lost connection does not.
        if (!Number.isInteger(err.index) || err.kind === ERROR_KINDS.UNREACHABLE) {
          throw err;
        }
        ids.push(...(err.results ?? []).map(idOf));
        if (err.code !== ACK.NO_EXIST) {
          // Take back what was added: a second try must not queue it twice.
          const added = ids.filter(Number.isInteger);
          if (added.length > 0) {
            await conn.commandList(added.map((id) => ['deleteid', [id]])).catch(() => {});
          }
          throw err;
        }
        logger.debug(`Player ${this.server.slot}: skipped ${rest[err.index]} (${err.message})`);
        rest = rest.slice(err.index + 1);
      }
    }
    const added = ids.filter(Number.isInteger);
    if (added.length === 0) {
      await this.refresh().catch(() => {});
      return 0;
    }
    const commands = [];
    if (mode === 'replace') {
      // The old queue is what is before the first new song now (another
      // client, or `consume`, may have changed it meanwhile).
      const [first] = added;
      const position = Number(
        parsePairs(await conn.command('playlistid', [first])).find(([key]) => key === 'Pos')?.[1],
      );
      if (Number.isInteger(position) && position > 0) {
        commands.push(['delete', [`0:${position}`]]);
      }
      commands.push(['playid', [first]]);
    } else if (mode === 'next' && this.status?.random) {
      // Random play ignores the order of the queue: a priority plays them next.
      commands.push(['prioid', [255, ...added]]);
    }
    if (commands.length > 0) {
      await this.run(commands);
    } else {
      await this.refresh().catch(() => {});
    }
    return added.length;
  }

  /**
   * Play the song at this position of the queue.
   * @returns {Promise<boolean>} false when there is none
   */
  async playIndex(index) {
    try {
      await this.run([['play', [index]]]);
      return true;
    } catch (err) {
      if (err.kind === ERROR_KINDS.COMMAND && err.code === ACK.ARG) {
        return false;
      }
      throw err;
    }
  }

  // --- Artworks ------------------------------------------------------------------

  /**
   * Where the artwork of a song is: its embedded picture (`readpicture`,
   * MPD ≥ 0.22), else the cover file of its folder (`albumart`, MPD ≥ 0.21).
   * Remembered a while per song, one lookup at a time per song. Never throws.
   * @param {string|null} file
   * @param {{ timeoutMs?: number, late?: () => void }} [options] late: called
   *   when a lookup that lost the race against timeoutMs ends
   * @returns {Promise<{ source: { command: string, uri: string, id: string }|null, failed?: boolean }>}
   */
  async lookupArtwork(file, { timeoutMs, late } = {}) {
    if (!file || isStream(file)) {
      return { source: null };
    }
    const known = this.artworkLookups.get(file);
    if (known && this.now() - known.at < this.timings.artworkCacheMs) {
      return { source: known.source };
    }
    let lookup = this.artworkSearches.get(file);
    if (!lookup) {
      lookup = this.findArtwork(file)
        .then((source) => {
          this.artworkLookups.delete(file);
          this.artworkLookups.set(file, { source, at: this.now() });
          if (this.artworkLookups.size > ARTWORK_LOOKUPS_KEPT) {
            this.artworkLookups.delete(this.artworkLookups.keys().next().value);
          }
          return source;
        })
        .finally(() => this.artworkSearches.delete(file));
      lookup.catch(() => {}); // still running when the race is lost
      this.artworkSearches.set(file, lookup);
    }
    let timer;
    let timedOut = false;
    try {
      const source = timeoutMs
        ? await Promise.race([
            lookup,
            new Promise((resolve, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                reject(new Error('timeout'));
              }, timeoutMs);
              timer.unref?.();
            }),
          ])
        : await lookup;
      return { source };
    } catch (err) {
      logger.debug(`Player ${this.server.slot}: artwork not looked up (${err.message})`);
      if (timedOut && late) {
        lookup.then(late, () => {});
      }
      return { source: null, failed: true };
    } finally {
      clearTimeout(timer);
    }
  }

  async findArtwork(file) {
    const conn = await this.side();
    for (const [command, uri] of [
      ['readpicture', file],
      ['albumart', file],
    ]) {
      try {
        const { lines, data } = await conn.binary(command, [uri, 0]);
        if (data && data.length > 0) {
          return {
            // The cover file of a folder: one source (one key) for its songs.
            command,
            uri: command === 'albumart' ? folderUri(file) : uri,
            id: imageId(lines, data),
          };
        }
      } catch (err) {
        // 50: none (or not a song of the library); 5: unknown command (old MPD).
        if (err.kind !== ERROR_KINDS.COMMAND) {
          throw err;
        }
      }
    }
    return null;
  }

  /**
   * The bytes of an artwork, chunk after chunk, up to MAX_ARTWORK_BYTES.
   * @param {{ command: string, uri: string }} source
   * @param {(id: string) => boolean} [known] stops after the first chunk when
   *   it answers true (a resized copy of this image is kept)
   * @returns {Promise<{ data: Buffer|null, id: string }>} id: what tells two
   *   images apart (size and a hash of the first chunk); data null when known
   */
  async readArtwork({ command, uri }, known = () => false) {
    const conn = await this.side();
    const chunks = [];
    let offset = 0;
    let size = null;
    let id = null;
    do {
      const { lines, data } = await conn.binary(command, [uri, offset]);
      if (!data || data.length === 0) {
        if (offset === 0) {
          throw new MpdError(ERROR_KINDS.COMMAND, 'no artwork', { code: ACK.NO_EXIST });
        }
        // Shorter than announced (the file changed meanwhile): never a cut image.
        throw new MpdError(ERROR_KINDS.COMMAND, `artwork cut at ${offset} of ${size} bytes`);
      }
      if (size === null) {
        size = Number(parsePairs(lines).find(([key]) => key === 'size')?.[1]);
        if (!Number.isFinite(size) || size > MAX_ARTWORK_BYTES) {
          throw new MpdError(ERROR_KINDS.TOO_LARGE, `artwork of ${size} bytes`);
        }
        id = imageId(lines, data);
        if (known(id)) {
          return { data: null, id };
        }
      }
      chunks.push(data);
      offset += data.length;
    } while (offset < size);
    return { data: Buffer.concat(chunks), id };
  }

  /**
   * The stored playlist matching a name typed by the user: exact first, then
   * ignoring case and accents. Null when there is none.
   * @param {string} wanted
   */
  async findPlaylist(wanted) {
    await this.refresh({ playlists: true });
    const list = this.playlists ?? [];
    const text = String(wanted ?? '').trim();
    if (list.includes(text)) {
      return text;
    }
    const fold = (value) =>
      value
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase();
    return list.find((name) => fold(name) === fold(text)) ?? null;
  }

  /**
   * Replace the queue with a stored playlist and play it.
   * @param {string} name exact name
   * @returns {Promise<number>} number of songs queued
   */
  async playPlaylist(name) {
    this.endNotificationQuietly();
    await this.run([['clear'], ['load', [name]], ['play']]);
    return this.status?.queueLength ?? 0;
  }

  /**
   * Replace the queue with an address and play it (no resume).
   * @param {string} uri
   */
  async playUri(uri) {
    this.endNotificationQuietly();
    await this.run([['clear'], ['add', [uri]], ['play']]);
  }

  // --- Notifications -------------------------------------------------------------
  //
  // The queue is never replaced: the address is added at its end and played
  // with `single` on (MPD stops after it), `repeat` and `consume` off. When
  // it ends, it is removed, the options and the volume come back, and the
  // song that was playing resumes where it was (paused stays paused). A
  // second notification during the first one replaces it, and the state
  // saved by the first one is kept. A web radio (no duration) is not a
  // notification: it keeps playing, only the options are put back. Someone
  // else taking over the player (next, another song) ends the notification
  // without touching the playback.

  /**
   * @param {string} uri
   * @param {{ volume?: number|null }} [options] volume during the notification
   * @returns {Promise<object>} the notification (for waitForStart)
   */
  playNotification(uri, options) {
    // One at a time: two doorbell presses must not both save the state of
    // the player (the second would save the first notification).
    const run = this.notifying.catch(() => {}).then(() => this.startNotification(uri, options));
    this.notifying = run;
    return run;
  }

  async startNotification(uri, { volume = null } = {}) {
    const conn = this.requireConnection();
    // Added first, alone: an address MPD refuses changes nothing.
    const added = await conn.command('addid', [uri]);
    const id = Number(parsePairs(added).find(([key]) => key === 'Id')?.[1]);
    if (!Number.isInteger(id)) {
      throw new MpdError(ERROR_KINDS.COMMAND, 'MPD did not return the queue id of the address');
    }
    await this.refresh();
    // Read after the reading: a notification may have just ended.
    const previous = this.notification;
    const status = this.status;
    const saved = previous?.saved ?? {
      state: status.state,
      songId: status.songId,
      elapsed: status.elapsed,
      volume: status.volume,
      repeat: status.repeat,
      single: status.single,
      consume: status.consume,
    };
    // Options so that MPD stops after the address and keeps the queue whole
    // (consume would remove the interrupted song). Set once, by the first
    // notification of a series.
    const options = [];
    if (!previous) {
      if (saved.consume !== '0') {
        options.push(['consume', ['0']]);
      }
      if (saved.repeat) {
        options.push(['repeat', ['0']]);
      }
      if (saved.single !== '1') {
        options.push(['single', ['1']]);
      }
    }
    const commands = [...options];
    const target = Number.isFinite(volume) ? Math.round(Math.min(100, Math.max(0, volume))) : null;
    const setVolume = target !== null && status.volume !== null && status.volume !== target;
    if (setVolume) {
      commands.push(['setvol', [target]]);
    }
    commands.push(['playid', [id]]);
    if (previous) {
      clearTimeout(previous.maxTimer);
      clearTimeout(previous.streamTimer);
      commands.push(['deleteid', [previous.id]]);
      // It did play (or was about to): its scene action is not a failure.
      previous.settle();
    }
    let settle;
    const started = new Promise((resolve, reject) => {
      settle = (error) => (error ? reject(error) : resolve());
    });
    // Nobody may wait for the start (onSetValue does not): no unhandled rejection.
    started.catch(() => {});
    const notification = {
      id,
      uri,
      saved,
      changedVolume: (previous?.changedVolume ?? false) || setVolume,
      changedOptions: previous ? previous.changedOptions : options.length > 0,
      startedAt: this.now(),
      playing: false,
      settled: false,
      started,
      settle: (error) => {
        if (!notification.settled) {
          notification.settled = true;
          settle(error);
        }
      },
      maxTimer: null,
      streamTimer: null,
    };
    this.notification = notification;
    if (this.timers) {
      notification.maxTimer = setTimeout(
        () => this.endNotification(notification, 'timeout'),
        this.timings.notificationMaxMs,
      );
      notification.maxTimer.unref?.();
    }
    try {
      await this.run(commands);
    } catch (err) {
      // Not even started: put everything back now.
      await this.endNotification(notification, 'failed', err);
      throw err;
    }
    return notification;
  }

  /**
   * Wait until a notification plays (a scene action reports whether the
   * address could be played). Reads the player every startCheckMs.
   * @param {object} notification what playNotification resolved
   */
  async waitForStart(notification) {
    const deadline = this.now() + this.timings.startTimeoutMs;
    let timer;
    const poll = new Promise((resolve) => {
      const check = () => {
        if (notification.settled || this.now() >= deadline || this.notification !== notification) {
          resolve();
          return;
        }
        this.refresh()
          .catch(() => {})
          .finally(() => {
            timer = setTimeout(check, this.timings.startCheckMs);
          });
      };
      timer = setTimeout(check, this.timings.startCheckMs);
    });
    await Promise.race([notification.started, poll]).finally(() => clearTimeout(timer));
    if (!notification.settled) {
      throw new MpdError(ERROR_KINDS.COMMAND, 'the address did not start playing');
    }
    await notification.started;
  }

  /** After each reading: did the notification start, end, or turn out to be a radio? */
  checkNotification() {
    const notification = this.notification;
    if (!notification || !this.status) {
      return;
    }
    const { state, songId, elapsed, duration } = this.status;
    if (songId === notification.id) {
      if (state === STATES.PLAY) {
        // Playing for real once time goes by (an unreachable address is
        // "play" for an instant, then "stop" with an error).
        if (elapsed > 0 || duration !== null) {
          notification.playing = true;
          notification.settle();
        }
        if (duration === null) {
          this.watchStream(notification);
        }
        return;
      }
      if (state === STATES.PAUSE) {
        return; // paused by someone: the timeout decides
      }
    }
    if (state === STATES.STOP && (songId === notification.id || songId === null)) {
      // Stopped on it: the end (single mode), or an address MPD could not
      // play — it then says why in `error`. A sound shorter than a reading
      // ends without ever being seen playing: that is not a failure.
      const failed = !notification.playing && this.status.error !== null;
      const error = failed ? new MpdError(ERROR_KINDS.COMMAND, this.status.error) : undefined;
      this.endNotification(notification, failed ? 'failed' : 'ended', error);
      return;
    }
    // Another song, or a stop elsewhere in the queue: someone took over.
    this.endNotification(notification, 'interrupted');
  }

  /** Read again when a notification without duration has played long enough to be a radio. */
  watchStream(notification) {
    const playedFor = this.now() - notification.startedAt;
    if (playedFor >= this.timings.streamAfterMs && notification.playing) {
      this.endNotification(notification, 'stream');
      return;
    }
    if (this.timers && !notification.streamTimer) {
      notification.streamTimer = setTimeout(
        () => {
          notification.streamTimer = null;
          this.refresh().catch(() => {});
        },
        Math.max(this.timings.streamAfterMs - playedFor, 0) + 50,
      );
      notification.streamTimer.unref?.();
    }
  }

  /**
   * Put back what the notification changed.
   * @param {object} notification
   * @param {'ended'|'failed'|'interrupted'|'timeout'|'stream'} reason
   * @param {Error} [error]
   */
  async endNotification(notification, reason, error) {
    if (this.notification !== notification) {
      return;
    }
    this.notification = null;
    clearTimeout(notification.maxTimer);
    clearTimeout(notification.streamTimer);
    notification.settle(reason === 'failed' ? (error ?? new Error('failed')) : undefined);
    const { saved } = notification;
    try {
      const conn = this.requireConnection();
      if (reason !== 'stream') {
        // Gone already when someone cleared the queue: not an error.
        await conn.command('deleteid', [notification.id]).catch((err) => {
          if (err.code !== ACK.NO_EXIST) {
            throw err;
          }
        });
      }
      const commands = [];
      if (notification.changedOptions) {
        commands.push(
          ['consume', [saved.consume]],
          ['repeat', [saved.repeat ? '1' : '0']],
          ['single', [saved.single]],
        );
      }
      if (notification.changedVolume && reason !== 'stream' && saved.volume !== null) {
        commands.push(['setvol', [saved.volume]]);
      }
      if (commands.length > 0) {
        await conn.commandList(commands);
      }
      if (['ended', 'failed', 'timeout'].includes(reason)) {
        await this.resume(conn, saved);
      }
      await this.refresh().catch(() => {});
      logger.debug(`Player ${this.server.slot}: notification ${reason}`);
    } catch (err) {
      logger.debug(`Player ${this.server.slot}: notification not put back (${err.message})`);
      error ??= err;
    }
    this.emit('notification', { reason, error: reason === 'failed' ? error : undefined });
  }

  /** Put the saved song back where it was, playing or paused. */
  async resume(conn, saved) {
    if (saved.songId === null || saved.state === STATES.STOP) {
      if (this.status?.state !== STATES.STOP) {
        await conn.command('stop');
      }
      return;
    }
    try {
      // `seekid` starts playing at the saved position.
      await conn.command('seekid', [saved.songId, Math.max(0, saved.elapsed ?? 0).toFixed(3)]);
    } catch (err) {
      if (err.kind === ERROR_KINDS.UNREACHABLE || err.code === ACK.NO_EXIST) {
        throw err;
      }
      // A web radio cannot seek: start it again.
      await conn.command('playid', [saved.songId]);
    }
    if (saved.state === STATES.PAUSE) {
      await conn.command('pause', ['1']);
    }
  }

  /** A command of the user replaces the queue: the notification is over, nothing to resume. */
  endNotificationQuietly() {
    const notification = this.notification;
    if (notification) {
      this.endNotification(notification, 'interrupted').catch(() => {});
    }
  }

  /** The connection is gone: forget the notification (nothing can be put back). */
  dropNotification() {
    const notification = this.notification;
    if (!notification) {
      return;
    }
    this.notification = null;
    clearTimeout(notification.maxTimer);
    clearTimeout(notification.streamTimer);
    notification.settle(new MpdError(ERROR_KINDS.UNREACHABLE, 'connection lost'));
  }
}

/**
 * What tells two images apart without reading them whole: the size MPD
 * announces and a hash of the first chunk.
 */
function imageId(lines, firstChunk) {
  const size = parsePairs(lines).find(([key]) => key === 'size')?.[1] ?? '?';
  return `${size}-${createHash('sha1').update(firstChunk).digest('hex').slice(0, 16)}`;
}

/**
 * The folder of a song as `albumart` takes it: its path with a trailing
 * slash (MPD looks for the cover in the folder of the path it is given). A
 * song at the root of the library is given as is.
 */
export function folderUri(file) {
  const at = file.lastIndexOf('/');
  return at === -1 ? file : file.slice(0, at + 1);
}

/** Any error as an MpdError with a kind. */
function asMpdError(err) {
  if (err instanceof MpdError) {
    return err;
  }
  return new MpdError(ERROR_KINDS.UNREACHABLE, err?.message ?? String(err));
}
