// -----------------------------------------------------------------------------
// A fake MPD server on a real TCP socket (127.0.0.1, random port), speaking
// the MPD protocol the way MPD 0.23 does (see the transcripts recorded in
// test/fixtures/mpd/): greeting, password, command lists, idle and noidle
// (events kept per client until its next idle), ACK errors. Playback is
// simulated by hand: a test advances the song (`play(seconds)`), ends it
// (`finishSong()`), or makes an address fail.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import net from 'node:net';
import jpeg from 'jpeg-js';

// A cover of a few kilobytes, and one of about 1.5 MB (noise): above the
// 300 KB Gladys accepts, made smaller by the integration.
export const SMALL_JPEG = readFileSync(
  new URL('../fixtures/artwork/baseline-420.jpg', import.meta.url),
);
export const HUGE_JPEG = (() => {
  const width = 800;
  const height = 600;
  const data = Buffer.alloc(width * height * 4, 255);
  let seed = 7;
  for (let i = 0; i < data.length; i++) {
    if (i % 4 !== 3) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = 128 + (seed % 101) - 50;
    }
  }
  return jpeg.encode({ data, width, height }, 100).data;
})();

// Cover files of folders (`albumart`), by folder path with its slash.
export const COVERS = { 'Daft Punk/Discovery/': SMALL_JPEG };

export const LIBRARY = {
  'Daft Punk/Discovery/01 One More Time.flac': {
    Artist: 'Daft Punk',
    Album: 'Discovery',
    Title: 'One More Time',
    Track: '1',
    duration: 320.357,
  },
  'Daft Punk/Discovery/02 Aerodynamic.flac': {
    Artist: 'Daft Punk',
    Album: 'Discovery',
    Title: 'Aerodynamic',
    Track: '2',
    duration: 212.04,
  },
  'Air/Moon Safari/01 La femme d’argent.flac': {
    Artist: 'Air',
    Album: 'Moon Safari',
    Title: 'La femme d’argent',
    Track: '1',
    duration: 429.4,
    // An embedded picture (`readpicture`).
    picture: HUGE_JPEG,
  },
  'Untagged/track07.mp3': { duration: 180 },
  'sounds/doorbell.mp3': { Title: 'Doorbell', duration: 2.5 },
};

export const RADIO = 'http://icecast.example.com/radio.mp3';

/** Split a command line into words, honoring double quotes and backslashes. */
export function splitArgs(line) {
  const words = [];
  let at = 0;
  while (at < line.length) {
    while (line[at] === ' ' || line[at] === '\t') {
      at += 1;
    }
    if (at >= line.length) {
      break;
    }
    let word = '';
    if (line[at] === '"') {
      at += 1;
      while (at < line.length && line[at] !== '"') {
        if (line[at] === '\\' && at + 1 < line.length) {
          at += 1;
        }
        word += line[at];
        at += 1;
      }
      at += 1;
    } else {
      while (at < line.length && line[at] !== ' ' && line[at] !== '\t') {
        word += line[at];
        at += 1;
      }
    }
    words.push(word);
  }
  return words;
}

class Ack extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const SUBSYSTEMS = [
  'database',
  'stored_playlist',
  'playlist',
  'player',
  'mixer',
  'options',
  'output',
];

export class FakeMpd {
  /**
   * @param {object} [options]
   * @param {string} [options.password]
   * @param {string} [options.version]
   * @param {number|null} [options.volume] null: no mixer
   * @param {Record<string, string[]>} [options.playlists]
   * @param {Record<string, object>} [options.urls] address → { stream } | { duration } | { fail }
   */
  constructor({
    password = '',
    version = '0.23.5',
    volume = 40,
    playlists = {
      Apéro: [
        'Daft Punk/Discovery/01 One More Time.flac',
        'Air/Moon Safari/01 La femme d’argent.flac',
      ],
      'Morning jazz': ['Untagged/track07.mp3'],
    },
    urls = { [RADIO]: { stream: true, Name: 'Example Radio', Title: 'Some Artist - Some Song' } },
  } = {}) {
    this.password = password;
    this.version = version;
    this.volume = volume;
    this.playlists = structuredClone(playlists);
    this.urls = structuredClone(urls);
    this.queue = [];
    this.nextId = 1;
    this.current = -1;
    this.state = 'stop';
    this.elapsed = 0;
    this.random = false;
    this.repeat = false;
    this.single = '0';
    this.consume = '0';
    this.error = null;
    this.playlistVersion = 1;
    this.clients = new Set();
    /** Every command received, password values hidden: `[name, ...args]`. */
    this.log = [];
    this.silent = false;
    this.greeting = null;
    this.server = net.createServer((socket) => this.accept(socket));
  }

  async listen() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this.port;
  }

  async close() {
    this.dropClients();
    await new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Stop listening: new connections are refused (the player is off). */
  async goOffline() {
    this.dropClients();
    await new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Listen again on the same port (the player is back). */
  async goOnline() {
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise((resolve) => this.server.listen(this.port, '127.0.0.1', resolve));
  }

  /** Cut every open connection (Wi-Fi lost, MPD restarted). */
  dropClients() {
    for (const client of this.clients) {
      client.socket.destroy();
    }
    this.clients.clear();
  }

  /** Names of the commands received, in order. */
  commandNames() {
    return this.log.map(([name]) => name);
  }

  // --- Connection ----------------------------------------------------------

  accept(socket) {
    const client = {
      socket,
      buffer: '',
      authenticated: !this.password,
      idle: null,
      pending: new Set(),
      list: null,
      binarylimit: 8192,
    };
    this.clients.add(client);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.receive(client, chunk));
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', () => this.clients.delete(client));
    if (this.silent) {
      return;
    }
    socket.write(this.greeting ?? `OK MPD ${this.version}\n`);
  }

  receive(client, chunk) {
    if (this.silent) {
      return;
    }
    client.buffer += chunk;
    let at;
    while ((at = client.buffer.indexOf('\n')) !== -1) {
      const line = client.buffer.slice(0, at);
      client.buffer = client.buffer.slice(at + 1);
      this.line(client, line);
    }
  }

  write(client, text) {
    if (!client.socket.destroyed) {
      client.socket.write(text);
    }
  }

  line(client, line) {
    const [name = '', ...args] = splitArgs(line);
    if (client.list) {
      if (name === 'command_list_end') {
        this.runList(client);
      } else {
        client.list.commands.push([name, args]);
      }
      return;
    }
    if (client.idle) {
      if (name === 'noidle') {
        this.answerIdle(client, true);
      }
      // MPD drops a client sending anything else while idle.
      else {
        client.socket.destroy();
      }
      return;
    }
    if (name === 'noidle') {
      return; // not idle: ignored, no answer
    }
    if (name === 'command_list_ok_begin' || name === 'command_list_begin') {
      client.list = { ok: name === 'command_list_ok_begin', commands: [] };
      return;
    }
    if (name === 'idle') {
      this.log.push(['idle', ...args]);
      client.idle = args.length ? new Set(args) : new Set(SUBSYSTEMS);
      this.answerIdle(client, false);
      return;
    }
    if (name === 'close') {
      client.socket.end();
      return;
    }
    try {
      const out = this.run(client, name, args);
      if (Buffer.isBuffer(out)) {
        if (!client.socket.destroyed) {
          client.socket.write(Buffer.concat([out, Buffer.from('OK\n')]));
        }
        return;
      }
      this.write(client, `${out}OK\n`);
    } catch (err) {
      this.write(client, this.ack(err, 0, name));
    }
  }

  runList(client) {
    const { ok, commands } = client.list;
    client.list = null;
    let out = '';
    for (let index = 0; index < commands.length; index += 1) {
      const [name, args] = commands[index];
      try {
        out += this.run(client, name, args);
        if (ok) {
          out += 'list_OK\n';
        }
      } catch (err) {
        this.write(client, `${out}${this.ack(err, index, name)}`);
        return;
      }
    }
    this.write(client, `${out}OK\n`);
  }

  ack(err, index, name) {
    if (err instanceof Ack) {
      return `ACK [${err.code}@${index}] {${name}} ${err.message}\n`;
    }
    return `ACK [5@${index}] {${name}} ${err.message}\n`;
  }

  /** Answer an idle when events are pending (or when cut short by noidle). */
  answerIdle(client, now) {
    const changes = [...client.pending].filter((subsystem) => client.idle.has(subsystem));
    if (changes.length === 0 && !now) {
      return;
    }
    for (const change of changes) {
      client.pending.delete(change);
    }
    client.idle = null;
    this.write(client, `${changes.map((change) => `changed: ${change}\n`).join('')}OK\n`);
  }

  /** Something changed: every client hears it at its (next) idle. */
  emit(...subsystems) {
    for (const client of this.clients) {
      for (const subsystem of subsystems) {
        client.pending.add(subsystem);
      }
      if (client.idle) {
        this.answerIdle(client, false);
      }
    }
  }

  // --- Commands ------------------------------------------------------------------

  run(client, name, args) {
    this.log.push(name === 'password' ? ['password', '***'] : [name, ...args]);
    if (name === 'password') {
      if (args[0] !== this.password || !this.password) {
        throw new Ack(3, 'incorrect password');
      }
      client.authenticated = true;
      return '';
    }
    if (name === 'ping') {
      return '';
    }
    if (!client.authenticated) {
      throw new Ack(4, `you don't have permission for "${name}"`);
    }
    const handler = this.extraCommands?.[name] ?? this.commands[name];
    if (!handler || this.missing?.includes(name)) {
      throw new Ack(5, `unknown command "${name}"`);
    }
    this.client = client;
    return handler.call(this, ...args) ?? '';
  }

  get commands() {
    return {
      status: () => this.statusText(),
      currentsong: () =>
        this.current >= 0 ? this.songText(this.queue[this.current], this.current) : '',
      listplaylists: () =>
        Object.keys(this.playlists)
          .map((name) => `playlist: ${name}\nLast-Modified: 2026-09-30T18:12:44Z\n`)
          .join(''),
      play: (position) => {
        if (this.queue.length === 0) {
          return;
        }
        const index = position === undefined ? Math.max(this.current, 0) : Number(position);
        if (!this.queue[index]) {
          throw new Ack(2, 'Bad song index');
        }
        this.start(index);
      },
      playid: (id) => {
        const index = this.indexOf(id);
        this.start(index);
      },
      pause: (flag) => {
        if (this.state === 'stop') {
          return;
        }
        const pause = flag === undefined ? this.state === 'play' : flag === '1';
        this.state = pause ? 'pause' : 'play';
        this.emit('player');
      },
      stop: () => {
        this.state = 'stop';
        this.elapsed = 0;
        this.emit('player');
      },
      next: () => {
        if (this.state === 'stop') {
          return;
        }
        this.advance();
      },
      previous: () => {
        if (this.state === 'stop') {
          return;
        }
        if (this.current > 0) {
          this.start(this.current - 1);
        } else {
          this.start(0);
        }
      },
      setvol: (value) => {
        if (this.volume === null) {
          throw new Ack(52, 'problems setting volume');
        }
        const volume = Number(value);
        if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
          throw new Ack(2, `Integer expected: ${value}`);
        }
        this.volume = volume;
        this.emit('mixer');
      },
      random: (value) => {
        this.random = value === '1';
        this.emit('options');
      },
      repeat: (value) => {
        this.repeat = value === '1';
        this.emit('options');
      },
      single: (value) => {
        if (!['0', '1', 'oneshot'].includes(value)) {
          throw new Ack(2, `Unrecognized single mode: ${value}`);
        }
        this.single = value;
        this.emit('options');
      },
      consume: (value) => {
        this.consume = value;
        this.emit('options');
      },
      clear: () => {
        this.queue = [];
        this.current = -1;
        this.state = 'stop';
        this.elapsed = 0;
        this.queueChanged();
        this.emit('player');
      },
      load: (name) => {
        const files = this.playlists[name];
        if (!files) {
          throw new Ack(50, 'No such playlist');
        }
        for (const file of files) {
          this.append(file);
        }
        this.queueChanged();
      },
      add: (uri) => {
        this.append(uri);
        this.queueChanged();
      },
      addid: (uri, position) => {
        if (position !== undefined && Number(position) > this.queue.length) {
          throw new Ack(2, `Number too large: ${position}`);
        }
        const song = this.append(uri);
        if (position !== undefined) {
          this.queue.splice(this.queue.indexOf(song), 1);
          this.queue.splice(Number(position), 0, song);
          if (this.current >= Number(position)) {
            this.current += 1;
          }
        }
        this.queueChanged();
        return `Id: ${song.id}\n`;
      },
      delete: (range) => {
        const [start, end = String(Number(start) + 1)] = range.split(':');
        if (Number(start) >= this.queue.length) {
          throw new Ack(2, 'Bad song index');
        }
        const removed = this.queue.slice(Number(start), Number(end)).map((song) => song.id);
        for (const id of removed) {
          this.commands.deleteid(String(id));
        }
      },
      seekcur: (time) => {
        if (this.state === 'stop') {
          throw new Ack(55, 'Not playing');
        }
        this.elapsed = Number(time);
        this.emit('player');
      },
      playlistinfo: (range) => {
        const [start, end] = (range ?? `0:${this.queue.length}`).split(':').map(Number);
        if (start >= this.queue.length && range !== undefined) {
          throw new Ack(2, 'Bad song index');
        }
        return this.queue
          .slice(start, end)
          .map((song, index) => this.songText(song, start + index))
          .join('');
      },
      binarylimit: (size) => {
        this.client.binarylimit = Number(size);
      },
      readpicture: (uri, offset) => {
        const tags = LIBRARY[uri];
        if (!tags) {
          throw new Ack(50, 'No such song');
        }
        return tags.picture ? this.chunk(tags.picture, offset) : '';
      },
      albumart: (uri, offset) => {
        const folder = uri.endsWith('/') ? uri : uri.slice(0, uri.lastIndexOf('/') + 1);
        const cover = COVERS[folder];
        if (!cover) {
          throw new Ack(50, 'No file exists');
        }
        return this.chunk(cover, offset);
      },
      lsinfo: (path = '') => {
        const prefix = path ? `${path}/` : '';
        const dirs = new Set();
        const files = [];
        for (const file of Object.keys(LIBRARY)) {
          if (!file.startsWith(prefix)) {
            continue;
          }
          const rest = file.slice(prefix.length);
          if (rest.includes('/')) {
            dirs.add(prefix + rest.slice(0, rest.indexOf('/')));
          } else {
            files.push(file);
          }
        }
        if (path && dirs.size === 0 && files.length === 0) {
          throw new Ack(50, 'No such directory');
        }
        const playlists = path ? [] : Object.keys(this.playlists);
        return [
          ...[...dirs].map((dir) => `directory: ${dir}\n`),
          ...files.map((file) => this.libraryText(file)),
          ...playlists.map((name) => `playlist: ${name}\n`),
        ].join('');
      },
      list: (type, ...rest) => {
        const songs = Object.entries(LIBRARY);
        if (type === 'artist') {
          return [...new Set(songs.map(([, tags]) => tags.Artist ?? ''))]
            .map((artist) => `Artist: ${artist}\n`)
            .join('');
        }
        if (type === 'album' && rest[0] === 'group') {
          const pairs = new Set(
            songs.map(([, tags]) => `${tags.Artist ?? ''}\u0000${tags.Album ?? ''}`),
          );
          return [...pairs]
            .map((pair) => pair.split('\u0000'))
            .map(([artist, album]) => `AlbumArtist: ${artist}\nAlbum: ${album}\n`)
            .join('');
        }
        if (type === 'album' && rest[0] === 'artist') {
          return [
            ...new Set(
              songs
                .filter(([, tags]) => tags.Artist === rest[1])
                .map(([, tags]) => tags.Album ?? ''),
            ),
          ]
            .map((album) => `Album: ${album}\n`)
            .join('');
        }
        throw new Ack(2, 'unsupported list in the fake');
      },
      find: (...args) => this.lookup(args, (value, wanted) => value === wanted),
      search: (...args) =>
        this.lookup(args, (value, wanted) => value.toLowerCase().includes(wanted.toLowerCase())),
      listplaylist: (name) => {
        const files = this.playlists[name];
        if (!files) {
          throw new Ack(50, 'No such playlist');
        }
        return files.map((file) => `file: ${file}\n`).join('');
      },
      listplaylistinfo: (name) => {
        const files = this.playlists[name];
        if (!files) {
          throw new Ack(50, 'No such playlist');
        }
        return files.map((file) => this.libraryText(file)).join('');
      },
      deleteid: (id) => {
        const index = this.indexOf(id);
        this.queue.splice(index, 1);
        if (index === this.current) {
          if (this.state !== 'stop' && this.queue[index]) {
            this.start(index);
          } else {
            this.current = this.queue[index] ? index : -1;
            this.state = 'stop';
            this.elapsed = 0;
            this.emit('player');
          }
        } else if (index < this.current) {
          this.current -= 1;
        }
        this.queueChanged();
      },
      seekid: (id, time) => {
        const index = this.indexOf(id);
        if (this.queue[index].stream) {
          throw new Ack(52, 'Not seekable');
        }
        this.start(index);
        this.elapsed = Number(time);
      },
      save: (name) => {
        this.playlists[name] = this.queue.map((song) => song.file);
        this.emit('stored_playlist');
      },
      commands: () =>
        ['close', 'commands', 'idle', 'noidle', 'password', 'ping', ...Object.keys(this.commands)]
          .sort()
          .map((name) => `command: ${name}\n`)
          .join(''),
      rm: (name) => {
        delete this.playlists[name];
        this.emit('stored_playlist');
      },
    };
  }

  /** `find` / `search`: TAG VALUE pairs, then `window START:END`. */
  lookup(args, match) {
    let window = [0, Infinity];
    const filters = [];
    for (let at = 0; at < args.length; at += 2) {
      if (args[at] === 'window') {
        window = args[at + 1].split(':').map(Number);
      } else {
        filters.push([args[at], args[at + 1]]);
      }
    }
    const value = (file, tags, type) => {
      switch (type) {
        case 'base':
          return file;
        case 'any':
          return [file, tags.Title, tags.Artist, tags.Album].filter(Boolean).join(' ');
        case 'albumartist':
          return tags.AlbumArtist ?? tags.Artist ?? '';
        default:
          return tags[type[0].toUpperCase() + type.slice(1)] ?? '';
      }
    };
    return Object.entries(LIBRARY)
      .filter(([file, tags]) =>
        filters.every(([type, wanted]) =>
          type === 'base' ? file.startsWith(`${wanted}/`) : match(value(file, tags, type), wanted),
        ),
      )
      .slice(window[0], window[1])
      .map(([file]) => this.libraryText(file))
      .join('');
  }

  /** A binary answer: one chunk of `binarylimit` bytes at most from `offset`. */
  chunk(data, offset) {
    const start = Number(offset);
    const part = data.subarray(start, start + this.client.binarylimit);
    return Buffer.concat([
      Buffer.from(`size: ${data.length}\ntype: image/jpeg\nbinary: ${part.length}\n`),
      part,
      Buffer.from('\n'),
    ]);
  }

  /** A song of the library as `find` and `lsinfo` give it. */
  libraryText(file) {
    const song = { file, ...LIBRARY[file] };
    return this.songText(song, null);
  }

  indexOf(id) {
    const index = this.queue.findIndex((song) => song.id === Number(id));
    if (index === -1) {
      throw new Ack(50, 'No such song');
    }
    return index;
  }

  append(uri) {
    let song;
    if (/^[a-z]+:\/\//i.test(uri)) {
      if (/^file:/i.test(uri)) {
        throw new Ack(4, 'Access denied');
      }
      const info = this.urls[uri] ?? { stream: true };
      song = { file: uri, ...info };
    } else {
      const tags = LIBRARY[uri];
      if (!tags) {
        throw new Ack(50, 'No such directory');
      }
      song = { file: uri, ...tags };
    }
    song.id = this.nextId;
    this.nextId += 1;
    this.queue.push(song);
    return song;
  }

  queueChanged() {
    this.playlistVersion += 1;
    this.emit('playlist');
  }

  start(index) {
    this.current = index;
    this.elapsed = 0;
    this.state = 'play';
    this.error = null;
    this.emit('player');
    const song = this.queue[index];
    if (song.fail) {
      // MPD tries, then gives up: stopped, with the reason in `error`.
      setImmediate(() => {
        if (this.queue[this.current] === song && this.state === 'play') {
          this.state = 'stop';
          this.error = song.fail;
          this.emit('player');
        }
      });
    }
  }

  /** The current song ended (or `next`): what MPD does after it. */
  advance() {
    if (this.single !== '0' && this.state === 'play') {
      if (this.single === 'oneshot') {
        this.single = '0';
        this.emit('options');
      }
      if (!this.repeat) {
        this.state = 'stop';
        this.elapsed = 0;
        this.emit('player');
        return;
      }
    }
    const next = this.current + 1;
    if (next < this.queue.length) {
      this.start(next);
    } else if (this.repeat && this.queue.length) {
      this.start(0);
    } else {
      this.state = 'stop';
      this.elapsed = 0;
      this.emit('player');
    }
  }

  // --- Test controls ---------------------------------------------------------------

  /** Time goes by on the song playing (no event: MPD does not send one). */
  play(seconds) {
    if (this.state === 'play') {
      this.elapsed += seconds;
    }
  }

  /** The song playing reaches its end. */
  finishSong() {
    if (this.state !== 'play') {
      return;
    }
    if (this.consume !== '0') {
      this.queue.splice(this.current, 1);
      this.current -= 1;
      this.queueChanged();
    }
    this.advance();
  }

  /** Change the volume without any event (an idle lost on the way). */
  setVolumeSilently(volume) {
    this.volume = volume;
  }

  /** Fill the queue with library files. */
  enqueue(...files) {
    for (const file of files) {
      this.append(file);
    }
    this.queueChanged();
  }

  statusText() {
    const lines = [];
    if (this.volume !== null) {
      lines.push(`volume: ${this.volume}`);
    }
    lines.push(
      `repeat: ${this.repeat ? 1 : 0}`,
      `random: ${this.random ? 1 : 0}`,
      `single: ${this.single}`,
      `consume: ${this.consume}`,
      'partition: default',
      `playlist: ${this.playlistVersion}`,
      `playlistlength: ${this.queue.length}`,
      'mixrampdb: 0',
      `state: ${this.state}`,
    );
    if (this.current >= 0 && this.queue[this.current]) {
      const song = this.queue[this.current];
      lines.push(`song: ${this.current}`, `songid: ${song.id}`);
      if (this.state !== 'stop') {
        const total = song.duration ?? 0;
        lines.push(`time: ${Math.floor(this.elapsed)}:${Math.round(total)}`);
        lines.push(`elapsed: ${this.elapsed.toFixed(3)}`);
        lines.push('bitrate: 320');
        if (song.duration !== undefined) {
          lines.push(`duration: ${song.duration.toFixed(3)}`);
        }
        lines.push('audio: 44100:24:2');
      }
      const next = this.queue[this.current + 1];
      if (next) {
        lines.push(`nextsong: ${this.current + 1}`, `nextsongid: ${next.id}`);
      }
    }
    if (this.error) {
      lines.push(`error: ${this.error}`);
    }
    return `${lines.join('\n')}\n`;
  }

  songText(song, position) {
    const lines = [`file: ${song.file}`];
    if (!song.stream) {
      lines.push('Last-Modified: 2024-03-02T10:15:02Z', 'Format: 44100:16:2');
    }
    for (const key of ['Artist', 'Album', 'Title', 'Track', 'Name']) {
      if (song[key] !== undefined) {
        lines.push(`${key}: ${song[key]}`);
      }
    }
    if (song.duration !== undefined) {
      lines.push(`Time: ${Math.round(song.duration)}`, `duration: ${song.duration.toFixed(3)}`);
    }
    if (position !== null) {
      lines.push(`Pos: ${position}`, `Id: ${song.id}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
