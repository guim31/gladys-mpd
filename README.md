# Music Player Daemon for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com)
that controls [MPD](https://www.musicpd.org) (Music Player Daemon) players over
the local network: a Raspberry Pi plugged into an amplifier with
[moOde](https://moodeaudio.org), [Volumio](https://volumio.com),
[piCorePlayer](https://www.picoreplayer.org), or MPD itself. No cloud, no
account.

> **Developed without the hardware: feedback welcome.** The integration is
> built and tested against a real MPD 0.24 running in Docker (null output, no
> sound card) and a simulated MPD server, not on a moOde, Volumio or
> piCorePlayer player. Please report what works and what does not in the
> [issues](https://github.com/guim31/gladys-mpd/issues).

## Features

- **The Gladys 5.3 music player**: the **Music** box of the dashboard shows
  the cover, title, artist, album and a progress bar you can drag, with play,
  pause, stop, previous, next, shuffle, repeat (off, all, one) and the volume;
  its panels list the **queue** (a tap jumps), **search** the library (songs
  through MPD, artists, albums and playlists by name) and **browse** it by
  folders, artists, albums and playlists, to play an item now, next or at the
  end of the queue. The **Play music on a speaker** scene action of Gladys
  uses the same panel. Covers come from MPD (embedded picture, else the cover
  file of the folder), made smaller in pure JavaScript when they are above the
  300 KB Gladys accepts. MPD has no mute: none is published.
- **One device per player** (up to four, each with its address, password and
  name), with the music features of Gladys, so it shows as a player in the
  **Music** dashboard box and in the **Talk on a speaker** scene action: play,
  pause, previous, next, **volume**, **playback state** (writable: 0 paused,
  1 playing, 2 stopped), title, artist, album, artwork, duration, position,
  shuffle, repeat, a **playlist** select listing the playlists saved
  in MPD (it follows MPD when one is saved or deleted), and a
  **notification** feature.
- **Notifications that put the music back**: an address (a doorbell sound, a
  file of the music library, the voice of "Talk on a speaker") is added at the
  end of the queue and played, at the volume of the configuration; then it is
  removed, the volume and the options come back, and the song that played
  resumes at the second it was interrupted (paused stays paused). A second
  notification replaces the first; someone taking over the player ends it; a
  web radio keeps playing.
- **Real time**: one connection per player, kept open in MPD's `idle` mode, so
  a change made anywhere (moOde, a phone app, Gladys) reaches Gladys within a
  second. Plus a reading every 30 s of the container's own (the ping, and the
  refresh that does not depend on the core polling the devices), and a
  reconnection with back-off.
- **Dashboard widget** "MPD player": title, artist and album (or the radio
  station), a volume gauge, state, position in the queue, random and repeat,
  and four buttons: previous, play/pause, next, and **Options…**, a form
  pre-filled with the volume, a playlist to play, random and repeat.
- **Scene actions**: _Play an MPD playlist_ (by name, without case nor
  accents; the number of songs as output), _Play an address on MPD_ (then
  resume the previous music, or keep playing it in place of the queue; with
  its own volume; fails when MPD cannot play it), _Clear the MPD queue_, _MPD
  random play_ (on, off, toggle) and _MPD repeat_ (off, all, one).
- A **Test the connection** button, a connection status that names the
  player and the problem (does not answer, password refused, not MPD…), and a
  transport badge per device (local, unreachable).
- Every text in English, French, German and Spanish.

## Requirements

- Gladys Assistant **5.3.0** or later (the music player, its panels and the
  `music` field of the manifest).
- For the panels: MPD **0.21** or later (`list … group`, `albumart`); covers
  embedded in the files need **0.22** (`readpicture`).
- An MPD server reachable from Gladys on its port (6600 by default), with the
  `read`, `add` and `control` rights for the integration (the default without
  password).

## Installation

1. In Gladys, open **Integrations** → **Install from GitHub** and enter the
   address of this repository: `https://github.com/guim31/gladys-mpd` (or
   install **Music Player Daemon** from the catalog once it is listed).
2. In **Configuration**, enter the address of your player (`192.168.1.20`,
   `moode.home:6600`…), its password if `mpd.conf` has one, and a name; up to
   three more players below. Save, then click **Test the connection**.
3. Open the **Discover** tab and add the devices. A device added with 1.0
   gets the music features of Gladys 5.3 with **Update** in that tab.

The user guide is in [`docs/en.md`](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)); Gladys
links it from the Configuration screen.

## How it works

- A small MPD client written for the integration (`src/mpd/`), on `node:net`:
  greeting, password, command lists (`command_list_ok_begin`), `idle` cut
  short by `noidle` when a command must go, ACK errors read into kinds, binary
  chunks (`albumart`, `readpicture`) read as bytes.
- Per player (`src/player.js`): the connection, the reconnection (2, 5, 15,
  30 s, then every minute), the readings (`status` + `currentsong` in one
  command list, `listplaylists` when `stored_playlist` changes), the commands
  and the notifications.
- The hub (`src/hub.js`): devices, states (`publishNowPlaying` of the SDK:
  only the changes, the position only on a jump), transports, connection
  status, the widget refreshes (at most one per 10 s, the last change kept),
  and the 30 s timer. The devices are published with `should_poll: true` and
  one minute, and `onPoll` is a fallback skipped when the player was read less
  than 15 s ago (Gladys#3198).
- A notification: `addid <address>` alone (an address MPD refuses changes
  nothing), then `consume 0`, `repeat 0`, `single 1`, the volume, `playid`. At
  the end (stopped on it), `deleteid`, the options and the volume back, then
  `seekid <song> <elapsed>` (or `playid` for a radio, which cannot seek) and
  `pause 1` if it was paused. A notification still playing without a known
  duration after 4 s is a web radio: only the options come back. After five
  minutes, a notification is ended in any case.
- The music panel (`src/catalog.js`) reads on a second, short-lived
  connection (the one in idle stays free for the commands): `lsinfo`,
  `list artist`, `list album group albumartist`, `find … window`,
  `search any`, `listplaylist(info)`, `playlistinfo start:end`. Media ids name
  what MPD knows (`song:<path>`, `dir:<path>`, `album:[tag, artist, album]`…),
  so a scene keeps them. Queuing adds the songs (500 at most) with `addid` at
  a position, skips a song MPD no longer has, and removes the old queue only
  once the new songs are in. Covers: `readpicture` then `albumart` (folder
  path with a trailing `/`), read with `binarylimit` 1 MB, reduced by
  `src/artwork-resize.js` (from gladys-mopidy), a resized copy kept per image.
- The playlist select is a `text/select` feature whose `supported_options`
  are the playlists: Gladys syncs them silently on each publication.
- Nothing is stored in `/data`. Passwords stay in the Gladys configuration and
  never reach the logs; credentials in an address are removed before a log
  line.

## Checked, and what was not

Checked in this repository, by the tests (`npm test`), against the SDK's fake
Gladys and a fake MPD server on a real socket: the protocol (quoting, command
lists, idle/noidle, ACK, timeouts, a peer that is not MPD), every feature and
action, the notifications (playing, paused, stopped, consume and repeat on,
two in a row, someone taking over, a radio, an address MPD cannot play, the
five-minute limit), the reconnection, the logs, the widget content against
the SDK's `validateWidgetContent`, and the conformity of the devices with the
core (`test/gladys-rules.test.js`).

Checked against a real **MPD 0.24.5** (Alpine, in Docker, null output with a
software mixer), with a generated library (tags, embedded JPEG and PNG
pictures, `cover.jpg` files, one of 6.5 MB) and stored playlists, through the
SDK's fake Gladys, also inside the locked container of the integration: every
now-playing state, every command, browse, search, the three play modes, the
queue, the covers, a notification.

Not checked: moOde, Volumio or piCorePlayer; MPD 0.21 to 0.23; a real Gladys
(the Music box, "Talk on a speaker", the widget and its form). The answers in
`test/fixtures/mpd/` follow the MPD documentation: `node scripts/probe.mjs <host> [port]` (read-only: `status`,
`currentsong`, `listplaylists`, `commands`, one `idle` of 10 s; password from
`MPD_PASSWORD`, never printed) shows the real ones.

## Limitations

- Four players at most. A player is identified by its slot in the
  configuration (MPD has no id of its own): changing its address keeps the
  device.
- No mute (MPD has none), no Snapcast grouping, no output selection. The
  house widget has no cover (the Music box of Gladys 5.3 has).
- MPD's search ignores capitals, and accents only when MPD is built with ICU.
- MPD announces itself over mDNS only on some systems, and Gladys relays no
  `_mpd._tcp` discovery: the addresses are typed.
- Gladys does not pass the volume of its "Talk on a speaker" action to
  external integrations: the notification volume is a setting of the
  integration.
- Names ending in `.local` do not resolve inside the integration container.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
node scripts/probe.mjs 192.0.2.10 6600     # read-only, against a real player
```

See [`CLAUDE.md`](CLAUDE.md) for the project rules.

## Credits

- [MPD](https://www.musicpd.org) and its
  [protocol documentation](https://mpd.readthedocs.io/en/latest/protocol.html),
  from which the client was written.
- Home Assistant's
  [`mpd`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/mpd)
  integration (Apache-2.0) and [python-mpd2](https://github.com/Mic92/python-mpd2)
  by Jörg Thalheim and contributors (LGPL-3.0, read for the protocol, no code
  copied): the choice of features, the repeat modes, the handling of players
  without mixer and of web radios.
- The Sonos integration of the Gladys core, for the notification that puts
  the music back.
- `src/artwork-resize.js` comes from
  [gladys-mopidy](https://github.com/guim31/gladys-mopidy) (pure JavaScript
  JPEG/PNG reduction); it encodes with
  [jpeg-js](https://github.com/jpeg-js/jpeg-js) (BSD-3-Clause), the only
  runtime dependency beside the Gladys SDK.
- The architecture and the conformity tests follow
  [gladys-wled](https://github.com/guim31/gladys-wled) and
  [gladys-pihole](https://github.com/guim31/gladys-pihole).

## Disclaimer

This project is not affiliated with the MPD project, nor with moOde, Volumio
or piCorePlayer. The names belong to their owners.

## License

Apache-2.0
