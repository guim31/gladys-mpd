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
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createLogger } from '@gladysassistant/integration-sdk';
import { MpdConnection } from './mpd/connection.js';
import { ACK, ERROR_KINDS, MpdError, parsePairs } from './mpd/protocol.js';
import { STATES, parsePlaylists, parseSong, parseStatus } from './mpd/model.js';

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
};

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
    this.status = parseStatus(statusLines);
    this.song = parseSong(songLines);
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

/** Any error as an MpdError with a kind. */
function asMpdError(err) {
  if (err instanceof MpdError) {
    return err;
  }
  return new MpdError(ERROR_KINDS.UNREACHABLE, err?.message ?? String(err));
}
