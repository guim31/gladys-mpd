# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- The Gladys 5.3 music player: the **Music** box of the dashboard shows the
  cover, the title, the artist, the album and a progress bar you can drag to
  seek, with shuffle and repeat (off, all, one). Its panels list the queue (a
  tap jumps to a song), search the library (songs, artists, albums,
  playlists) and browse it by folders, artists, albums and playlists, to play
  an item now, after the current song or at the end of the queue. The
  **Play music on a speaker** scene action of Gladys uses the same panel.
- New features on each player: title, artist, album, artwork, duration,
  position (writable: seek), shuffle and repeat. Covers come from MPD (the
  picture embedded in the file, else the cover file of the folder) and are
  made smaller when they are above the 300 KB Gladys accepts. A device added
  with 1.0 gets them with **Update** in the Discover tab of the integration.

### Changed

- **Playback state** is writable (pause, play, stop) and reads **2** when MPD
  is stopped (it read 0, like paused): a scene on "playback state = 0" no
  longer runs on a stop. It is no longer kept in the history (Gladys keeps no
  history of music features), and it reads stopped while the player does not
  answer.
- The volume and the playback state are sent only when they change (no more
  six-hour heartbeat: Gladys never shows a music value as old).
- Requires Gladys 5.3.0 or later. The search, browse and queue panels need
  MPD 0.21 or later (covers embedded in the files: 0.22).

## [1.0.1] - 2026-10-15

### Added

- One Gladys device per MPD player (moOde, Volumio, piCorePlayer, MPD), up to
  four: play, pause, previous, next, volume, playback state, a playlist select
  listing the playlists saved in MPD, and a notification feature. The player
  shows in the Music box of the dashboard and in the "Talk on a speaker" scene
  action.
- Notifications that put the music back: the address plays at the end of the
  queue, at the notification volume of the configuration, then the song that
  played resumes where it was, with its volume and options.
- Changes made on the player reach Gladys within a second (one connection per
  player in MPD's idle mode), with a reading every 30 seconds and an automatic
  reconnection.
- Dashboard widget "MPD player": what plays, the volume, the state, buttons
  and an Options… form (volume, playlist, random, repeat).
- Scene actions: play an MPD playlist, play an address (then resume the music
  or keep playing it), clear the queue, random play, repeat.
- A "Test the connection" button, a connection status per player and a
  transport badge per device.
- Every text in English, French, German and Spanish; feature names in French
  by default.

[Unreleased]: https://github.com/guim31/gladys-mpd/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/guim31/gladys-mpd/releases/tag/v1.0.1
