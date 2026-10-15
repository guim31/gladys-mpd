// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `player`.
//
// The use case: the wall tablet of the kitchen shows what the living room
// plays, and lets anyone skip a song, pause, change the volume or start a
// playlist. The music box of Gladys has the buttons and the volume, but not
// the title nor the playlists: the widget brings them.
//
// One player: the one chosen in the widget settings, or the first of the
// configuration. Budget (8 components, 2 texts, 6 tiles, 1 status, 4
// buttons): the title (heading) and artist · album (caption), a volume
// gauge, a status list (state, position in the queue, random, repeat), and
// four buttons: previous, play/pause, next, and "Options…" — a form with the
// volume, a playlist, random and repeat, pre-filled with the current values
// (forms behind widget buttons need Gladys 5.2.0, GladysAssistant/Gladys#3168).
//
// No cover art: MPD sends it raw (often over 300 KB, the core limit), and
// resizing it would need an image library in a 256 MB sandbox.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { MAX_PLAYLISTS, playerName } from './devices.js';
import { WIDGET_KEY } from './hub.js';
import { STATES, describeSong } from './mpd/model.js';
import { REPEAT_MODES, repeatMode } from './player.js';
import { ACTION_TEXT, ERROR_TEXT, UserError, fit, pick } from './texts.js';

// Action keys of the buttons: permanent once published (unique, the core
// drops a button whose key is taken).
export const ACTIONS = Object.freeze({
  PREVIOUS: 'previous',
  TOGGLE: 'toggle',
  NEXT: 'next',
  OPTIONS: 'options',
});

// The playlist choice of the form that changes nothing. MPD forbids "/" in a
// stored playlist name, so no playlist can be called this.
export const KEEP_PLAYLIST = '/keep';

export const TEXT = {
  configure: {
    en: 'Enter the address of your MPD player in the configuration of the integration.',
    fr: "Saisissez l'adresse de votre lecteur MPD dans la configuration de l'intégration.",
    de: 'Gib die Adresse deines MPD-Players in der Konfiguration der Integration ein.',
    es: 'Introduzca la dirección de su reproductor MPD en la configuración de la integración.',
  },
  unknown: {
    en: 'This player is no longer in the configuration: choose another one in the widget settings.',
    fr: "Ce lecteur n'est plus dans la configuration : choisissez-en un autre dans les réglages du widget.",
    de: 'Dieser Player ist nicht mehr in der Konfiguration: Wähle einen anderen in den Widget-Einstellungen.',
    es: 'Este reproductor ya no está en la configuración: elija otro en la configuración del widget.',
  },
  updateGladys: {
    en: 'Update Gladys to 5.2.0 or later to use this form.',
    fr: 'Mettez Gladys à jour (5.2.0 ou plus) pour utiliser ce formulaire.',
    de: 'Aktualisiere Gladys auf 5.2.0 oder neuer, um dieses Formular zu nutzen.',
    es: 'Actualice Gladys a la versión 5.2.0 o posterior para usar este formulario.',
  },
  nothing: {
    en: 'Nothing playing',
    fr: 'Aucune lecture',
    de: 'Keine Wiedergabe',
    es: 'Nada en reproducción',
  },
  emptyQueue: {
    en: 'The queue is empty',
    fr: "La file d'attente est vide",
    de: 'Die Warteschlange ist leer',
    es: 'La cola está vacía',
  },
  unreachable: {
    en: 'Unreachable',
    fr: 'Injoignable',
    de: 'Nicht erreichbar',
    es: 'Inaccesible',
  },
  connecting: {
    en: 'Connecting…',
    fr: 'Connexion…',
    de: 'Verbinde…',
    es: 'Conectando…',
  },
  playing: { en: 'Playing', fr: 'Lecture', de: 'Wiedergabe', es: 'Reproduciendo' },
  paused: { en: 'Paused', fr: 'En pause', de: 'Pausiert', es: 'En pausa' },
  stopped: { en: 'Stopped', fr: 'Arrêté', de: 'Gestoppt', es: 'Detenido' },
  volume: { en: 'Volume', fr: 'Volume', de: 'Lautstärke', es: 'Volumen' },
  queue: { en: 'Queue', fr: "File d'attente", de: 'Warteschlange', es: 'Cola' },
  random: { en: 'Random', fr: 'Aléatoire', de: 'Zufall', es: 'Aleatorio' },
  repeat: { en: 'Repeat', fr: 'Répétition', de: 'Wiederholen', es: 'Repetir' },
  on: { en: 'On', fr: 'Oui', de: 'An', es: 'Sí' },
  off: { en: 'Off', fr: 'Non', de: 'Aus', es: 'No' },
  repeatAll: { en: 'All', fr: 'Tout', de: 'Alle', es: 'Todo' },
  repeatOne: { en: 'One song', fr: 'Un morceau', de: 'Ein Titel', es: 'Una canción' },
  previous: { en: 'Previous', fr: 'Précédent', de: 'Zurück', es: 'Anterior' },
  play: { en: 'Play', fr: 'Lecture', de: 'Abspielen', es: 'Reproducir' },
  pause: { en: 'Pause', fr: 'Pause', de: 'Pause', es: 'Pausa' },
  next: { en: 'Next', fr: 'Suivant', de: 'Weiter', es: 'Siguiente' },
  options: { en: 'Options…', fr: 'Options…', de: 'Optionen…', es: 'Opciones…' },
  playlist: { en: 'Playlist', fr: 'Playlist', de: 'Playlist', es: 'Lista de reproducción' },
  keepPlaylist: {
    en: '(keep the queue)',
    fr: '(garder la file)',
    de: '(Warteschlange behalten)',
    es: '(mantener la cola)',
  },
};

// Toast after the options form (≤ 200 characters).
export const DONE_TEXT = {
  en: { done: 'Done.', playlist: (name) => `Playing the playlist "${name}".` },
  fr: { done: 'C’est fait.', playlist: (name) => `Lecture de la playlist « ${name} ».` },
  de: { done: 'Erledigt.', playlist: (name) => `Die Playlist „${name}“ wird abgespielt.` },
  es: { done: 'Hecho.', playlist: (name) => `Reproduciendo la lista «${name}».` },
};

const t = (text, language) => pick(text, language);

function message(text, language) {
  return {
    ttl_seconds: 300,
    components: [{ type: 'text', variant: 'body', text: t(text, language) }],
  };
}

const STATE_ROW = {
  [STATES.PLAY]: { text: TEXT.playing, icon: 'play', color: WIDGET_COLORS.SUCCESS },
  [STATES.PAUSE]: { text: TEXT.paused, icon: 'pause', color: WIDGET_COLORS.WARNING },
  [STATES.STOP]: { text: TEXT.stopped, icon: 'square', color: WIDGET_COLORS.NEUTRAL },
};

const REPEAT_TEXT = { off: TEXT.off, all: TEXT.repeatAll, one: TEXT.repeatOne };

/** The record a widget shows: the device of its settings, or the first player. */
function recordOf(hub, settings) {
  if (settings?.device) {
    return hub.recordOf(settings.device, { quiet: true });
  }
  const [first] = hub.records.values();
  return first ?? null;
}

/** The fields of the "Options…" form, pre-filled with the current values. */
export function optionFields(player) {
  const { status } = player;
  const fields = [];
  if (status.volume !== null) {
    fields.push({
      key: 'volume',
      type: 'number',
      required: true,
      min: 0,
      max: 100,
      default: status.volume,
      label: TEXT.volume,
    });
  }
  const playlists = (player.playlists ?? []).slice(0, MAX_PLAYLISTS);
  if (playlists.length > 0) {
    fields.push({
      key: 'playlist',
      type: 'select',
      required: true,
      default: KEEP_PLAYLIST,
      label: TEXT.playlist,
      options: [
        { value: KEEP_PLAYLIST, label: TEXT.keepPlaylist },
        // A name is the same in every language (field texts need `en`).
        ...playlists.map((name) => ({ value: name, label: { en: fit(name, 60) } })),
      ],
    });
  }
  fields.push(
    {
      key: 'random',
      type: 'boolean',
      default: status.random,
      label: TEXT.random,
    },
    {
      key: 'repeat',
      type: 'select',
      required: true,
      default: repeatMode(status),
      label: TEXT.repeat,
      options: Object.keys(REPEAT_MODES).map((mode) => ({ value: mode, label: REPEAT_TEXT[mode] })),
    },
  );
  return fields;
}

function offline(record, language) {
  const { player } = record;
  const reason = player.error ? (ERROR_TEXT[player.error.kind] ?? ERROR_TEXT.unreachable) : null;
  return {
    ttl_seconds: 60,
    components: [
      { type: 'text', variant: 'heading', text: fit(playerName(record.server), 40) },
      {
        type: 'status',
        items: [
          {
            label: t(reason ? TEXT.unreachable : TEXT.connecting, language),
            icon: reason ? 'alert-triangle' : 'clock',
            value: fit(reason ? t(reason, language) : '…', 40),
            color: reason ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
          },
        ],
      },
    ],
  };
}

/**
 * The content of the widget for one player (pure: tested without network).
 * @param {object} record a hub record
 * @param {string} language
 */
export function buildContent(record, language) {
  const { player } = record;
  if (!player.connected || !player.status) {
    return offline(record, language);
  }
  const { status } = player;
  const { title, subtitle } = describeSong(player.song);
  const playing = status.state === STATES.PLAY;
  const components = [
    {
      type: 'text',
      variant: 'heading',
      text: fit(title ?? t(status.queueLength ? TEXT.nothing : TEXT.emptyQueue, language), 40),
    },
    { type: 'text', variant: 'caption', text: fit(subtitle ?? playerName(record.server), 80) },
  ];
  if (status.volume !== null) {
    components.push({
      type: 'gauge',
      value: status.volume,
      min: 0,
      max: 100,
      unit: '%',
      label: t(TEXT.volume, language),
      color: WIDGET_COLORS.PRIMARY,
    });
  }
  const state = STATE_ROW[status.state];
  const items = [
    {
      label: fit(playerName(record.server), 40),
      icon: state.icon,
      value: t(state.text, language),
      color: state.color,
    },
  ];
  if (status.queueLength > 0) {
    items.push({
      label: t(TEXT.queue, language),
      icon: 'list',
      value:
        status.song === null ? status.queueLength : `${status.song + 1} / ${status.queueLength}`,
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  items.push(
    {
      label: t(TEXT.random, language),
      icon: 'shuffle',
      value: t(status.random ? TEXT.on : TEXT.off, language),
      color: status.random ? WIDGET_COLORS.INFO : WIDGET_COLORS.NEUTRAL,
    },
    {
      label: t(TEXT.repeat, language),
      icon: 'repeat',
      value: t(REPEAT_TEXT[repeatMode(status)], language),
      color: status.repeat ? WIDGET_COLORS.INFO : WIDGET_COLORS.NEUTRAL,
    },
  );
  components.push({ type: 'status', items });
  components.push(
    {
      type: 'button',
      label: t(TEXT.previous, language),
      icon: 'skip-back',
      style: 'secondary',
      action: { key: ACTIONS.PREVIOUS },
    },
    {
      type: 'button',
      label: t(playing ? TEXT.pause : TEXT.play, language),
      icon: playing ? 'pause' : 'play',
      style: 'secondary',
      action: { key: ACTIONS.TOGGLE },
    },
    {
      type: 'button',
      label: t(TEXT.next, language),
      icon: 'skip-forward',
      style: 'secondary',
      action: { key: ACTIONS.NEXT },
    },
    {
      type: 'button',
      label: t(TEXT.options, language),
      icon: 'sliders',
      style: 'secondary',
      action: { key: ACTIONS.OPTIONS, fields: optionFields(player) },
    },
  );
  // Refreshed by a nudge at each change; the ttl only catches a lost one.
  return { ttl_seconds: 120, components };
}

async function get(hub, { settings, language = 'en' }) {
  if (hub.records.size === 0) {
    return message(TEXT.configure, language);
  }
  const record = recordOf(hub, settings);
  if (!record) {
    return message(TEXT.unknown, language);
  }
  return buildContent(record, language);
}

async function action(hub, { actionKey, settings, values }) {
  const record = recordOf(hub, settings);
  if (!record) {
    throw new UserError(
      hub.records.size === 0 ? ACTION_TEXT.noPlayer : ACTION_TEXT.unknownPlayer,
      hub.language,
    );
  }
  switch (actionKey) {
    case ACTIONS.PREVIOUS:
      await hub.command(record, 'previous track (widget)', (player) => player.previous());
      return undefined;
    case ACTIONS.NEXT:
      await hub.command(record, 'next track (widget)', (player) => player.next());
      return undefined;
    case ACTIONS.TOGGLE:
      // The state at the tap decides, not the one of a card drawn earlier.
      await hub.command(record, 'play/pause (widget)', (player) => player.toggle());
      return undefined;
    case ACTIONS.OPTIONS:
      return applyOptions(hub, record, values);
    default:
      throw new Error(`Unknown action ${actionKey}`);
  }
}

/** The "Options…" form: only what differs from the current state is sent. */
async function applyOptions(hub, record, values) {
  if (!values || typeof values !== 'object') {
    // A Gladys older than 5.2.0 relays the tap without the form.
    throw new UserError(TEXT.updateGladys, hub.language);
  }
  const { status } = record.player;
  if (status && Number.isFinite(Number(values.volume)) && values.volume !== null) {
    const volume = Math.round(Number(values.volume));
    if (status.volume !== null && volume !== status.volume) {
      await hub.setVolume(record, volume);
    }
  }
  if (typeof values.random === 'boolean' && status && values.random !== status.random) {
    await hub.command(record, `random ${values.random ? 'on' : 'off'} (widget)`, (player) =>
      player.setRandom(values.random),
    );
  }
  if (REPEAT_MODES[values.repeat] && status && values.repeat !== repeatMode(status)) {
    await hub.command(record, `repeat ${values.repeat} (widget)`, (player) =>
      player.setRepeat(values.repeat),
    );
  }
  if (typeof values.playlist === 'string' && values.playlist !== KEEP_PLAYLIST) {
    const { name } = await hub.playPlaylist(record, values.playlist);
    return {
      message: Object.fromEntries(
        Object.entries(DONE_TEXT).map(([lang, text]) => [lang, text.playlist(name)]),
      ),
    };
  }
  return {
    message: Object.fromEntries(Object.entries(DONE_TEXT).map(([lang, text]) => [lang, text.done])),
  };
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
