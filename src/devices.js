// -----------------------------------------------------------------------------
// One Gladys device per MPD player, with the music features of the core so
// that Gladys shows it as a player (the "Music" dashboard box, the "Talk on a
// speaker" scene action):
//   - play, pause, previous, next: music/play… commands (has_feedback false:
//     Gladys keeps the last command it sent, the playback state says the truth);
//   - volume: music/volume 0-100, has_feedback true (MPD's mixer answers);
//   - playback state: music/playback_state, 1 playing, 0 paused or stopped
//     (MUSIC_PLAYBACK_STATE of the core);
//   - notification: music/play_notification, receives an address (a URL or a
//     path of the music library) to play, then what played comes back;
//   - playlist: text/select whose options are the stored playlists of MPD,
//     upserted at each publication (Gladys syncs `supported_options` of an
//     added device without asking): picking one plays it, in the dashboard
//     or from the "Control a device" scene action.
//
// The title, artist and album are shown by the widget: the music box of
// Gladys has no place for them.
//
// Identity: the configuration slot (1 to 4), see src/config.js.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_POLL_FREQUENCIES,
} from '@gladysassistant/integration-sdk';
import { SLOTS, formatAddress } from './config.js';
import { STATES } from './mpd/model.js';

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
    [FEATURE_KEYS.PLAYLIST]: 'Lista de reproducción',
    [FEATURE_KEYS.NOTIFICATION]: 'Notificación',
  },
};

const MUSIC = DEVICE_FEATURE_CATEGORIES.MUSIC;
const TYPES = DEVICE_FEATURE_TYPES.MUSIC;

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
  {
    key: FEATURE_KEYS.VOLUME,
    definition: {
      category: MUSIC,
      type: TYPES.VOLUME,
      read_only: false,
      has_feedback: true,
      keep_history: false,
      min: 0,
      max: 100,
    },
    // No mixer: MPD cannot tell (nor change) the volume.
    value: (status) => status.volume,
  },
  {
    key: FEATURE_KEYS.PLAYBACK_STATE,
    definition: {
      category: MUSIC,
      type: TYPES.PLAYBACK_STATE,
      read_only: true,
      has_feedback: false,
      keep_history: true,
      min: 0,
      max: 1,
    },
    // MUSIC_PLAYBACK_STATE of the core: PLAYING 1, PAUSED 0 (stopped too).
    value: (status) => (status.state === STATES.PLAY ? 1 : 0),
  },
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

/**
 * The states to publish for a player status (features without a value left out).
 * @returns {Array<{ device_feature_external_id: string, state: number }>}
 */
export function featureStates(gladys, slot, status) {
  if (!status) {
    return [];
  }
  const ids = deviceIds(gladys, slot);
  return FEATURES.filter(({ value }) => typeof value === 'function')
    .map(({ key, value }) => ({
      device_feature_external_id: ids.feature(key),
      state: value(status),
    }))
    .filter(({ state }) => typeof state === 'number' && Number.isFinite(state));
}

/** The feature key of a feature external id of the slot, null when unknown. */
export function featureKeyOf(gladys, slot, externalId) {
  const ids = deviceIds(gladys, slot);
  return Object.values(FEATURE_KEYS).find((key) => ids.feature(key) === externalId) ?? null;
}
