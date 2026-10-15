// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, the "Test the connection" report, the scene
// action errors. Four languages, the four of the Gladys interface; German says
// "du", Spanish "usted". test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './mpd/protocol.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noPlayer: {
    en: 'Enter the address of your MPD player in the configuration.',
    fr: "Saisissez l'adresse de votre lecteur MPD dans la configuration.",
    de: 'Gib die Adresse deines MPD-Players in der Konfiguration ein.',
    es: 'Introduzca la dirección de su reproductor MPD en la configuración.',
  },
  invalidAddress: {
    en: 'Address not understood, e.g. 192.168.1.20 or 192.168.1.20:6600',
    fr: 'Adresse incomprise, ex. 192.168.1.20 ou 192.168.1.20:6600',
    de: 'Adresse nicht verstanden, z. B. 192.168.1.20 oder 192.168.1.20:6600',
    es: 'Dirección no válida, p. ej. 192.168.1.20 o 192.168.1.20:6600',
  },
  connecting: {
    en: 'connecting…',
    fr: 'connexion…',
    de: 'verbinde…',
    es: 'conectando…',
  },
};

// One short explanation per error kind (src/mpd/protocol.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'does not answer',
    fr: 'ne répond pas',
    de: 'antwortet nicht',
    es: 'no responde',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'password refused',
    fr: 'mot de passe refusé',
    de: 'Passwort abgelehnt',
    es: 'contraseña rechazada',
  },
  [ERROR_KINDS.PERMISSION]: {
    en: 'a password is needed (or it lacks the read and control rights)',
    fr: 'un mot de passe est nécessaire (ou il manque les droits read et control)',
    de: 'ein Passwort ist nötig (oder ihm fehlen die Rechte read und control)',
    es: 'se necesita una contraseña (o le faltan los permisos read y control)',
  },
  [ERROR_KINDS.NOT_MPD]: {
    en: 'no MPD server at this address and port',
    fr: 'aucun serveur MPD à cette adresse et ce port',
    de: 'kein MPD-Server unter dieser Adresse und diesem Port',
    es: 'no hay ningún servidor MPD en esta dirección y puerto',
  },
  [ERROR_KINDS.COMMAND]: {
    en: 'command refused, see the logs',
    fr: 'commande refusée, voir les logs',
    de: 'Befehl abgelehnt, sieh in den Protokollen nach',
    es: 'orden rechazada, consulte los registros',
  },
};

// The "Test the connection" report, one line per player.
export const REPORT_TEXT = {
  en: {
    playing: 'playing',
    paused: 'paused',
    stopped: 'stopped',
    volume: (volume) => `volume ${volume} %`,
    noVolume: 'no volume control',
    playlists: (count) => `${count} playlist(s)`,
  },
  fr: {
    playing: 'en lecture',
    paused: 'en pause',
    stopped: 'arrêté',
    volume: (volume) => `volume ${volume} %`,
    noVolume: 'pas de réglage du volume',
    playlists: (count) => `${count} playlist(s)`,
  },
  de: {
    playing: 'spielt',
    paused: 'pausiert',
    stopped: 'gestoppt',
    volume: (volume) => `Lautstärke ${volume} %`,
    noVolume: 'keine Lautstärkeregelung',
    playlists: (count) => `${count} Playlist(s)`,
  },
  es: {
    playing: 'reproduciendo',
    paused: 'en pausa',
    stopped: 'detenido',
    volume: (volume) => `volumen ${volume} %`,
    noVolume: 'sin control de volumen',
    playlists: (count) => `${count} lista(s) de reproducción`,
  },
};

// Errors of the scene actions, the device commands and the widget buttons.
export const ACTION_TEXT = {
  noPlayer: {
    en: 'No MPD player is configured.',
    fr: "Aucun lecteur MPD n'est configuré.",
    de: 'Kein MPD-Player ist konfiguriert.',
    es: 'No hay ningún reproductor MPD configurado.',
  },
  unknownPlayer: {
    en: 'This player is no longer in the configuration.',
    fr: "Ce lecteur n'est plus dans la configuration.",
    de: 'Dieser Player ist nicht mehr in der Konfiguration.',
    es: 'Este reproductor ya no está en la configuración.',
  },
  unreachable: {
    en: 'The player does not answer.',
    fr: 'Le lecteur ne répond pas.',
    de: 'Der Player antwortet nicht.',
    es: 'El reproductor no responde.',
  },
  invalidUri: {
    en: 'Give a web address (http:// or https://) or a path of the MPD music library.',
    fr: 'Indiquez une adresse web (http:// ou https://) ou un chemin de la bibliothèque musicale de MPD.',
    de: 'Gib eine Webadresse (http:// oder https://) oder einen Pfad der MPD-Musikbibliothek an.',
    es: 'Indique una dirección web (http:// o https://) o una ruta de la biblioteca musical de MPD.',
  },
  notStarted: {
    en: 'MPD could not play this address.',
    fr: "MPD n'a pas pu lire cette adresse.",
    de: 'MPD konnte diese Adresse nicht abspielen.',
    es: 'MPD no ha podido reproducir esta dirección.',
  },
  noVolume: {
    en: 'This player has no volume control (no mixer in MPD).',
    fr: "Ce lecteur n'a pas de réglage du volume (pas de mixer dans MPD).",
    de: 'Dieser Player hat keine Lautstärkeregelung (kein Mixer in MPD).',
    es: 'Este reproductor no tiene control de volumen (sin mezclador en MPD).',
  },
  noPlaylistName: {
    en: 'Give the name of a playlist saved in MPD.',
    fr: "Indiquez le nom d'une playlist enregistrée dans MPD.",
    de: 'Gib den Namen einer in MPD gespeicherten Playlist an.',
    es: 'Indique el nombre de una lista de reproducción guardada en MPD.',
  },
  refused: {
    en: 'MPD refused the command, see the logs of the integration.',
    fr: "MPD a refusé la commande, voir les logs de l'intégration.",
    de: 'MPD hat den Befehl abgelehnt, sieh in den Protokollen der Integration nach.',
    es: 'MPD ha rechazado la orden, consulte los registros de la integración.',
  },
};

// Messages with a value in them.
export const MESSAGES = {
  en: {
    playlistNotFound: (name, names) =>
      `No playlist "${name}" in MPD.${names ? ` Playlists: ${names}` : ''}`,
  },
  fr: {
    playlistNotFound: (name, names) =>
      `Aucune playlist « ${name} » dans MPD.${names ? ` Playlists : ${names}` : ''}`,
  },
  de: {
    playlistNotFound: (name, names) =>
      `Keine Playlist „${name}“ in MPD.${names ? ` Playlists: ${names}` : ''}`,
  },
  es: {
    playlistNotFound: (name, names) =>
      `No hay ninguna lista «${name}» en MPD.${names ? ` Listas: ${names}` : ''}`,
  },
};

export const LANGUAGE_FALLBACK = 'en';

/** "Name: text", with the space French puts before a colon. */
export const labelled = (name, text, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${text}`;
export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];

/** Shorten to `max` characters, with an ellipsis. */
export const fit = (text, max) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/**
 * An error a user can read, in one language: the texts of this file thrown
 * as a plain Error message (Gladys shows the message of a failed command).
 */
export class UserError extends Error {
  /**
   * @param {Record<string, string>} text multi-language text
   * @param {string} language
   */
  constructor(text, language) {
    super(fit(pick(text, language), 200));
    this.name = 'UserError';
    this.text = text;
  }
}

/** Remove what must never reach a log or a message: credentials in URLs. */
export function safeText(text) {
  return String(text ?? '').replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1');
}
