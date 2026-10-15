// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// Up to four players, each in its own slot (address, password, name). The
// slot number is the device identity: MPD exposes no id of its own, and
// changing the address of a slot (a new IP, a host name instead of an IP)
// must keep the device, its history and the scenes that use it.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

export const SLOTS = [1, 2, 3, 4];

export const DEFAULT_PORT = 6600;

// Volume of the notifications (play_notification): `keep` leaves the volume
// as it is, a number sets it for the notification and puts it back after.
export const NOTIFICATION_VOLUMES = ['keep', '20', '30', '40', '50', '60', '70', '80', '100'];

export const DEFAULT_CONFIG = {
  player_1_address: '',
  player_1_password: '',
  player_1_name: '',
  player_2_address: '',
  player_2_password: '',
  player_2_name: '',
  player_3_address: '',
  player_3_password: '',
  player_3_name: '',
  player_4_address: '',
  player_4_password: '',
  player_4_name: '',
  notification_volume: 'keep',
  language: 'fr',
};

const MAX_NAME_LENGTH = 40;

/**
 * Parse the address typed by the user: a host name or an IP, with an optional
 * port (`192.0.2.10`, `moode.home:6601`, `[2001:db8::1]:6600`), or what was
 * copied from another tool (`mpd://host:port`, a trailing slash).
 * @param {unknown} raw
 * @returns {{ host: string, port: number }|null} null when unusable
 */
export function parseAddress(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  let text = raw.trim();
  if (!text) {
    return null;
  }
  // A scheme is accepted (copied URL) but only the host and port matter.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (scheme) {
    text = text.slice(scheme[0].length);
  }
  text = text.replace(/\/.*$/, '');
  // Credentials in the address would end up in the logs and the device params.
  if (text.includes('@')) {
    return null;
  }
  let host;
  let portText = '';
  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d+))?$/i.exec(text);
  if (bracketed) {
    host = bracketed[1];
    portText = bracketed[2] ?? '';
  } else if ((text.match(/:/g) ?? []).length > 1) {
    // A bare IPv6 address: no port possible without brackets.
    if (!/^[0-9a-f:.]+$/i.test(text)) {
      return null;
    }
    host = text;
  } else {
    const [name, port = ''] = text.split(':');
    host = name;
    portText = port;
  }
  if (!host || !/^[a-z0-9._:-]+$/i.test(host)) {
    return null;
  }
  let port = DEFAULT_PORT;
  if (portText !== '') {
    if (!/^\d{1,5}$/.test(portText)) {
      return null;
    }
    port = Number(portText);
    if (port < 1 || port > 65535) {
      return null;
    }
  }
  return { host: host.toLowerCase(), port };
}

/** `host:port` as shown to the user, brackets around an IPv6 address. */
export const formatAddress = ({ host, port }) =>
  `${host.includes(':') ? `[${host}]` : host}${port === DEFAULT_PORT ? '' : `:${port}`}`;

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const pick = (key, list) => {
    const value = source[key] === undefined || source[key] === null ? '' : String(source[key]);
    return list.includes(value) ? value : DEFAULT_CONFIG[key];
  };

  const players = [];
  const invalidSlots = [];
  for (const slot of SLOTS) {
    const typed = text(`player_${slot}_address`);
    if (!typed) {
      continue;
    }
    const address = parseAddress(typed);
    if (!address) {
      invalidSlots.push(slot);
      continue;
    }
    players.push({
      slot,
      ...address,
      // Passwords are kept as typed: spaces may be part of them.
      password:
        typeof source[`player_${slot}_password`] === 'string'
          ? source[`player_${slot}_password`]
          : '',
      name: text(`player_${slot}_name`).slice(0, MAX_NAME_LENGTH) || null,
    });
  }

  const volume = pick('notification_volume', NOTIFICATION_VOLUMES);
  return {
    players,
    invalidSlots,
    notificationVolume: volume === 'keep' ? null : Number(volume),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
