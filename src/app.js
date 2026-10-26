// -----------------------------------------------------------------------------
// Registers every SDK handler on a GladysIntegration (or the SDK's fake Gladys)
// and returns the hub, so index.js stays a few lines and the tests drive the
// very same wiring.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import * as catalog from './catalog.js';
import { normalizeConfig } from './config.js';
import { MpdHub } from './hub.js';
import { SCENE_ACTIONS } from './scenes.js';
import { INIT_FAILED } from './texts.js';
import { WIDGETS } from './widgets.js';

const logger = createLogger({ name: 'mpd-app' });

/**
 * @param {object} gladys GladysIntegration instance
 * @param {object} [options] test seams: timers, timings, playerTimings,
 *   connectionTimings, connect, now
 */
export function registerHandlers(gladys, options = {}) {
  const hub = new MpdHub({
    gladys,
    timers: options.timers ?? true,
    timings: options.timings,
    playerTimings: options.playerTimings,
    connectionTimings: options.connectionTimings,
    connect: options.connect,
    now: options.now,
  });

  // Resolved once the hub has started; every handler waits for it, so a
  // command arriving during the first connection is not lost.
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let started = false;
  const whenReady =
    (fn) =>
    async (...args) => {
      await ready;
      return fn(...args);
    };

  gladys.on('connected', async () => {
    try {
      const config = normalizeConfig(await gladys.getConfig());
      if (started) {
        // A reconnection (Gladys restarted): send again what Gladys may have lost.
        await hub.resync(config);
        return;
      }
      started = true;
      await hub.start(config);
    } catch (err) {
      logger.error('Initialization failed', err);
      await gladys.setConnectionStatus(false, INIT_FAILED).catch(() => {});
    } finally {
      resolveReady();
    }
  });

  gladys.onScanRequest(whenReady(() => hub.rediscover()));

  gladys.onSetValue(whenReady((device, feature, value) => hub.setValue(device, feature, value)));

  // The container refreshes the players on its own timer (src/hub.js); this
  // is the fallback for a Gladys that polls the devices.
  gladys.onPoll(whenReady((device) => hub.pollDevice(device)));

  // Added or updated ("Update" in the Discover tab): the SDK forgot what it
  // had published for the device, everything is sent again now.
  gladys.onDeviceCreated(whenReady((device) => hub.onDeviceCreated(device)));
  gladys.onDeviceUpdated(whenReady((device) => hub.onDeviceCreated(device)));

  // The Gladys 5.3 music panel and the `music.play-media` scene action
  // (manifest `music`), and the bytes of the artworks.
  gladys.onMusicBrowse(whenReady((device, options) => catalog.browse(hub, device, options)));
  gladys.onMusicSearch(whenReady((device, options) => catalog.search(hub, device, options)));
  gladys.onMusicPlay(whenReady((device, media, mode) => catalog.play(hub, device, media, mode)));
  gladys.onMusicQueueGet(whenReady((device, options) => catalog.queueGet(hub, device, options)));
  gladys.onMusicQueuePlay(whenReady((device, index) => catalog.queuePlay(hub, device, index)));
  gladys.onMusicGetArtwork(whenReady((key) => catalog.artwork(hub, key)));

  gladys.onConfigUpdated(
    whenReady(async (newConfig) => {
      logger.info('Configuration updated');
      await hub.reconfigure(normalizeConfig(newConfig));
    }),
  );

  gladys.onAction(
    'test_connection',
    whenReady(() => hub.testConnection()),
  );

  for (const [key, handler] of Object.entries(SCENE_ACTIONS)) {
    gladys.onSceneAction(
      key,
      whenReady((fields) => handler(hub, { fields })),
    );
  }

  for (const [key, widget] of Object.entries(WIDGETS)) {
    gladys.onWidgetGet(
      key,
      whenReady((request) => widget.get(hub, request)),
    );
    gladys.onWidgetAction(
      key,
      whenReady((actionKey, params, context = {}) =>
        widget.action(hub, { actionKey, params, ...context }),
      ),
    );
  }

  return {
    hub,
    ready,
    stop: () => hub.stop(),
  };
}
