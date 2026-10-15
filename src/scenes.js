// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+). Gladys
// applies the field defaults and checks the required fields before calling.
//
//   - play_playlist: a stored playlist of MPD, by name (the playlist select
//     of the device offers the list in "Control a device"; a scene action
//     field cannot list the playlists: only `source: "devices"` is dynamic);
//   - play_url: an address (web radio, doorbell sound, a file of the
//     library), then what was playing comes back — or in place of the queue;
//   - clear_queue, set_random, set_repeat: the queue and its options.
//
// Keys, field keys and option values are permanent once published.
// -----------------------------------------------------------------------------

export const RANDOM_MODES = ['on', 'off', 'toggle'];
export const REPEAT_OPTIONS = ['off', 'all', 'one'];
export const AFTER_OPTIONS = ['resume', 'keep'];

/** A volume field of a scene: empty means "do not change". */
export function parseVolume(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const number = Number(String(raw).trim().replace(',', '.'));
  if (!Number.isFinite(number)) {
    return null;
  }
  return Math.round(Math.min(100, Math.max(0, number)));
}

export const SCENE_ACTIONS = {
  async play_playlist(hub, { fields = {} }) {
    const record = hub.target(fields.device);
    const { songs } = await hub.playPlaylist(record, fields.playlist);
    return { songs };
  },

  async play_url(hub, { fields = {} }) {
    const record = hub.target(fields.device);
    const resume = (fields.after ?? 'resume') !== 'keep';
    await hub.notify(record, fields.url, {
      volume: parseVolume(fields.volume),
      resume,
      wait: resume,
    });
    return undefined;
  },

  async clear_queue(hub, { fields = {} }) {
    const record = hub.target(fields.device);
    await hub.command(record, 'clear the queue', (player) => player.clearQueue());
    return undefined;
  },

  async set_random(hub, { fields = {} }) {
    const record = hub.target(fields.device);
    const mode = RANDOM_MODES.includes(fields.mode) ? fields.mode : 'on';
    const random = await hub.command(record, `random ${mode}`, async (player) => {
      if (!player.status) {
        await player.refresh();
      }
      const enabled = mode === 'toggle' ? !player.status.random : mode === 'on';
      await player.setRandom(enabled);
      return enabled;
    });
    return { random };
  },

  async set_repeat(hub, { fields = {} }) {
    const record = hub.target(fields.device);
    const mode = REPEAT_OPTIONS.includes(fields.mode) ? fields.mode : 'all';
    await hub.command(record, `repeat ${mode}`, (player) => player.setRepeat(mode));
    return undefined;
  },
};
