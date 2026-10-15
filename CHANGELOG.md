# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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

[Unreleased]: https://github.com/guim31/gladys-mpd/commits/main
