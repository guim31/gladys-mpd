// -----------------------------------------------------------------------------
// Reading the answers of `status`, `currentsong` and `listplaylists` into the
// plain objects the rest of the integration uses.
//
// Differences between servers and versions, as documented by MPD:
//   - `volume` is absent (MPD ≥ 0.23 without mixer) or `-1` (older ones);
//   - `single` is `0`, `1` or `oneshot` (MPD ≥ 0.21);
//   - `duration` and `elapsed` are decimal (MPD ≥ 0.20); `time` is the older
//     `elapsed:total` in whole seconds;
//   - a web radio has a `Name` (the station) and often a `Title` holding
//     "Artist - Song", no `Artist`, no `duration`;
//   - a tag may repeat (two `Artist` lines).
// -----------------------------------------------------------------------------

import { parseObject, parsePairs } from './protocol.js';

/** Playback states of MPD. */
export const STATES = Object.freeze({ PLAY: 'play', PAUSE: 'pause', STOP: 'stop' });

const toInt = (value) => {
  const number = Number.parseInt(first(value), 10);
  return Number.isFinite(number) ? number : null;
};

const toFloat = (value) => {
  const number = Number.parseFloat(first(value));
  return Number.isFinite(number) ? number : null;
};

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

/** A tag that may repeat, as one text ("A, B"), null when absent or blank. */
function tag(value) {
  if (value === undefined) {
    return null;
  }
  const text = [].concat(value).join(', ').trim();
  return text || null;
}

/**
 * @param {string[]} lines answer of `status`
 */
export function parseStatus(lines) {
  const raw = parseObject(lines);
  const volume = toInt(raw.volume);
  const state = Object.values(STATES).includes(first(raw.state)) ? first(raw.state) : STATES.STOP;
  let elapsed = toFloat(raw.elapsed);
  let duration = toFloat(raw.duration);
  if (typeof raw.time === 'string' && raw.time.includes(':')) {
    const [seconds, total] = raw.time.split(':').map(Number);
    elapsed ??= Number.isFinite(seconds) ? seconds : null;
    // `time` says 0 for a stream: that is "unknown", not "zero seconds".
    duration ??= Number.isFinite(total) && total > 0 ? total : null;
  }
  return {
    state,
    // No mixer: MPD cannot change the volume, the feature gets no value.
    volume: volume === null || volume < 0 ? null : Math.min(volume, 100),
    random: first(raw.random) === '1',
    repeat: first(raw.repeat) === '1',
    single: ['1', 'oneshot'].includes(first(raw.single)) ? first(raw.single) : '0',
    consume: ['1', 'oneshot'].includes(first(raw.consume)) ? first(raw.consume) : '0',
    song: toInt(raw.song),
    songId: toInt(raw.songid),
    queueLength: toInt(raw.playlistlength) ?? 0,
    elapsed,
    duration,
    error: tag(raw.error),
  };
}

/**
 * @param {string[]} lines answer of `currentsong` (empty when nothing is queued)
 */
export function parseSong(lines) {
  const raw = parseObject(lines);
  if (raw.file === undefined) {
    return null;
  }
  return {
    file: first(raw.file),
    title: tag(raw.Title),
    artist: tag(raw.Artist) ?? tag(raw.AlbumArtist),
    album: tag(raw.Album),
    // The station of a web radio.
    name: tag(raw.Name),
    id: toInt(raw.Id),
    position: toInt(raw.Pos),
    duration: toFloat(raw.duration) ?? toFloat(raw.Time),
  };
}

/**
 * The entries of a listing: songs (`file`), and for `lsinfo` also
 * directories and playlists, in the order MPD gives them.
 * @param {string[]} lines answer of `playlistinfo`, `find`, `search`,
 *   `lsinfo`, `listplaylistinfo`, `listplaylist`
 * @returns {Array<{ kind: 'file'|'directory'|'playlist', path: string, song?: object }>}
 */
export function parseEntries(lines) {
  const entries = [];
  let current = null;
  const close = () => {
    if (current?.kind === 'file') {
      current.song = parseSong(current.lines);
    }
    delete current?.lines;
  };
  for (const [key, value] of parsePairs(lines)) {
    if (key === 'file' || key === 'directory' || key === 'playlist') {
      close();
      current = { kind: key, path: value, lines: [`${key}: ${value}`] };
      entries.push(current);
    } else if (current) {
      current.lines.push(`${key}: ${value}`);
    }
  }
  close();
  return entries;
}

/**
 * The values of one tag (`list artist`), blanks left out, sorted by name.
 * @param {string[]} lines
 * @param {string} key the tag as MPD writes it (`Artist`)
 */
export function parseTagList(lines, key) {
  const seen = new Set();
  for (const [name, value] of parsePairs(lines)) {
    if (name === key && value.trim() !== '') {
      seen.add(value);
    }
  }
  return [...seen].sort(byName);
}

/**
 * The albums of `list album group albumartist`: each `AlbumArtist` line
 * comes before the albums it groups. Albums without a name left out.
 * @param {string[]} lines
 * @returns {Array<{ album: string, artist: string }>} artist '' when unknown
 */
export function parseAlbums(lines) {
  const albums = [];
  let artist = '';
  for (const [key, value] of parsePairs(lines)) {
    if (key === 'AlbumArtist') {
      artist = value;
    } else if (key === 'Album' && value.trim() !== '') {
      albums.push({ album: value, artist });
    }
  }
  return albums.sort((a, b) => byName(a.album, b.album) || byName(a.artist, b.artist));
}

/** Names in the order a user expects (case and accents aside, numbers as numbers). */
export const byName = (a, b) =>
  a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

/**
 * The stored playlists, sorted by name (the order MPD gives is its storage
 * order, meaningless to the user).
 * @param {string[]} lines answer of `listplaylists`
 * @returns {string[]}
 */
export function parsePlaylists(lines) {
  return parsePairs(lines)
    .filter(([key, name]) => key === 'playlist' && name.trim() !== '')
    .map(([, name]) => name)
    .sort(byName);
}

/** The last part of a path or URL: what is shown for a song without tags. */
export function baseName(file) {
  if (typeof file !== 'string') {
    return '';
  }
  const withoutQuery = file.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const name = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * What is playing, as two lines: the title and what goes with it (artist
 * and album, or the radio station).
 * @param {object|null} song parseSong()
 * @returns {{ title: string|null, subtitle: string|null }}
 */
export function describeSong(song) {
  if (!song) {
    return { title: null, subtitle: null };
  }
  const title = song.title ?? song.name ?? baseName(song.file);
  const parts = [];
  if (song.artist) {
    parts.push(song.artist);
  }
  if (song.album) {
    parts.push(song.album);
  }
  if (parts.length === 0 && song.name && song.name !== title) {
    parts.push(song.name);
  }
  return { title: title || null, subtitle: parts.length ? parts.join(' · ') : null };
}

/** Is this a stream (web radio), whose end never comes? */
export const isStream = (file) => typeof file === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(file);
