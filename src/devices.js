// -----------------------------------------------------------------------------
// One Gladys device per MPD player, with the music features of the core so
// that Gladys shows it as a player (the "Music" dashboard box, the "Talk on a
// speaker" scene action):
//   - play, pause, previous, next: music/play… commands (has_feedback false:
//     Gladys keeps the last command it sent, the playback state says the truth);
//   - volume: music/volume 0-100, has_feedback true (MPD's mixer answers);
//   - playback state: music/playback_state, 1 playing, 0 paused, 2 stopped
//     (MUSIC_PLAYBACK_STATE of the core), writable since Gladys 5.3;
//   - now playing (Gladys 5.3): title, artist, album, artwork (an image key
//     served by src/catalog.js), duration and position (seconds, position
//     writable = seek), shuffle (MPD's random), repeat (off, all, one: MPD's
//     repeat + single), published by publishNowPlaying on MPD's idle events.
//     No mute: MPD has none (setvol 0 would lose the volume, see CLAUDE.md);
//   - notification: music/play_notification, receives an address (a URL or a
//     path of the music library) to play, then what played comes back;
//   - playlist: text/select whose options are the stored playlists of MPD,
//     upserted at each publication (Gladys syncs `supported_options` of an
//     added device without asking): picking one plays it, in the dashboard
//     or from the "Control a device" scene action.
//
// Identity: the configuration slot (1 to 4), see src/config.js.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
  DEVICE_POLL_FREQUENCIES,
  MUSIC_PLAYBACK_STATE,
  MUSIC_REPEAT_MODE,
} from '@gladysassistant/integration-sdk';
import { SLOTS, formatAddress } from './config.js';
import { STATES, baseName, isStream } from './mpd/model.js';

export const DEVICE_TYPE = 'mpd';
export const ADDRESS_PARAM = 'MPD_ADDRESS';

// The core may poll (onPoll, a fallback of the container's own timer) once a
// minute: the slowest pace it knows.
export const POLL_FREQUENCY = DEVICE_POLL_FREQUENCIES.EVERY_MINUTES;

// At most this many playlists in the select (and in the widget form).
export const MAX_PLAYLISTS = 100;

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  PLAY: 'play',
  PAUSE: 'pause',
  PREVIOUS: 'previous',
  NEXT: 'next',
  VOLUME: 'volume',
  PLAYBACK_STATE: 'playback-state',
  // Gladys 5.3: the same as the feature types, the default of publishNowPlaying.
  TITLE: 'title',
  ARTIST: 'artist',
  ALBUM: 'album',
  ARTWORK: 'artwork',
  DURATION: 'duration',
  POSITION: 'position',
  SHUFFLE: 'shuffle',
  REPEAT: 'repeat',
  PLAYLIST: 'playlist',
  NOTIFICATION: 'play-notification',
});

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    [FEATURE_KEYS.PLAY]: 'Play',
    [FEATURE_KEYS.PAUSE]: 'Pause',
    [FEATURE_KEYS.PREVIOUS]: 'Previous track',
    [FEATURE_KEYS.NEXT]: 'Next track',
    [FEATURE_KEYS.VOLUME]: 'Volume',
    [FEATURE_KEYS.PLAYBACK_STATE]: 'Playback state',
    [FEATURE_KEYS.TITLE]: 'Title',
    [FEATURE_KEYS.ARTIST]: 'Artist',
    [FEATURE_KEYS.ALBUM]: 'Album',
    [FEATURE_KEYS.ARTWORK]: 'Artwork',
    [FEATURE_KEYS.DURATION]: 'Duration',
    [FEATURE_KEYS.POSITION]: 'Position',
    [FEATURE_KEYS.SHUFFLE]: 'Shuffle',
    [FEATURE_KEYS.REPEAT]: 'Repeat',
    [FEATURE_KEYS.PLAYLIST]: 'Playlist',
    [FEATURE_KEYS.NOTIFICATION]: 'Notification',
  },
  fr: {
    [FEATURE_KEYS.PLAY]: 'Lecture',
    [FEATURE_KEYS.PAUSE]: 'Pause',
    [FEATURE_KEYS.PREVIOUS]: 'Morceau précédent',
    [FEATURE_KEYS.NEXT]: 'Morceau suivant',
    [FEATURE_KEYS.VOLUME]: 'Volume',
    [FEATURE_KEYS.PLAYBACK_STATE]: 'État de lecture',
    [FEATURE_KEYS.TITLE]: 'Titre',
    [FEATURE_KEYS.ARTIST]: 'Artiste',
    [FEATURE_KEYS.ALBUM]: 'Album',
    [FEATURE_KEYS.ARTWORK]: 'Pochette',
    [FEATURE_KEYS.DURATION]: 'Durée',
    [FEATURE_KEYS.POSITION]: 'Position',
    [FEATURE_KEYS.SHUFFLE]: 'Lecture aléatoire',
    [FEATURE_KEYS.REPEAT]: 'Répétition',
    [FEATURE_KEYS.PLAYLIST]: 'Playlist',
    [FEATURE_KEYS.NOTIFICATION]: 'Notification',
  },
  de: {
    [FEATURE_KEYS.PLAY]: 'Wiedergabe',
    [FEATURE_KEYS.PAUSE]: 'Pause',
    [FEATURE_KEYS.PREVIOUS]: 'Vorheriger Titel',
    [FEATURE_KEYS.NEXT]: 'Nächster Titel',
    [FEATURE_KEYS.VOLUME]: 'Lautstärke',
    [FEATURE_KEYS.PLAYBACK_STATE]: 'Wiedergabestatus',
    [FEATURE_KEYS.TITLE]: 'Titel',
    [FEATURE_KEYS.ARTIST]: 'Künstler',
    [FEATURE_KEYS.ALBUM]: 'Album',
    [FEATURE_KEYS.ARTWORK]: 'Cover',
    [FEATURE_KEYS.DURATION]: 'Dauer',
    [FEATURE_KEYS.POSITION]: 'Position',
    [FEATURE_KEYS.SHUFFLE]: 'Zufallswiedergabe',
    [FEATURE_KEYS.REPEAT]: 'Wiederholung',
    [FEATURE_KEYS.PLAYLIST]: 'Playlist',
    [FEATURE_KEYS.NOTIFICATION]: 'Benachrichtigung',
  },
  es: {
    [FEATURE_KEYS.PLAY]: 'Reproducir',
    [FEATURE_KEYS.PAUSE]: 'Pausa',
    [FEATURE_KEYS.PREVIOUS]: 'Pista anterior',
    [FEATURE_KEYS.NEXT]: 'Pista siguiente',
    [FEATURE_KEYS.VOLUME]: 'Volumen',
    [FEATURE_KEYS.PLAYBACK_STATE]: 'Estado de reproducción',
    [FEATURE_KEYS.TITLE]: 'Título',
    [FEATURE_KEYS.ARTIST]: 'Artista',
    [FEATURE_KEYS.ALBUM]: 'Álbum',
    [FEATURE_KEYS.ARTWORK]: 'Carátula',
    [FEATURE_KEYS.DURATION]: 'Duración',
    [FEATURE_KEYS.POSITION]: 'Posición',
    [FEATURE_KEYS.SHUFFLE]: 'Reproducción aleatoria',
    [FEATURE_KEYS.REPEAT]: 'Repetición',
    [FEATURE_KEYS.PLAYLIST]: 'Lista de reproducción',
    [FEATURE_KEYS.NOTIFICATION]: 'Notificación',
  },
};

const MUSIC = DEVICE_FEATURE_CATEGORIES.MUSIC;
const TYPES = DEVICE_FEATURE_TYPES.MUSIC;

// Bound of the duration and the position (24 h: a long mix, an audiobook).
export const MAX_SECONDS = 86_400;

/** A writable music feature that MPD confirms through its idle events. */
const control = (key, type, max, extra = {}) => ({
  key,
  definition: {
    category: MUSIC,
    type,
    read_only: false,
    has_feedback: true,
    keep_history: false,
    min: 0,
    max,
    ...extra,
  },
});

/** A read-only string feature (the core stores its value as a text). */
const text = (key, type) => ({
  key,
  definition: {
    category: MUSIC,
    type,
    read_only: true,
    has_feedback: false,
    keep_history: false,
    // NOT NULL in the core database, meaningless for a text.
    min: 0,
    max: 0,
  },
});

const command = (key, type) => ({
  key,
  definition: {
    category: MUSIC,
    type,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    min: 0,
    max: 1,
  },
});

// Order = display order in Gladys.
const FEATURES = [
  command(FEATURE_KEYS.PLAY, TYPES.PLAY),
  command(FEATURE_KEYS.PAUSE, TYPES.PAUSE),
  command(FEATURE_KEYS.PREVIOUS, TYPES.PREVIOUS),
  command(FEATURE_KEYS.NEXT, TYPES.NEXT),
  // No mixer: MPD can neither tell nor change the volume, nothing is
  // published for it.
  control(FEATURE_KEYS.VOLUME, TYPES.VOLUME, 100),
  // PAUSED 0, PLAYING 1, IDLE 2 (stopped); BUFFERING is never reported.
  // Read-only, max 1 before 1.1.0: same external id, the "Update" of the
  // Discover tab makes it writable.
  control(FEATURE_KEYS.PLAYBACK_STATE, TYPES.PLAYBACK_STATE, MUSIC_PLAYBACK_STATE.IDLE),
  text(FEATURE_KEYS.TITLE, TYPES.TITLE),
  text(FEATURE_KEYS.ARTIST, TYPES.ARTIST),
  text(FEATURE_KEYS.ALBUM, TYPES.ALBUM),
  text(FEATURE_KEYS.ARTWORK, TYPES.ARTWORK),
  {
    key: FEATURE_KEYS.DURATION,
    definition: {
      category: MUSIC,
      type: TYPES.DURATION,
      unit: DEVICE_FEATURE_UNITS.SECONDS,
      read_only: true,
      has_feedback: false,
      keep_history: false,
      min: 0,
      max: MAX_SECONDS,
    },
  },
  control(FEATURE_KEYS.POSITION, TYPES.POSITION, MAX_SECONDS, {
    unit: DEVICE_FEATURE_UNITS.SECONDS,
  }),
  control(FEATURE_KEYS.SHUFFLE, TYPES.SHUFFLE, 1),
  control(FEATURE_KEYS.REPEAT, TYPES.REPEAT, MUSIC_REPEAT_MODE.ONE),
  {
    key: FEATURE_KEYS.PLAYLIST,
    definition: {
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.SELECT,
      read_only: false,
      // Gladys saves the option picked; MPD has no "current playlist" to
      // report back (the queue is a copy of it).
      has_feedback: false,
      keep_history: false,
      // NOT NULL in the core database, meaningless for a select.
      min: 0,
      max: 0,
    },
  },
  {
    key: FEATURE_KEYS.NOTIFICATION,
    definition: {
      category: MUSIC,
      type: TYPES.PLAY_NOTIFICATION,
      read_only: false,
      has_feedback: false,
      keep_history: false,
      min: 0,
      max: 0,
    },
  },
];

/** External ids of a player's device and features. */
export const deviceIds = (gladys, slot) => gladys.externalIds(DEVICE_TYPE, String(slot));

/** The slot of a device external id, null when it is not one of ours. */
export function slotOf(gladys, externalId) {
  for (const slot of SLOTS) {
    if (deviceIds(gladys, slot).device === externalId) {
      return slot;
    }
  }
  return null;
}

/** The name shown for a player: the one typed in the configuration, else its address. */
export const playerName = (server) => server.name ?? `MPD ${formatAddress(server)}`;

/**
 * The options of the playlist select. Values are the playlist names: the
 * core refuses a value that is blank or has spaces around it (a trimmed
 * string), and duplicates.
 * @param {string[]|null} playlists
 * @returns {Array<{ value: string, label: string }>|undefined} undefined when
 *   unknown (player not read yet): the options already in Gladys stay
 */
export function playlistOptions(playlists) {
  if (!Array.isArray(playlists)) {
    return undefined;
  }
  const seen = new Set();
  const options = [];
  for (const name of playlists) {
    if (typeof name !== 'string' || name !== name.trim() || name === '' || seen.has(name)) {
      continue;
    }
    seen.add(name);
    options.push({ value: name, label: name });
    if (options.length === MAX_PLAYLISTS) {
      break;
    }
  }
  return options;
}

/**
 * The discovery payload of a player.
 * @param {object} gladys SDK client
 * @param {{ slot: number, host: string, port: number, name: string|null }} server
 * @param {string} language feature names language
 * @param {string[]|null} [playlists] stored playlists, when known
 */
export function buildDevice(gladys, server, language = 'fr', playlists = null) {
  const ids = deviceIds(gladys, server.slot);
  const names = NAMES[language] ?? NAMES.fr;
  const options = playlistOptions(playlists);
  return {
    name: playerName(server),
    external_id: ids.device,
    // The container keeps a connection open and refreshes on its own timer
    // (Gladys#3198: the core may never poll); onPoll is the fallback.
    should_poll: true,
    poll_frequency: POLL_FREQUENCY,
    params: [{ name: ADDRESS_PARAM, value: formatAddress(server) }],
    features: FEATURES.map(({ key, definition }) => {
      const feature = { ...definition, name: names[key], external_id: ids.feature(key) };
      if (key === FEATURE_KEYS.PLAYLIST && options !== undefined) {
        feature.supported_options = options;
      }
      return feature;
    }),
  };
}

const PLAYBACK_STATES = {
  [STATES.PLAY]: MUSIC_PLAYBACK_STATE.PLAYING,
  [STATES.PAUSE]: MUSIC_PLAYBACK_STATE.PAUSED,
  [STATES.STOP]: MUSIC_PLAYBACK_STATE.IDLE,
};

const REPEAT_STATES = {
  off: MUSIC_REPEAT_MODE.OFF,
  all: MUSIC_REPEAT_MODE.ALL,
  one: MUSIC_REPEAT_MODE.ONE,
};

const seconds = (value) => Math.max(0, Math.round(Number(value) || 0));

/**
 * The snapshot given to publishNowPlaying (Gladys 5.3).
 *   - Nothing loaded (empty queue): the texts are cleared explicitly (an
 *     absent key means "unchanged").
 *   - A web radio: the song it announces (`Title`) as title, the station
 *     (`Name`) as album, duration 0 (live).
 *   - Stopped with a song still current (MPD keeps it): IDLE, the song stays
 *     shown with its duration, position 0.
 *   - The position is not capped on a stream: the SDK extrapolates it without
 *     a bound, a capped one would drift and be published again and again.
 * @param {object} status parseStatus()
 * @param {object|null} song parseSong()
 * @param {object} [options]
 * @param {string|null} [options.artworkUrl] the source given to artworkKey
 * @param {'off'|'all'|'one'} [options.repeat] the repeat mode to show
 */
export function nowPlaying(status, song, { artworkUrl = null, repeat = 'off' } = {}) {
  const loaded = song !== null;
  const duration = loaded ? seconds(status.duration ?? song.duration) : 0;
  const elapsed = seconds(status.elapsed);
  const snapshot = {
    playback_state: PLAYBACK_STATES[status.state] ?? MUSIC_PLAYBACK_STATE.IDLE,
    title: '',
    artist: '',
    album: '',
    artwork_url: loaded ? artworkUrl : null,
    duration,
    position:
      loaded && status.state !== STATES.STOP
        ? duration > 0
          ? Math.min(elapsed, duration)
          : elapsed
        : 0,
    shuffle: status.random,
    repeat: REPEAT_STATES[repeat] ?? MUSIC_REPEAT_MODE.OFF,
  };
  if (loaded && isStream(song.file)) {
    snapshot.title = song.title ?? song.name ?? baseName(song.file);
    snapshot.artist = song.artist ?? '';
    snapshot.album = song.name && song.name !== snapshot.title ? song.name : (song.album ?? '');
  } else if (loaded) {
    snapshot.title = song.title ?? song.name ?? baseName(song.file);
    snapshot.artist = song.artist ?? '';
    snapshot.album = song.album ?? '';
  }
  if (status.volume !== null) {
    snapshot.volume = status.volume;
  }
  return snapshot;
}

/** The feature external ids publishNowPlaying cannot guess (`${device}:${type}`). */
export const nowPlayingIds = (gladys, slot) => ({
  playback_state: deviceIds(gladys, slot).feature(FEATURE_KEYS.PLAYBACK_STATE),
});

/** The feature key of a feature external id of the slot, null when unknown. */
export function featureKeyOf(gladys, slot, externalId) {
  const ids = deviceIds(gladys, slot);
  return Object.values(FEATURE_KEYS).find((key) => ids.feature(key) === externalId) ?? null;
}
