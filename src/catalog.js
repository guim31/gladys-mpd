// -----------------------------------------------------------------------------
// The catalog of the Gladys 5.3 music panel (manifest `music`): browse,
// search, play, the queue, and the bytes of the artworks. Read on demand
// from MPD, on the side connection of the player (src/player.js), never
// stored. Everything comes back as MediaItems whose `id` is opaque to Gladys
// and carried back by a play command and by the `music.play-media` scene
// action, so it names what MPD knows for good:
//   - `song:<uri>`        a song of the library or a stream address;
//   - `dir:<path>`        a folder of the music directory;
//   - `playlist:<name>`   a stored playlist;
//   - `artist:<name>`     every song of an artist (Artist tag);
//   - `album:<json>`      ["albumartist" or "artist", name, album];
//   - `gladys:<root>`     our entry points (folders, artists, albums,
//                          playlists), browsable only.
//
// What MPD gives (checked on 0.24 with a real server, see CLAUDE.md):
//   - `lsinfo` answers a whole folder at once, `list` a whole tag: the page is
//     cut here, `total` is the size of the level;
//   - `list album group albumartist` falls back on Artist when AlbumArtist is
//     missing, and `find albumartist` does the same;
//   - `albumart` takes a song or a folder path ending with `/`; `readpicture`
//     answers OK without any chunk when a song has no picture;
//   - images come at the size of the file (a scan of a few megabytes is
//     common): made smaller here (artwork-resize.js).
// -----------------------------------------------------------------------------

import { MUSIC_MEDIA_TYPES, MUSIC_PLAY_MODES } from '@gladysassistant/integration-sdk';
import { MAX_ARTWORK_DOWNLOAD, prepareArtwork } from './artwork-resize.js';
import { formatAddress } from './config.js';
import {
  baseName,
  isStream,
  parseAlbums,
  parseEntries,
  parsePlaylists,
  parseTagList,
} from './mpd/model.js';
import { ERROR_KINDS, MpdError } from './mpd/protocol.js';
import { MAX_ARTWORK_BYTES, MAX_QUEUED_SONGS } from './player.js';
import { ACTION_TEXT, CATALOG_TEXT, UserError, pick, safeText } from './texts.js';

export const ROOTS = Object.freeze({
  FOLDERS: 'gladys:folders',
  ARTISTS: 'gladys:artists',
  ALBUMS: 'gladys:albums',
  PLAYLISTS: 'gladys:playlists',
});

// Bounds of the core (capabilities/music.md, section 4.2).
const MAX_ID = 512;
const MAX_TEXT = 200;

// Resized artworks kept in memory, by image (size and first bytes): the 12
// songs of an album with the same embedded picture are resized once.
const PREPARED_KEPT = 30;

if (MAX_ARTWORK_BYTES > MAX_ARTWORK_DOWNLOAD) {
  throw new Error('MAX_ARTWORK_BYTES above what artwork-resize.js reads');
}

const clip = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, MAX_TEXT) : null;

const fold = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/** A row that is shown but does nothing: a page never loses a row (offsets). */
const neutral = (title) => ({
  id: `none:${title}`.slice(0, MAX_ID),
  type: MUSIC_MEDIA_TYPES.TRACK,
  title: clip(title) ?? '?',
  browsable: false,
  playable: false,
});

const folderItem = (id, title) => ({
  id,
  type: MUSIC_MEDIA_TYPES.FOLDER,
  title,
  browsable: true,
  playable: false,
});

/**
 * The parts of a MediaItem id, null when it is not one of ours.
 * @param {unknown} id
 * @returns {{ kind: string, value: any }|null}
 */
export function parseId(id) {
  if (typeof id !== 'string') {
    return null;
  }
  const at = id.indexOf(':');
  if (at <= 0) {
    return null;
  }
  const kind = id.slice(0, at);
  const value = id.slice(at + 1);
  if (kind === 'album') {
    try {
      const [tag, name, album] = JSON.parse(value);
      if (['albumartist', 'artist'].includes(tag) && typeof name === 'string' && album) {
        return { kind, value: { tag, name, album: String(album) } };
      }
    } catch {
      // not ours
    }
    return null;
  }
  if (['song', 'dir', 'playlist', 'artist', 'gladys'].includes(kind) && value !== '') {
    return { kind, value };
  }
  return null;
}

export const albumId = (tag, name, album) => `album:${JSON.stringify([tag, name, album])}`;

/**
 * The artwork key of a catalog reference (`{ song }`, `{ dir }`, `{ album }`),
 * looked up only when Gladys asks for the bytes.
 */
function artworkKeyOf(hub, record, ref) {
  return hub.gladys.artworkKey(hub.artworkUrl(record, ref));
}

/**
 * A MediaItem from a song (a `file` entry of MPD).
 * @param {object} hub
 * @param {object} record
 * @param {object} song parseSong()
 * @param {{ queueId?: number|null }} [options] queue rows: never a neutral
 *   row, an id from the queue id when the path is too long (played by index)
 */
export function songItem(hub, record, song, { queueId = null } = {}) {
  const stream = isStream(song.file);
  let id = `song:${song.file}`;
  if (id.length > MAX_ID) {
    if (queueId === null) {
      return neutral(song.title ?? baseName(song.file));
    }
    id = `queue:${queueId}`;
  }
  const item = {
    id,
    type: stream ? MUSIC_MEDIA_TYPES.RADIO : MUSIC_MEDIA_TYPES.TRACK,
    title: clip(song.title) ?? clip(song.name) ?? clip(baseName(song.file)) ?? '?',
    duration: song.duration === null || stream ? null : Math.round(song.duration),
    browsable: false,
    playable: true,
  };
  const subtitle = clip(song.artist) ?? (stream ? clip(song.name) : null);
  if (subtitle && subtitle !== item.title) {
    item.subtitle = subtitle;
  }
  if (!stream) {
    item.artwork_key = artworkKeyOf(hub, record, { song: song.file });
  }
  return item;
}

/** A MediaItem from an `lsinfo` entry. */
function entryItem(hub, record, entry) {
  if (entry.kind === 'file') {
    return songItem(hub, record, entry.song);
  }
  const name = baseName(entry.path) || entry.path;
  if (entry.kind === 'directory') {
    const id = `dir:${entry.path}`;
    if (id.length > MAX_ID) {
      return neutral(name);
    }
    return {
      id,
      type: MUSIC_MEDIA_TYPES.FOLDER,
      title: clip(name) ?? '?',
      // MPD queues a folder whole (its songs, MAX_QUEUED_SONGS at most).
      browsable: true,
      playable: true,
      artwork_key: artworkKeyOf(hub, record, { dir: entry.path }),
    };
  }
  return playlistItem(entry.path);
}

function playlistItem(name) {
  const id = `playlist:${name}`;
  if (id.length > MAX_ID) {
    return neutral(name);
  }
  return {
    id,
    type: MUSIC_MEDIA_TYPES.PLAYLIST,
    title: clip(baseName(name)) ?? clip(name) ?? '?',
    browsable: true,
    playable: true,
  };
}

function artistItem(name) {
  const id = `artist:${name}`;
  if (id.length > MAX_ID) {
    return neutral(name);
  }
  return {
    id,
    type: MUSIC_MEDIA_TYPES.ARTIST,
    title: clip(name) ?? '?',
    browsable: true,
    playable: true,
  };
}

function albumItem(hub, record, { tag, name, album }) {
  const id = albumId(tag, name, album);
  if (id.length > MAX_ID) {
    return neutral(album);
  }
  const item = {
    id,
    type: MUSIC_MEDIA_TYPES.ALBUM,
    title: clip(album) ?? '?',
    browsable: true,
    playable: true,
    artwork_key: artworkKeyOf(hub, record, { album: [tag, name, album] }),
  };
  if (clip(name)) {
    item.subtitle = clip(name);
  }
  return item;
}

/** The record of a device of a music command (a removed player: an error the panel shows). */
const recordOf = (hub, device) => hub.recordOf(device?.external_id);

/** The `find` arguments of an album. */
function albumFilter({ tag, name, album }) {
  return name ? [tag, name, 'album', album] : ['album', album];
}

/**
 * The songs of an item, at most MAX_QUEUED_SONGS (what a play queues).
 * @returns {Promise<string[]>} URIs
 */
async function songsOf(player, parsed) {
  const window = ['window', `0:${MAX_QUEUED_SONGS}`];
  const files = (lines) =>
    parseEntries(lines)
      .filter((entry) => entry.kind === 'file')
      .map((entry) => entry.path)
      .slice(0, MAX_QUEUED_SONGS);
  switch (parsed.kind) {
    case 'song':
      return [parsed.value];
    case 'dir':
      return files(await player.query('find', ['base', parsed.value, ...window]));
    case 'artist':
      return files(await player.query('find', ['artist', parsed.value, ...window]));
    case 'album':
      return files(await player.query('find', [...albumFilter(parsed.value), ...window]));
    case 'playlist':
      return files(await player.query('listplaylist', [parsed.value]));
    default:
      return [];
  }
}

/** A page of a whole level, and its size. */
const page = (items, offset, limit) => ({
  items: items.slice(offset, offset + limit),
  total: items.length,
});

/**
 * onMusicBrowse: our entry points, then any level.
 * @returns {Promise<{ items: object[], total: number }>}
 */
export async function browse(hub, device, { parentId = null, offset = 0, limit = 50 } = {}) {
  const record = recordOf(hub, device);
  const { language } = hub;
  if (parentId === null) {
    return page(
      [
        folderItem(ROOTS.FOLDERS, pick(CATALOG_TEXT.folders, language)),
        folderItem(ROOTS.ARTISTS, pick(CATALOG_TEXT.artists, language)),
        folderItem(ROOTS.ALBUMS, pick(CATALOG_TEXT.albums, language)),
        folderItem(ROOTS.PLAYLISTS, pick(CATALOG_TEXT.playlists, language)),
      ],
      offset,
      limit,
    );
  }
  const parsed = parseId(parentId);
  if (!parsed) {
    throw new Error(`Unknown catalog item ${safeText(parentId).slice(0, 100)}`);
  }
  return hub.command(
    record,
    `browse ${safeText(parentId).slice(0, 200)}`,
    async (player) => {
      let items;
      if (parentId === ROOTS.FOLDERS || parsed.kind === 'dir') {
        const path = parsed.kind === 'dir' ? parsed.value : '';
        items = parseEntries(await player.query('lsinfo', [path]))
          // The root lists the stored playlists too: they have their folder.
          .filter((entry) => path !== '' || entry.kind !== 'playlist')
          .map((entry) => entryItem(hub, record, entry));
      } else if (parentId === ROOTS.ARTISTS) {
        items = parseTagList(await player.query('list', ['artist']), 'Artist').map(artistItem);
      } else if (parentId === ROOTS.ALBUMS) {
        items = parseAlbums(await player.query('list', ['album', 'group', 'albumartist'])).map(
          ({ album, artist }) =>
            albumItem(hub, record, { tag: 'albumartist', name: artist, album }),
        );
      } else if (parentId === ROOTS.PLAYLISTS) {
        items = parsePlaylists(await player.query('listplaylists')).map(playlistItem);
      } else if (parsed.kind === 'artist') {
        items = parseTagList(
          await player.query('list', ['album', 'artist', parsed.value]),
          'Album',
        ).map((album) => albumItem(hub, record, { tag: 'artist', name: parsed.value, album }));
        if (items.length === 0) {
          // Songs without an album: the songs themselves.
          items = await songItems(hub, record, player, ['artist', parsed.value]);
        }
      } else if (parsed.kind === 'album') {
        items = await songItems(hub, record, player, albumFilter(parsed.value));
      } else if (parsed.kind === 'playlist') {
        items = parseEntries(await player.query('listplaylistinfo', [parsed.value]))
          .filter((entry) => entry.kind === 'file')
          .map((entry) => songItem(hub, record, entry.song));
      } else {
        throw new UserError(ACTION_TEXT.notPlayable, hub.language);
      }
      return page(items, offset, limit);
    },
    { quiet: true },
  );
}

/** The songs of a `find`, in library order, as MediaItems. */
async function songItems(hub, record, player, filter) {
  return parseEntries(await player.query('find', [...filter, 'window', `0:${MAX_QUEUED_SONGS}`]))
    .filter((entry) => entry.kind === 'file')
    .map((entry) => songItem(hub, record, entry.song));
}

/**
 * Search results of every type in one list of `limit`: the playlists, the
 * artists and the albums first (a quarter of the list each at most), the
 * songs after, then what is left of the others.
 * @param {Record<string, object[]>} groups by MediaItem type
 * @param {number} limit
 */
export function mixResults(groups, limit) {
  const share = Math.max(1, Math.floor(limit / 4));
  const heads = ['playlist', 'artist', 'album'];
  const first = heads.flatMap((type) => (groups[type] ?? []).slice(0, share));
  const rest = heads.flatMap((type) => (groups[type] ?? []).slice(share));
  return [...first, ...(groups.track ?? []), ...rest].slice(0, limit);
}

/**
 * onMusicSearch: songs through MPD's `search` (any tag, case and accents
 * aside), artists, albums and playlists by name (MPD lists them, the match
 * is made here).
 * @returns {Promise<{ items: object[] }>}
 */
export async function search(hub, device, { query, type = null, limit = 20 } = {}) {
  const record = recordOf(hub, device);
  const text = String(query ?? '').trim();
  if (!text || type === MUSIC_MEDIA_TYPES.FOLDER || type === MUSIC_MEDIA_TYPES.RADIO) {
    return { items: [] };
  }
  const wanted = (kind) => type === null || type === kind;
  const matches = (value) => fold(value).includes(fold(text));
  return hub.command(
    record,
    `search "${safeText(text).slice(0, 100)}"`,
    async (player) => {
      const groups = { playlist: [], artist: [], album: [], track: [] };
      if (wanted(MUSIC_MEDIA_TYPES.PLAYLIST)) {
        groups.playlist = parsePlaylists(await player.query('listplaylists'))
          .filter(matches)
          .map(playlistItem);
      }
      if (wanted(MUSIC_MEDIA_TYPES.ARTIST)) {
        groups.artist = parseTagList(await player.query('list', ['artist']), 'Artist')
          .filter(matches)
          .slice(0, limit)
          .map(artistItem);
      }
      if (wanted(MUSIC_MEDIA_TYPES.ALBUM)) {
        groups.album = parseAlbums(await player.query('list', ['album', 'group', 'albumartist']))
          .filter(({ album, artist }) => matches(album) || matches(artist))
          .slice(0, limit)
          .map(({ album, artist }) =>
            albumItem(hub, record, { tag: 'albumartist', name: artist, album }),
          );
      }
      if (wanted(MUSIC_MEDIA_TYPES.TRACK)) {
        groups.track = parseEntries(
          await player.query('search', ['any', text, 'window', `0:${limit}`]),
        )
          .filter((entry) => entry.kind === 'file')
          .map((entry) => songItem(hub, record, entry.song))
          .filter((item) => item.playable);
      }
      const items =
        type === null ? mixResults(groups, limit) : Object.values(groups).flat().slice(0, limit);
      return { items: items.filter((item) => item.playable || item.browsable) };
    },
    { quiet: true },
  );
}

/** onMusicPlay (and the `music.play-media` scene action). */
export async function play(hub, device, media, mode = MUSIC_PLAY_MODES.REPLACE) {
  const record = recordOf(hub, device);
  const parsed = parseId(media?.id);
  if (parsed?.kind === 'gladys') {
    throw new UserError(ACTION_TEXT.folderNotPlayable, hub.language);
  }
  if (!parsed) {
    throw new Error(`Unknown media ${safeText(media?.id).slice(0, 100)}`);
  }
  if (!Object.values(MUSIC_PLAY_MODES).includes(mode)) {
    throw new Error(`Unknown play mode ${mode}`);
  }
  await hub.command(
    record,
    `play ${media.type} ${safeText(media.id).slice(0, 200)} (${mode})`,
    async (player) => {
      let uris;
      try {
        uris = await songsOf(player, parsed);
      } catch (err) {
        // A playlist removed since a scene saved it.
        if (err instanceof MpdError && err.kind === ERROR_KINDS.COMMAND && err.code === 50) {
          uris = [];
        } else {
          throw err;
        }
      }
      const queued = uris.length ? await player.queueSongs(uris, mode) : 0;
      if (queued === 0) {
        throw new UserError(ACTION_TEXT.notPlayable, hub.language);
      }
    },
  );
}

/**
 * onMusicQueueGet: a page of MPD's queue (its order, which random play does
 * not change: `current_index` is the position of the current song in it).
 * @returns {Promise<{ items: object[], currentIndex: number|null, total: number }>}
 */
export async function queueGet(hub, device, { offset = 0, limit = 50 } = {}) {
  const record = recordOf(hub, device);
  return hub.command(
    record,
    `queue ${offset}+${limit}`,
    async (player) => {
      await player.refresh();
      const { queueLength, song } = player.status;
      // MPD answers "Bad song index" past the end.
      const lines =
        offset < queueLength
          ? await player.query('playlistinfo', [`${offset}:${offset + limit}`])
          : [];
      // A song queued twice is two rows; no row is ever dropped (the page
      // must stay aligned with the positions of the queue).
      const items = parseEntries(lines)
        .filter((entry) => entry.kind === 'file')
        .map((entry) => songItem(hub, record, entry.song, { queueId: entry.song.id ?? 0 }));
      return { items, currentIndex: song ?? null, total: queueLength };
    },
    { quiet: true },
  );
}

/** onMusicQueuePlay: jump to an item of the queue. */
export async function queuePlay(hub, device, index) {
  const record = recordOf(hub, device);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid queue index ${index}`);
  }
  await hub.command(record, `play queue item ${index}`, async (player) => {
    if (!(await player.playIndex(index))) {
      throw new UserError(ACTION_TEXT.notInQueue, hub.language);
    }
  });
}

/**
 * The song or folder whose artwork stands for a reference: a song itself,
 * the cover file of a folder (else its first song), the first song of an
 * album.
 * @returns {Promise<Array<{ command: string, uri: string }>>} sources to try
 */
async function artworkSources(player, ref) {
  if (ref.command) {
    return [ref]; // looked up already (now playing)
  }
  if (ref.song) {
    const { source } = await player.lookupArtwork(ref.song);
    return source ? [source] : [];
  }
  const first = async (filter) => {
    const [entry] = parseEntries(await player.query('find', [...filter, 'window', '0:1'])).filter(
      (item) => item.kind === 'file',
    );
    return entry ? (await player.lookupArtwork(entry.path)).source : null;
  };
  if (ref.dir) {
    const fromSong = await first(['base', ref.dir]);
    return [{ command: 'albumart', uri: `${ref.dir}/` }, ...(fromSong ? [fromSong] : [])];
  }
  if (Array.isArray(ref.album)) {
    const [tag, name, album] = ref.album;
    const source = await first(albumFilter({ tag, name, album }));
    return source ? [source] : [];
  }
  return [];
}

/**
 * onMusicGetArtwork: the bytes of an artwork whose source artworkKey
 * recorded (src/hub.js artworkUrl). MPD serves the picture as it is in the
 * file, often a few megabytes: read up to 10 MB, then made a JPEG of 400 px
 * at most when it is above the 300 KB the core accepts. A resized copy is
 * kept for the songs that share the image.
 * @param {object} hub
 * @param {string} key
 * @returns {Promise<string>} raw base64
 */
export async function artwork(hub, key) {
  let slot;
  let address;
  let ref;
  try {
    [, slot, address, ref] = JSON.parse(hub.gladys.artworkUrls.get(key));
  } catch {
    throw new Error(`Unknown artwork ${key}`);
  }
  const record = hub.records.get(slot);
  if (!record || formatAddress(record.server) !== address || !ref) {
    throw new Error(`Artwork ${key}: the player is no longer in the configuration`);
  }
  const { player } = record;
  try {
    for (const source of await artworkSources(player, ref)) {
      let image;
      try {
        image = await player.readArtwork(source, (id) => hub.preparedArtworks.has(id));
      } catch (err) {
        if (err.kind === ERROR_KINDS.COMMAND) {
          continue; // none there: the next source
        }
        throw err;
      }
      const cached = hub.preparedArtworks.get(image.id);
      if (cached) {
        // Most recent last: the oldest copy goes first.
        hub.preparedArtworks.delete(image.id);
        hub.preparedArtworks.set(image.id, cached);
        return cached;
      }
      const base64 = (await prepareArtwork(image.data)).toString('base64');
      hub.preparedArtworks.set(image.id, base64);
      if (hub.preparedArtworks.size > PREPARED_KEPT) {
        hub.preparedArtworks.delete(hub.preparedArtworks.keys().next().value);
      }
      return base64;
    }
  } catch (err) {
    throw new Error(`Artwork ${key}: ${err.message}`, { cause: err });
  }
  throw new Error(`Artwork ${key}: none in MPD`);
}
