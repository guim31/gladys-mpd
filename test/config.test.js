// -----------------------------------------------------------------------------
// Normalization of the configuration: addresses as people type them, slots,
// passwords kept as typed, defaults.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, formatAddress, normalizeConfig, parseAddress } from '../src/config.js';
import { checkUri } from '../src/player.js';
import { parseVolume } from '../src/scenes.js';
import { safeText } from '../src/texts.js';

test('addresses: IP, name, port, IPv6, copied URLs', () => {
  assert.deepEqual(parseAddress('192.0.2.10'), { host: '192.0.2.10', port: 6600 });
  assert.deepEqual(parseAddress(' moOde.home:6601 '), { host: 'moode.home', port: 6601 });
  assert.deepEqual(parseAddress('mpd://192.0.2.10:6600/'), { host: '192.0.2.10', port: 6600 });
  assert.deepEqual(parseAddress('http://volumio.local/'), { host: 'volumio.local', port: 6600 });
  assert.deepEqual(parseAddress('[2001:db8::1]:6602'), { host: '2001:db8::1', port: 6602 });
  assert.deepEqual(parseAddress('2001:db8::1'), { host: '2001:db8::1', port: 6600 });
  for (const bad of [
    '',
    '   ',
    'host:0',
    'host:70000',
    'host:abc',
    'user:pass@host',
    'a b',
    null,
    42,
  ]) {
    assert.equal(parseAddress(bad), null, String(bad));
  }
  assert.equal(formatAddress({ host: '192.0.2.10', port: 6600 }), '192.0.2.10');
  assert.equal(formatAddress({ host: '192.0.2.10', port: 6601 }), '192.0.2.10:6601');
  assert.equal(formatAddress({ host: '2001:db8::1', port: 6602 }), '[2001:db8::1]:6602');
});

test('the defaults, with nothing configured', () => {
  assert.deepEqual(normalizeConfig(), {
    players: [],
    invalidSlots: [],
    notificationVolume: null,
    language: 'fr',
  });
  assert.equal(DEFAULT_CONFIG.language, 'fr');
});

test('slots keep their number, a bad address is reported, passwords stay as typed', () => {
  const config = normalizeConfig({
    player_1_address: '192.0.2.10',
    player_1_password: ' with spaces ',
    player_2_address: 'not an address',
    player_3_address: '192.0.2.12:6601',
    player_3_name: '  Cuisine  ',
    notification_volume: '60',
    language: 'de',
  });
  assert.deepEqual(config.players, [
    { slot: 1, host: '192.0.2.10', port: 6600, password: ' with spaces ', name: null },
    { slot: 3, host: '192.0.2.12', port: 6601, password: '', name: 'Cuisine' },
  ]);
  assert.deepEqual(config.invalidSlots, [2]);
  assert.equal(config.notificationVolume, 60);
  assert.equal(config.language, 'de');
  assert.equal(
    normalizeConfig({ notification_volume: '55', language: 'it' }).notificationVolume,
    null,
  );
  assert.equal(normalizeConfig({ language: 'it' }).language, 'fr');
});

test('addresses MPD can play from the container', () => {
  assert.equal(checkUri(' http://radio.example.com/live '), 'http://radio.example.com/live');
  assert.equal(checkUri('sounds/doorbell.mp3'), 'sounds/doorbell.mp3');
  for (const bad of ['', '  ', 'file:///etc/passwd', 'FILE:/x', 'a\nclear', null, 3]) {
    assert.equal(checkUri(bad), null, String(bad));
  }
});

test('a volume field of a scene: empty is unchanged, numbers are bounded', () => {
  assert.equal(parseVolume(undefined), null);
  assert.equal(parseVolume(''), null);
  assert.equal(parseVolume('42,6'), 43);
  assert.equal(parseVolume(150), 100);
  assert.equal(parseVolume(-3), 0);
  assert.equal(parseVolume('loud'), null);
});

test('credentials in an address never reach a log or a message', () => {
  assert.equal(
    safeText('Failed to open "http://user:pa55@radio.example.com/a.mp3"'),
    'Failed to open "http://radio.example.com/a.mp3"',
  );
  assert.equal(safeText('no address here'), 'no address here');
});
