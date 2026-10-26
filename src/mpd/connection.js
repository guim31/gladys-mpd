// -----------------------------------------------------------------------------
// One TCP connection to an MPD server.
//
// MPD answers one command at a time, in order: the requests wait in a queue
// and only the head one is on the wire. `idle` is a request like the others,
// whose answer comes when something changes on the server: when another
// request is queued behind it, `noidle` is sent so that the server answers
// the idle at once (with what changed so far), then the queue goes on. The
// caller simply calls idle() again afterwards.
//
// A connection in idle never times out on the MPD side (its
// `connection_timeout`, 60 s by default, only applies to a silent client):
// that is why the integration keeps one connection per player open, in idle,
// instead of connecting for each command.
//
// Any other request has its own deadline: a server that stops answering
// (unplugged, Wi-Fi lost) closes the connection, and the player reconnects.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import net from 'node:net';
import {
  ERROR_KINDS,
  MpdError,
  formatCommand,
  parseAck,
  parseChanges,
  parseGreeting,
} from './protocol.js';

export const CONNECTION_TIMINGS = {
  connectMs: 5_000,
  requestMs: 10_000,
};

// Longest line accepted from the server: protects the memory of the
// container (256 MB) from a peer that is not MPD and never sends a newline.
const MAX_BUFFER = 1_000_000;

// Largest answer accepted (characters of its lines): a library listing of a
// huge folder or a broad search. MPD itself drops a client past 8 MB of
// output by default; past this, the connection is closed with TOO_LARGE.
export const MAX_ANSWER_CHARS = 4_000_000;

// Largest binary chunk accepted (`albumart`, `readpicture`): the
// `binarylimit` the player asks for is below it.
export const MAX_BINARY_CHUNK = 1_048_576;

/**
 * @typedef {object} Request
 * @property {'greeting'|'command'|'list'|'idle'|'binary'} type
 * @property {string} text what is written on the wire
 * @property {(value: any) => void} resolve
 * @property {(err: Error) => void} reject
 * @property {string[]} lines lines collected so far
 * @property {string[][]} [results] list answers collected so far
 * @property {string} [label] command name, for the error messages
 * @property {NodeJS.Timeout} [timer]
 * @property {number} [size] characters received so far
 * @property {number} [binaryLeft] bytes of a binary chunk still to read
 * @property {Buffer|null} [data] the binary chunk
 */

export class MpdConnection extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.host
   * @param {number} options.port
   * @param {string} [options.password]
   * @param {object} [options.timings] CONNECTION_TIMINGS overrides
   * @param {(options: object) => import('node:net').Socket} [options.connect] socket seam
   */
  constructor({ host, port, password = '', timings, connect = net.connect }) {
    super();
    this.host = host;
    this.port = port;
    this.password = password;
    this.timings = { ...CONNECTION_TIMINGS, ...timings };
    this.connectSocket = connect;
    this.socket = null;
    /** Bytes received and not read yet (lines are UTF-8, chunks binary). */
    this.buffer = Buffer.alloc(0);
    /** @type {Request[]} */
    this.queue = [];
    this.noidleSent = false;
    this.closed = false;
    this.version = null;
  }

  /**
   * Connect, read the greeting and send the password when there is one.
   * @returns {Promise<string>} the MPD protocol version
   */
  async open() {
    const greeting = new Promise((resolve, reject) => {
      // The greeting is the answer to a request nobody wrote.
      this.queue.push({ type: 'greeting', text: '', resolve, reject, lines: [] });
    });
    const socket = this.connectSocket({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setNoDelay?.(true);
    // Notices a peer gone without a word (power cut) even while in idle.
    socket.setKeepAlive?.(true, 30_000);
    const connectTimer = setTimeout(() => {
      this.fail(new MpdError(ERROR_KINDS.UNREACHABLE, 'connection timed out'));
    }, this.timings.connectMs);
    connectTimer.unref?.();
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('error', (err) => this.fail(networkError(err)));
    socket.on('close', () => this.fail(new MpdError(ERROR_KINDS.UNREACHABLE, 'connection closed')));
    try {
      this.version = await greeting;
    } finally {
      clearTimeout(connectTimer);
    }
    if (this.password) {
      await this.command('password', [this.password]);
    }
    return this.version;
  }

  /**
   * Run one command.
   * @param {string} name
   * @param {Array<string|number>} [args]
   * @returns {Promise<string[]>} the lines of the answer, without `OK`
   */
  command(name, args = []) {
    return this.enqueue({ type: 'command', text: `${formatCommand(name, args)}\n`, label: name });
  }

  /**
   * Run several commands as one command list: MPD runs them in a row, no
   * other client in between, and stops at the first error.
   * @param {Array<[string, Array<string|number>?]>} commands
   * @returns {Promise<string[][]>} one answer per command
   */
  commandList(commands) {
    const body = commands.map(([name, args]) => formatCommand(name, args ?? [])).join('\n');
    return this.enqueue({
      type: 'list',
      text: `command_list_ok_begin\n${body}\ncommand_list_end\n`,
      label: commands.map(([name]) => name).join('+'),
      results: [],
    });
  }

  /**
   * Run a command answering a binary chunk (`albumart`, `readpicture`):
   * `size`, `type`, `binary: <n>`, then n raw bytes.
   * @param {string} name
   * @param {Array<string|number>} [args]
   * @returns {Promise<{ lines: string[], data: Buffer|null }>} data null when
   *   the answer has no chunk (`readpicture` of a file without a picture)
   */
  binary(name, args = []) {
    return this.enqueue({
      type: 'binary',
      text: `${formatCommand(name, args)}\n`,
      label: name,
      data: null,
    });
  }

  /**
   * Wait for a change on the server. Resolves with the changed subsystems
   * (`player`, `mixer`, `options`, `playlist`, `stored_playlist`…), possibly
   * none when it was cut short by another request.
   * @param {string[]} [subsystems]
   * @returns {Promise<string[]>}
   */
  idle(subsystems = []) {
    return this.enqueue({
      type: 'idle',
      text: `${formatCommand('idle', subsystems)}\n`,
      label: 'idle',
    });
  }

  enqueue(request) {
    if (this.closed) {
      return Promise.reject(new MpdError(ERROR_KINDS.UNREACHABLE, 'connection closed'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ ...request, resolve, reject, lines: [] });
      if (this.queue.length === 1) {
        this.send();
      } else {
        this.interruptIdle();
      }
    });
  }

  /** Something waits behind an idle: ask the server to answer the idle now. */
  interruptIdle() {
    const [head] = this.queue;
    if (head?.type === 'idle' && head.sent && !this.noidleSent && this.queue.length > 1) {
      this.noidleSent = true;
      this.socket.write('noidle\n');
    }
  }

  /** Write the head request. */
  send() {
    const [head] = this.queue;
    if (!head || head.sent || this.closed) {
      return;
    }
    head.sent = true;
    if (head.type !== 'idle') {
      head.timer = setTimeout(() => {
        this.fail(new MpdError(ERROR_KINDS.UNREACHABLE, `no answer to ${head.label} (timeout)`));
      }, this.timings.requestMs);
      head.timer.unref?.();
    }
    this.socket.write(head.text);
    this.interruptIdle();
  }

  receive(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (!this.closed) {
      const [head] = this.queue;
      if (head?.binaryLeft !== undefined) {
        // A binary chunk, then the newline that ends it.
        if (this.buffer.length < head.binaryLeft + 1) {
          return;
        }
        head.data = Buffer.from(this.buffer.subarray(0, head.binaryLeft));
        this.buffer = this.buffer.subarray(head.binaryLeft + 1);
        delete head.binaryLeft;
        continue;
      }
      const at = this.buffer.indexOf(10);
      if (at === -1) {
        if (this.buffer.length > MAX_BUFFER) {
          this.fail(new MpdError(ERROR_KINDS.NOT_MPD, 'answer too long, not an MPD server'));
        }
        return;
      }
      const line = this.buffer.toString('utf8', 0, at).replace(/\r$/, '');
      this.buffer = this.buffer.subarray(at + 1);
      this.line(line);
    }
  }

  line(line) {
    const [head] = this.queue;
    if (!head) {
      // Nothing was asked: MPD never talks first, except to greet.
      return;
    }
    if (head.type === 'greeting') {
      const version = parseGreeting(line);
      if (version === null) {
        this.fail(new MpdError(ERROR_KINDS.NOT_MPD, 'not an MPD server'));
        return;
      }
      this.finish(version);
      return;
    }
    if (line === 'OK') {
      if (head.type === 'list') {
        this.finish(head.results);
      } else if (head.type === 'binary') {
        this.finish({ lines: head.lines, data: head.data });
      } else if (head.type === 'idle') {
        this.finish(parseChanges(head.lines));
      } else {
        this.finish(head.lines);
      }
      return;
    }
    if (line.startsWith('ACK ')) {
      const error = parseAck(line);
      if (head.type === 'list') {
        // The answers of the commands that ran before the failing one.
        error.results = head.results;
      }
      this.finish(null, error);
      return;
    }
    if (line === 'list_OK' && head.type === 'list') {
      head.results.push(head.lines);
      head.lines = [];
      return;
    }
    head.size = (head.size ?? 0) + line.length + 1;
    if (head.size > MAX_ANSWER_CHARS) {
      this.fail(
        new MpdError(ERROR_KINDS.TOO_LARGE, `answer to ${head.label} too large`, {
          command: head.label,
        }),
      );
      return;
    }
    if (head.type === 'binary') {
      const match = /^binary: (\d+)$/.exec(line);
      if (match) {
        const length = Number(match[1]);
        if (length > MAX_BINARY_CHUNK) {
          this.fail(new MpdError(ERROR_KINDS.TOO_LARGE, `binary chunk of ${length} bytes`));
          return;
        }
        head.binaryLeft = length;
      }
    }
    head.lines.push(line);
  }

  /** Settle the head request, then send the next one. */
  finish(value, error) {
    const head = this.queue.shift();
    clearTimeout(head.timer);
    if (head.type === 'idle') {
      this.noidleSent = false;
    }
    if (error) {
      head.reject(error);
    } else {
      head.resolve(value);
    }
    this.send();
  }

  /** The connection is lost: every request fails, and `close` is emitted once. */
  fail(error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const pending = this.queue.splice(0);
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.socket?.destroy();
    this.emit('close', error);
  }

  /** Close on purpose (configuration changed, integration stopping). */
  close() {
    if (this.closed) {
      return;
    }
    // `close` is polite but not required: MPD drops the client either way.
    try {
      this.socket?.write('close\n');
    } catch {
      // the socket may already be gone
    }
    this.fail(new MpdError(ERROR_KINDS.UNREACHABLE, 'connection closed'));
  }
}

/** A socket error, as the user should read it (never the address: logs). */
function networkError(err) {
  const reasons = {
    ECONNREFUSED: 'connection refused (is MPD listening on this address and port?)',
    ETIMEDOUT: 'connection timed out',
    EHOSTUNREACH: 'host unreachable',
    ENETUNREACH: 'network unreachable',
    ENOTFOUND: 'unknown host name',
    EAI_AGAIN: 'host name not resolved',
    ECONNRESET: 'connection reset',
    EPIPE: 'connection lost',
  };
  return new MpdError(ERROR_KINDS.UNREACHABLE, reasons[err.code] ?? err.message);
}
