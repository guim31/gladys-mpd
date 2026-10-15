// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, fake MPD servers on real TCP
// sockets (127.0.0.1), and the integration wired on top through
// registerHandlers. No timer runs unless `timers: true`: the tests drive the
// refresh with `world.hub.tick()` and wait for the idle events with
// `eventually()`.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { FakeMpd, LIBRARY, RADIO } from './fakeMpd.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

// Short timings: the notification and connection rules, in milliseconds.
export const FAST_PLAYER_TIMINGS = {
  reconnectMs: [30, 60],
  notificationMaxMs: 2_000,
  streamAfterMs: 150,
  startTimeoutMs: 1_000,
  startCheckMs: 20,
};

/**
 * Wait until `check` returns a truthy value (it may throw meanwhile).
 * @param {() => any} check
 * @param {number} [timeoutMs]
 */
export async function eventually(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw lastError ?? new Error('condition not reached in time');
}

/** Let pending I/O and promises settle. */
export const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} [options]
 * @param {FakeMpd[]} [options.servers] one per slot, from slot 1
 * @param {object} [options.config] raw integration config (addresses filled from the servers)
 * @param {Array} [options.devices] devices already created in Gladys
 * @param {boolean} [options.connect]
 * @param {boolean} [options.timers]
 */
export async function createWorld({
  servers,
  config = {},
  devices = [],
  connect = true,
  timers = false,
  timings = {},
  playerTimings = FAST_PLAYER_TIMINGS,
  connectionTimings = { connectMs: 500, requestMs: 500 },
} = {}) {
  const mpds = servers ?? [new FakeMpd()];
  for (const mpd of mpds) {
    if (!mpd.port) {
      await mpd.listen();
    }
  }
  const addresses = {};
  mpds.forEach((mpd, index) => {
    addresses[`player_${index + 1}_address`] = `127.0.0.1:${mpd.port}`;
    addresses[`player_${index + 1}_name`] = ['Salon', 'Cuisine', 'Bureau', 'Garage'][index];
    if (mpd.password) {
      addresses[`player_${index + 1}_password`] = mpd.password;
    }
  });
  const gladys = createFakeGladys({ config: { language: 'en', ...addresses, ...config }, devices });
  const app = registerHandlers(gladys, {
    timers,
    timings,
    playerTimings,
    connectionTimings,
  });
  const world = {
    gladys,
    fake: gladys.fake,
    app,
    hub: app.hub,
    mpd: mpds[0],
    mpds,
    async stop() {
      await app.stop();
      await Promise.all(mpds.map((mpd) => mpd.close().catch(() => {})));
    },
  };
  if (connect) {
    await gladys.connect();
    await app.ready;
  }
  return world;
}

/** External id of the device of a configuration slot. */
export const deviceId = (gladys, slot = 1) => gladys.externalIds('mpd', String(slot)).device;
export const featureId = (gladys, key, slot = 1) =>
  gladys.externalIds('mpd', String(slot)).feature(key);

/** Add every discovered device in Gladys, as the user would. */
export async function createAll(world) {
  for (const device of world.fake.discoveredDevices) {
    await world.fake.deviceCreated(device);
  }
}

/** The discovered device and one of its features, as Gladys sends them to onSetValue. */
export function featureOf(world, key, slot = 1) {
  const device = world.fake.discoveredDevices.find(
    (d) => d.external_id === deviceId(world.gladys, slot),
  );
  const feature = device.features.find((f) => f.external_id === featureId(world.gladys, key, slot));
  return { device, feature };
}

export { FakeMpd, LIBRARY, RADIO };
