// -----------------------------------------------------------------------------
// The MPD text protocol, without any I/O: how a command is written, how the
// lines of an answer are read. Written from the protocol documentation
// (https://mpd.readthedocs.io/en/latest/protocol.html); no code was copied
// from a client library.
//
//   - the server greets with `OK MPD <version>`;
//   - a command is one line, its arguments separated by spaces, quoted with
//     double quotes when needed (backslash escapes `"` and `\`);
//   - an answer is `key: value` lines, then `OK`, or one `ACK` line:
//     `ACK [<error>@<command_list_num>] {<command>} <message>`;
//   - a command list (`command_list_ok_begin` … `command_list_end`) answers
//     each command followed by `list_OK`, then one final `OK`.
// -----------------------------------------------------------------------------

/** MPD error codes (`enum ack` of the server), the ones this code tells apart. */
export const ACK = Object.freeze({
  NOT_LIST: 1,
  ARG: 2,
  PASSWORD: 3,
  PERMISSION: 4,
  UNKNOWN: 5,
  NO_EXIST: 50,
  PLAYLIST_MAX: 51,
  SYSTEM: 52,
  PLAYLIST_LOAD: 53,
  UPDATE_ALREADY: 54,
  PLAYER_SYNC: 55,
  EXIST: 56,
});

/** Why a request failed, as the rest of the integration needs to know it. */
export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable', // refused, timed out, connection lost, unknown host
  AUTH: 'auth', // wrong password
  PERMISSION: 'permission', // a password is needed (or gives too few rights)
  NOT_MPD: 'not_mpd', // something answers, but not an MPD server
  COMMAND: 'command', // the server refused the command (ACK)
  TOO_LARGE: 'too_large', // an answer larger than the integration reads (connection closed)
});

export class MpdError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message
   * @param {{ code?: number, command?: string, index?: number }} [details]
   *   index: the command of a command list that failed
   */
  constructor(kind, message, { code, command, index } = {}) {
    super(message);
    this.name = 'MpdError';
    this.kind = kind;
    this.code = code;
    this.command = command;
    this.index = index;
  }
}

const GREETING = /^OK MPD (\S+)/;
const ACK_LINE = /^ACK \[(\d+)@(\d+)\](?: \{([^}]*)\})?\s*(.*)$/;

/**
 * The version announced by the greeting line, null when it is not MPD.
 * @param {string} line
 */
export function parseGreeting(line) {
  const match = GREETING.exec(line);
  return match ? match[1] : null;
}

/**
 * Quote one argument when needed. Only `"` and `\` are escaped: MPD reads
 * the argument up to the next unescaped quote.
 * @param {string|number} value
 */
export function quote(value) {
  const text = String(value);
  if (text !== '' && /^[^\s"'\\]+$/.test(text)) {
    return text;
  }
  return `"${text.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

/**
 * One command line, without the newline.
 * @param {string} name
 * @param {Array<string|number>} [args]
 */
export function formatCommand(name, args = []) {
  if (!/^[a-z_]+$/.test(name)) {
    throw new Error(`Invalid MPD command name: ${name}`);
  }
  for (const arg of args) {
    // A newline would end the command early and start another one.
    if (/[\r\n]/.test(String(arg))) {
      throw new Error('An MPD argument cannot hold a line break');
    }
  }
  return [name, ...args.map(quote)].join(' ');
}

/**
 * Read an `ACK` line into an MpdError.
 * @param {string} line
 */
export function parseAck(line) {
  const match = ACK_LINE.exec(line);
  if (!match) {
    return new MpdError(ERROR_KINDS.COMMAND, line);
  }
  const code = Number(match[1]);
  const index = Number(match[2]);
  const command = match[3] ?? '';
  const message = match[4] || line;
  let kind = ERROR_KINDS.COMMAND;
  if (code === ACK.PASSWORD) {
    kind = ERROR_KINDS.AUTH;
  } else if (code === ACK.PERMISSION) {
    kind = ERROR_KINDS.PERMISSION;
  }
  return new MpdError(kind, message, { code, command, index });
}

/**
 * `key: value` lines into pairs, in order (a key may repeat: two `Artist`
 * lines, one `playlist` line per stored playlist).
 * @param {string[]} lines
 * @returns {Array<[string, string]>}
 */
export function parsePairs(lines) {
  const pairs = [];
  for (const line of lines) {
    const at = line.indexOf(': ');
    if (at <= 0) {
      continue;
    }
    pairs.push([line.slice(0, at), line.slice(at + 2)]);
  }
  return pairs;
}

/**
 * The pairs of one object (`status`, `currentsong`). A repeated key keeps all
 * its values, joined later by the reader that needs them.
 * @param {string[]} lines
 * @returns {Record<string, string|string[]>}
 */
export function parseObject(lines) {
  const object = {};
  for (const [key, value] of parsePairs(lines)) {
    if (key in object) {
      object[key] = [].concat(object[key], value);
    } else {
      object[key] = value;
    }
  }
  return object;
}

/**
 * A list of objects, each starting with `startKey` (`playlist` for
 * `listplaylists`, `file` for `playlistinfo`).
 * @param {string[]} lines
 * @param {string} startKey
 */
export function parseList(lines, startKey) {
  const items = [];
  let current = null;
  for (const [key, value] of parsePairs(lines)) {
    if (key === startKey) {
      current = { [key]: value };
      items.push(current);
    } else if (current) {
      current[key] = value;
    }
  }
  return items;
}

/** The subsystems an `idle` answer reports (`changed: player`…). */
export function parseChanges(lines) {
  return parsePairs(lines)
    .filter(([key]) => key === 'changed')
    .map(([, value]) => value);
}
