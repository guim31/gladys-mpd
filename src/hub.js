// -----------------------------------------------------------------------------
// The hub: one record per configured player (src/player.js), its device
// published to Gladys, its states sent when they change, the commands of
// Gladys (device features, scene actions, widget buttons) routed to it.
//
// Refreshing: each player keeps a connection open in idle, so a change is
// published at once. On top of that the hub reads every player on its own
// timer (every 30 s): it is the ping that notices a silent server, and the
// refresh that does not depend on the core polling the devices
// (GladysAssistant/Gladys#3198). The core's onPoll is a fallback, skipped
// when the player was read less than half a period ago.
// -----------------------------------------------------------------------------

import {
  DEVICE_TRANSPORTS,
  MUSIC_PLAYBACK_STATE,
  MUSIC_REPEAT_MODE,
  createLogger,
} from '@gladysassistant/integration-sdk';
import { formatAddress } from './config.js';
import {
  FEATURE_KEYS,
  buildDevice,
  deviceIds,
  featureKeyOf,
  nowPlaying,
  nowPlayingIds,
  playerName,
  slotOf,
} from './devices.js';
import { createIssueLog } from './issues.js';
import { STATES, describeSong } from './mpd/model.js';
import { ERROR_KINDS, MpdError } from './mpd/protocol.js';
import { Player, checkUri, repeatMode } from './player.js';
import {
  ACTION_TEXT,
  CONNECTION_TEXT,
  ERROR_TEXT,
  MESSAGES,
  REPORT_TEXT,
  UserError,
  fit,
  labelled,
  pick,
  safeText,
} from './texts.js';

const logger = createLogger({ name: 'mpd-hub' });

export const WIDGET_KEY = 'player';

export const HUB_TIMINGS = {
  // The container's own reading of every player (and the ping).
  refreshMs: 30_000,
  // The core drops a widget refresh asked less than 10 s after the previous one.
  widgetNudgeMs: 10_000,
};

// music/repeat values -> the repeat modes of the player.
const REPEAT_KEYS = {
  [MUSIC_REPEAT_MODE.OFF]: 'off',
  [MUSIC_REPEAT_MODE.ALL]: 'all',
  [MUSIC_REPEAT_MODE.ONE]: 'one',
};

const signature = (server) => JSON.stringify([server.host, server.port, server.password]);

export class MpdHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {boolean} [options.timers] periodic timers (off in most tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {object} [options.playerTimings] PLAYER_TIMINGS overrides
   * @param {object} [options.connectionTimings] CONNECTION_TIMINGS overrides
   * @param {Function} [options.connect] socket seam
   * @param {() => number} [options.now]
   */
  constructor({ gladys, timers = true, timings, playerTimings, connectionTimings, connect, now }) {
    this.gladys = gladys;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.playerOptions = { timings: playerTimings, connectionTimings, connect };
    this.now = now ?? (() => Date.now());
    this.config = null;
    /** @type {Map<number, object>} player records, by slot */
    this.records = new Map();
    this.transports = new Map();
    this.connection = null;
    this.tickTimer = null;
    this.nudgeTimer = null;
    this.lastNudge = -Infinity;
    this.stopped = false;
    this.issues = createIssueLog(logger);
    /** Resized artworks by image (src/catalog.js), shared by every player. */
    this.preparedArtworks = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it may have restarted): send everything again. */
  async resync(config) {
    this.transports.clear();
    this.connection = null;
    this.gladys.forgetPublishedStates?.();
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    this.config = config;
    const wanted = new Map(config.players.map((server) => [server.slot, server]));
    for (const [slot, record] of this.records) {
      const server = wanted.get(slot);
      if (!server || record.signature !== signature(server)) {
        record.player.removeAllListeners();
        record.player.stop();
        this.records.delete(slot);
        this.transports.delete(deviceIds(this.gladys, slot).device);
      }
    }
    const fresh = [];
    for (const server of config.players) {
      const record = this.records.get(server.slot);
      if (record) {
        record.server = server; // a new name: same connection
      } else {
        fresh.push(this.addRecord(server));
      }
    }
    await Promise.all(fresh.map((record) => record.player.connect()));
    await this.publishDevices();
    await Promise.all([...this.records.values()].map((record) => this.publishStates(record)));
    await this.afterChanges();
    this.nudgeWidget();
    this.scheduleTick();
  }

  addRecord(server) {
    const player = new Player({
      server,
      timers: this.timersEnabled,
      now: this.now,
      ...this.playerOptions,
    });
    const record = {
      server,
      signature: signature(server),
      player,
      playlistsKey: null,
      viewKey: null,
    };
    this.records.set(server.slot, record);
    const key = `connection:${server.slot}`;
    player.on('connected', ({ restored }) => {
      this.issues.ok(key);
      logger.info(
        restored
          ? `${this.label(record)}: connection restored`
          : `${this.label(record)}: connected (MPD ${player.version})`,
      );
      this.onPlayerChange(record);
    });
    player.on('failed', (err) => {
      this.issues.fail(key, `${this.label(record)}: ${safeText(err.message)}`);
      this.publishStates(record).catch(() => {});
      this.onPlayerChange(record);
    });
    player.on('disconnected', (err) => {
      this.issues.fail(key, `${this.label(record)}: connection lost (${safeText(err.message)})`);
      this.publishStates(record).catch(() => {});
      this.onPlayerChange(record);
    });
    player.on('update', () => this.onUpdate(record));
    player.on('notification', ({ reason, error }) => {
      if (reason === 'failed') {
        logger.warn(`${this.label(record)}: notification not played (${safeText(error?.message)})`);
      }
    });
    return record;
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.tickTimer);
    clearTimeout(this.nudgeTimer);
    for (const record of this.records.values()) {
      record.player.removeAllListeners();
      record.player.stop();
    }
  }

  label(record) {
    return `Player ${record.server.slot} (${playerName(record.server)})`;
  }

  // --- Timer -------------------------------------------------------------------

  scheduleTick() {
    clearTimeout(this.tickTimer);
    if (!this.timersEnabled || this.stopped || this.records.size === 0) {
      return;
    }
    this.tickTimer = setTimeout(async () => {
      try {
        await this.tick();
        this.issues.ok('tick');
      } catch (err) {
        this.issues.fail('tick', `Refresh failed: ${err.message}`);
      }
      this.scheduleTick();
    }, this.timings.refreshMs);
    this.tickTimer.unref?.();
  }

  /** Read every player not read for half a period (or try to connect it). */
  async tick() {
    await Promise.all([...this.records.values()].map((record) => this.refreshRecord(record, 0.5)));
  }

  async refreshRecord(record, minGap) {
    const { player } = record;
    const age = player.refreshedAt === null ? Infinity : this.now() - player.refreshedAt;
    if (player.connected && age < this.timings.refreshMs * minGap) {
      logger.debug(`${this.label(record)}: read ${age} ms ago, skipped`);
      return;
    }
    await player.tick();
  }

  /** The core's onPoll (fallback of the timer). */
  async pollDevice(device) {
    const record = this.recordOf(device.external_id, { quiet: true });
    if (record) {
      await this.refreshRecord(record, 0.5);
    }
  }

  // --- Devices -----------------------------------------------------------------

  async publishDevices() {
    const devices = [...this.records.values()].map((record) => {
      record.playlistsKey = JSON.stringify(record.player.playlists);
      return buildDevice(this.gladys, record.server, this.config.language, record.player.playlists);
    });
    try {
      // Even an empty list: the Discovery tab then shows no stale player.
      await this.gladys.publishDiscoveredDevices(devices);
      this.issues.ok('devices', 'Devices published again');
    } catch (err) {
      this.issues.fail('devices', `Devices refused by Gladys: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: read the players, publish the devices again. */
  async rediscover() {
    await Promise.all([...this.records.values()].map((record) => record.player.tick()));
    await this.publishDevices();
  }

  isCreated(slot) {
    const externalId = deviceIds(this.gladys, slot).device;
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  /** The user added a device: its states sent before were dropped by Gladys. */
  async onDeviceCreated(device) {
    const record = this.recordOf(device.external_id, { quiet: true });
    if (!record) {
      return;
    }
    this.transports.delete(device.external_id);
    await this.publishStates(record);
    await this.publishTransports();
    this.nudgeWidget({ force: true });
  }

  // --- Player changes ------------------------------------------------------------

  onUpdate(record) {
    this.publishStates(record).catch(() => {});
    if (
      JSON.stringify(record.player.playlists) !== record.playlistsKey &&
      record.playlistsKey !== null
    ) {
      // A playlist saved or deleted: the select of the device follows.
      this.publishDevices().catch(() => {});
    }
    this.onPlayerChange(record);
  }

  onPlayerChange(record) {
    const key = this.viewKey(record);
    if (key !== record.viewKey) {
      record.viewKey = key;
      this.nudgeWidget();
    }
    this.afterChanges().catch(() => {});
  }

  /** What the widget shows of a player: when it changes, the widget is refreshed. */
  viewKey(record) {
    const { player } = record;
    const { status } = player;
    return JSON.stringify([
      player.connected,
      player.error?.kind ?? null,
      status?.state,
      status?.volume,
      status?.random,
      repeatMode(status),
      status?.queueLength,
      status?.song,
      describeSong(player.song),
      player.playlists,
    ]);
  }

  /**
   * The music features of a player, through publishNowPlaying: diffed by the
   * SDK, the position sent only on a change of state or song, or a seek
   * (Gladys extrapolates it). A player that no longer answers is shown
   * stopped (its last song stays), never playing forever.
   */
  async publishStates(record) {
    const { player } = record;
    if (!player.status || !this.isCreated(record.server.slot)) {
      return;
    }
    const { slot } = record.server;
    const snapshot = player.connected
      ? nowPlaying(player.status, player.song, {
          artworkUrl: this.artworkUrl(record, player.artwork),
          // During a notification, the modes it put aside.
          repeat: repeatMode(player.notification?.saved ?? player.status),
        })
      : { playback_state: MUSIC_PLAYBACK_STATE.IDLE, position: 0 };
    try {
      await this.gladys.publishNowPlaying(deviceIds(this.gladys, slot).device, snapshot, {
        featureExternalIds: nowPlayingIds(this.gladys, slot),
      });
      this.issues.ok('states', 'States accepted by Gladys again');
    } catch (err) {
      this.issues.fail('states', `States of ${this.label(record)} refused: ${err.message}`);
    }
  }

  /**
   * The source of an artwork as given to artworkKey: what onMusicGetArtwork
   * reads back (src/catalog.js). The address is in it, so another player in
   * the same slot never gets the cached image of the previous one.
   * @param {object} record
   * @param {{ command: string, uri: string }|null} source
   * @returns {string|null}
   */
  artworkUrl(record, source) {
    if (!source) {
      return null;
    }
    return JSON.stringify(['mpd', record.server.slot, formatAddress(record.server), source]);
  }

  async afterChanges() {
    await this.publishTransports();
    await this.publishConnectionStatus();
  }

  async publishTransports() {
    const entries = [];
    for (const record of this.records.values()) {
      const { player } = record;
      if (!player.connected && player.error === null) {
        continue; // first attempt still running
      }
      if (!this.isCreated(record.server.slot)) {
        continue;
      }
      const externalId = deviceIds(this.gladys, record.server.slot).device;
      const transport = player.connected ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
      if (this.transports.get(externalId) !== transport) {
        entries.push({ external_id: externalId, transport });
      }
    }
    if (entries.length === 0) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      for (const entry of entries) {
        this.transports.set(entry.external_id, entry.transport);
      }
      this.issues.ok('transports');
    } catch (err) {
      this.issues.fail('transports', `Transports refused: ${err.message}`);
    }
  }

  /** The status under the integration name: connected while one player answers. */
  connectionStatus() {
    const { players, invalidSlots } = this.config;
    if (players.length === 0) {
      return {
        connected: false,
        message: invalidSlots.length ? CONNECTION_TEXT.invalidAddress : CONNECTION_TEXT.noPlayer,
      };
    }
    const records = [...this.records.values()];
    const failing = records.filter((record) => !record.player.connected);
    if (failing.length === 0 && invalidSlots.length === 0) {
      return { connected: true };
    }
    const message = {};
    for (const language of Object.keys(CONNECTION_TEXT.noPlayer)) {
      const parts = failing.map((record) =>
        labelled(
          playerName(record.server),
          record.player.error
            ? pick(ERROR_TEXT[record.player.error.kind] ?? ERROR_TEXT.unreachable, language)
            : pick(CONNECTION_TEXT.connecting, language),
          language,
        ),
      );
      if (invalidSlots.length) {
        parts.push(pick(CONNECTION_TEXT.invalidAddress, language));
      }
      message[language] = fit(parts.join(' · '), 200);
    }
    return { connected: failing.length < records.length, message };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    this.connection = key;
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.issues.ok('connection-status');
    } catch (err) {
      this.connection = null;
      this.issues.fail('connection-status', `Connection status refused: ${err.message}`);
    }
  }

  /**
   * Ask Gladys to pull the widget again, at most once per 10 s (the core
   * drops the others): a change inside the window is sent at its end.
   */
  nudgeWidget({ force = false } = {}) {
    if (this.stopped) {
      return;
    }
    const wait = this.lastNudge + this.timings.widgetNudgeMs - this.now();
    if (wait <= 0 || force) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
      this.lastNudge = this.now();
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
      return;
    }
    if (this.timersEnabled && !this.nudgeTimer) {
      this.nudgeTimer = setTimeout(() => {
        this.nudgeTimer = null;
        this.nudgeWidget();
      }, wait);
      this.nudgeTimer.unref?.();
    }
  }

  // --- Commands --------------------------------------------------------------------

  get language() {
    return this.config?.language ?? 'fr';
  }

  /**
   * The record of a device external id.
   * @param {string} externalId
   * @param {{ quiet?: boolean }} [options] quiet: null instead of throwing
   */
  recordOf(externalId, { quiet = false } = {}) {
    const slot = slotOf(this.gladys, externalId);
    const record = slot === null ? null : (this.records.get(slot) ?? null);
    if (!record && !quiet) {
      throw new UserError(
        this.records.size === 0 ? ACTION_TEXT.noPlayer : ACTION_TEXT.unknownPlayer,
        this.language,
      );
    }
    return record;
  }

  /**
   * The record of a scene action or widget: the device chosen, or the only
   * player when there is just one.
   * @param {string|null|undefined} externalId
   */
  target(externalId) {
    if (externalId) {
      return this.recordOf(externalId);
    }
    const [first] = this.records.values();
    if (!first) {
      throw new UserError(ACTION_TEXT.noPlayer, this.language);
    }
    return first;
  }

  /**
   * Run a command on a player: one info line (the user acted), and an MPD
   * error turned into a sentence the user can read.
   * @param {object} record
   * @param {string} what for the log line
   * @param {(player: Player) => Promise<any>} fn
   * @param {{ quiet?: boolean }} [options] quiet: a reading (browse, search), logged at debug
   */
  async command(record, what, fn, { quiet = false } = {}) {
    logger[quiet ? 'debug' : 'info'](`${this.label(record)}: ${what}`);
    try {
      return await fn(record.player);
    } catch (err) {
      if (err instanceof UserError) {
        throw err;
      }
      if (err instanceof MpdError) {
        logger.warn(`${this.label(record)}: ${what} failed (${safeText(err.message)})`);
        let text = ACTION_TEXT.unreachable;
        if (err.kind === ERROR_KINDS.TOO_LARGE) {
          text = ACTION_TEXT.tooLarge;
        } else if (err.kind === ERROR_KINDS.COMMAND) {
          text = ACTION_TEXT.refused;
        }
        throw new UserError(text, this.language);
      }
      throw err;
    }
  }

  /**
   * A feature of a device: play, pause, previous, next, volume, playback
   * state, position, shuffle, repeat, playlist, notification.
   */
  async setValue(device, feature, value) {
    const record = this.recordOf(device.external_id);
    const key = featureKeyOf(this.gladys, record.server.slot, feature.external_id);
    switch (key) {
      case FEATURE_KEYS.PLAY:
        return this.command(record, 'play', (player) => player.play());
      case FEATURE_KEYS.PAUSE:
        return this.command(record, 'pause', (player) => player.pause());
      case FEATURE_KEYS.NEXT:
        return this.command(record, 'next track', (player) => player.next());
      case FEATURE_KEYS.PREVIOUS:
        return this.command(record, 'previous track', (player) => player.previous());
      case FEATURE_KEYS.VOLUME:
        return this.setVolume(record, value);
      case FEATURE_KEYS.PLAYBACK_STATE:
        return this.setPlaybackState(record, value);
      case FEATURE_KEYS.POSITION:
        return this.seek(record, value);
      case FEATURE_KEYS.SHUFFLE:
        return this.command(record, Number(value) === 1 ? 'shuffle on' : 'shuffle off', (player) =>
          player.setRandom(Number(value) === 1),
        );
      case FEATURE_KEYS.REPEAT: {
        const mode = REPEAT_KEYS[Number(value)];
        if (!mode) {
          throw new Error(`Invalid repeat mode ${value}`);
        }
        return this.command(record, `repeat ${mode}`, (player) => player.setRepeat(mode));
      }
      case FEATURE_KEYS.PLAYLIST:
        await this.playPlaylist(record, value);
        return undefined;
      case FEATURE_KEYS.NOTIFICATION:
        // Not awaited to its end: Gladys waits 5 s for the answer.
        await this.notify(record, value, { volume: this.config.notificationVolume });
        return undefined;
      default:
        throw new Error(`Feature ${feature.external_id} cannot be controlled`);
    }
  }

  /** Writing music/playback_state (Gladys 5.3): 0 pause, 1 play, 2 stop. */
  async setPlaybackState(record, value) {
    switch (Number(value)) {
      case MUSIC_PLAYBACK_STATE.PAUSED:
        return this.command(record, 'pause', (player) => player.pause());
      case MUSIC_PLAYBACK_STATE.PLAYING:
        return this.command(record, 'play', (player) => player.play());
      case MUSIC_PLAYBACK_STATE.IDLE:
        return this.command(record, 'stop', (player) => player.stopPlayback());
      default:
        throw new Error(`Invalid playback state ${value}`);
    }
  }

  /** Writing music/position (Gladys 5.3): a seek, in seconds. */
  async seek(record, value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error(`Invalid position ${value}`);
    }
    return this.command(record, `seek ${Math.round(seconds)} s`, (player) => player.seek(seconds));
  }

  async setVolume(record, value) {
    const volume = Math.round(Number(value));
    if (!Number.isFinite(volume)) {
      throw new Error(`Invalid volume ${value}`);
    }
    if (record.player.connected && record.player.status?.volume === null) {
      throw new UserError(ACTION_TEXT.noVolume, this.language);
    }
    return this.command(record, `volume ${volume}`, (player) => player.setVolume(volume));
  }

  /**
   * Replace the queue with a stored playlist (name matched without case nor
   * accents) and play it.
   * @returns {Promise<{ name: string, songs: number }>}
   */
  async playPlaylist(record, wanted) {
    const name = String(wanted ?? '').trim();
    if (!name) {
      throw new UserError(ACTION_TEXT.noPlaylistName, this.language);
    }
    return this.command(record, `playlist "${name}"`, async (player) => {
      const found = await player.findPlaylist(name);
      if (!found) {
        const names = fit((player.playlists ?? []).join(', '), 120);
        throw new UserError(
          Object.fromEntries(
            Object.entries(MESSAGES).map(([lang, text]) => [
              lang,
              text.playlistNotFound(name, names),
            ]),
          ),
          this.language,
        );
      }
      const songs = await player.playPlaylist(found);
      return { name: found, songs };
    });
  }

  /**
   * Play an address, then what was playing (resume) — or in place of the queue.
   * @param {object} record
   * @param {unknown} value the address
   * @param {{ volume?: number|null, resume?: boolean, wait?: boolean }} [options]
   *   wait: until it plays (a scene action reports a failure)
   */
  async notify(record, value, { volume = null, resume = true, wait = false } = {}) {
    const uri = checkUri(value);
    if (!uri) {
      throw new UserError(ACTION_TEXT.invalidUri, this.language);
    }
    const shown = safeText(uri);
    if (!resume) {
      return this.command(record, `play ${shown}`, async (player) => {
        if (volume !== null && player.status?.volume !== null) {
          await player.setVolume(volume);
        }
        await player.playUri(uri);
      });
    }
    return this.command(record, `notification ${shown}`, async (player) => {
      const notification = await player.playNotification(uri, { volume });
      if (wait) {
        try {
          await player.waitForStart(notification);
        } catch (err) {
          // A refused address is logged by the `notification` event of the player.
          if (err instanceof MpdError && err.kind === ERROR_KINDS.COMMAND) {
            logger.debug(
              `${this.label(record)}: ${shown} did not start (${safeText(err.message)})`,
            );
            throw new UserError(ACTION_TEXT.notStarted, this.language);
          }
          throw err;
        }
      }
    });
  }

  // --- Reports ---------------------------------------------------------------------------

  /** "Test the connection": connect or read every player now, one line each. */
  async testConnection() {
    await Promise.all(
      [...this.records.values()].map((record) =>
        record.player.connected ? record.player.refresh().catch(() => {}) : record.player.connect(),
      ),
    );
    await this.afterChanges();
    const message = {};
    for (const [language, text] of Object.entries(REPORT_TEXT)) {
      if (this.records.size === 0) {
        message[language] = pick(this.connectionStatus().message, language);
        continue;
      }
      const lines = [...this.records.values()].map((record) => {
        const { player, server } = record;
        const name = `${playerName(server)} (${formatAddress(server)})`;
        if (!player.connected) {
          const kind = player.error?.kind ?? ERROR_KINDS.UNREACHABLE;
          return labelled(
            name,
            pick(ERROR_TEXT[kind] ?? ERROR_TEXT.unreachable, language),
            language,
          );
        }
        const { status } = player;
        const parts = [`MPD ${player.version}`];
        parts.push(
          status.state === STATES.PLAY
            ? text.playing
            : status.state === STATES.PAUSE
              ? text.paused
              : text.stopped,
        );
        parts.push(status.volume === null ? text.noVolume : text.volume(status.volume));
        if (player.playlists) {
          parts.push(text.playlists(player.playlists.length));
        }
        return labelled(name, parts.join(', '), language);
      });
      if (this.config.invalidSlots.length) {
        lines.push(pick(CONNECTION_TEXT.invalidAddress, language));
      }
      message[language] = lines.join('\n');
    }
    return message;
  }
}
