# MPD answers

Answers of MPD to `status`, `currentsong` and `listplaylists`, written after the
protocol documentation (<https://mpd.readthedocs.io/en/latest/protocol.html>) and
the output of MPD 0.23 (`0.23.x`, Debian 12, the version of moOde 9 and
piCorePlayer 9) and of MPD 0.21 (`volume: -1` without mixer, no `oneshot`
answers in older releases). They were **not** recorded from a real player
during development: `scripts/probe.mjs` prints the same three answers from a
real one, so they can be compared and replaced.

Addresses are documentation ranges (192.0.2.x, example.com).
