// -----------------------------------------------------------------------------
// The `player` dashboard widget: its content fits the vocabulary and the
// budget of the core (validateWidgetContent of the SDK), says what plays,
// and its buttons and form drive the player.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { ACTIONS, KEEP_PLAYLIST } from '../src/widgets.js';
import {
  FakeMpd,
  LIBRARY,
  RADIO,
  createWorld,
  deviceId,
  eventually,
  settle,
} from './helpers/world.js';

const [ONE_MORE_TIME, AERODYNAMIC] = Object.keys(LIBRARY);

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.stop());
  return w;
}

async function content(w, settings = {}, language = 'en') {
  const ack = await w.fake.widgetGet('player', { settings, language });
  assert.equal(ack.success, true, ack.error);
  const { content: body } = ack.data;
  assert.deepEqual(validateWidgetContent(body), [], 'rendered exactly as sent');
  return body;
}

const ofType = (body, type) => body.components.filter((c) => c.type === type);

test('what plays: title, artist · album, volume, state, queue, buttons', async (t) => {
  const w = await world(t);
  w.mpd.enqueue(ONE_MORE_TIME, AERODYNAMIC);
  w.mpd.commands.play();
  w.mpd.commands.random('1');
  await settle();
  const body = await content(w);
  const [heading, caption] = ofType(body, 'text');
  assert.equal(heading.text, 'One More Time');
  assert.equal(caption.text, 'Daft Punk · Discovery');
  assert.equal(ofType(body, 'gauge')[0].value, 40);
  const [status] = ofType(body, 'status');
  assert.deepEqual(
    status.items.map((item) => [item.label, item.value]),
    [
      ['Salon', 'Playing'],
      ['Queue', '1 / 2'],
      ['Random', 'On'],
      ['Repeat', 'Off'],
    ],
  );
  const buttons = ofType(body, 'button');
  assert.deepEqual(
    buttons.map((button) => button.action.key),
    [ACTIONS.PREVIOUS, ACTIONS.TOGGLE, ACTIONS.NEXT, ACTIONS.OPTIONS],
  );
  assert.equal(buttons[1].label, 'Pause');
  assert.ok(
    buttons.every((button) => button.style !== 'primary'),
    'primary is invisible in dark mode',
  );
});

test('a web radio shows its title and station, in French', async (t) => {
  const w = await world(t);
  w.mpd.enqueue(RADIO);
  w.mpd.commands.play();
  await settle();
  const body = await content(w, {}, 'fr');
  const [heading, caption] = ofType(body, 'text');
  assert.equal(heading.text, 'Some Artist - Some Song');
  assert.equal(caption.text, 'Example Radio');
  assert.equal(ofType(body, 'status')[0].items[0].value, 'Lecture');
});

test('an empty queue, a player without mixer: no gauge, no form volume', async (t) => {
  const w = await world(t, { servers: [new FakeMpd({ volume: null, playlists: {} })] });
  const body = await content(w);
  assert.equal(ofType(body, 'text')[0].text, 'The queue is empty');
  assert.equal(ofType(body, 'gauge').length, 0);
  const form = ofType(body, 'button').at(-1).action.fields;
  assert.deepEqual(
    form.map((field) => field.key),
    ['random', 'repeat'],
  );
});

test('the options form is pre-filled with the current values', async (t) => {
  const w = await world(t);
  w.mpd.commands.repeat('1');
  w.mpd.commands.single('1');
  await settle();
  const form = ofType(await content(w), 'button').at(-1).action.fields;
  const byKey = Object.fromEntries(form.map((field) => [field.key, field]));
  assert.equal(byKey.volume.default, 40);
  assert.equal(byKey.playlist.default, KEEP_PLAYLIST);
  assert.deepEqual(
    byKey.playlist.options.map((option) => option.value),
    [KEEP_PLAYLIST, 'Apéro', 'Morning jazz'],
  );
  assert.equal(byKey.random.default, false);
  assert.equal(byKey.repeat.default, 'one');
});

test('the buttons drive the player; play/pause follows the state at the tap', async (t) => {
  const w = await world(t);
  w.mpd.enqueue(ONE_MORE_TIME, AERODYNAMIC);
  const tap = async (key, values) => {
    const ack = await w.fake.widgetAction('player', key, {}, { settings: {}, values });
    assert.equal(ack.success, true, ack.error);
    return ack;
  };
  await tap(ACTIONS.TOGGLE);
  assert.equal(w.mpd.state, 'play');
  await tap(ACTIONS.NEXT);
  assert.equal(w.mpd.current, 1);
  await tap(ACTIONS.PREVIOUS);
  assert.equal(w.mpd.current, 0);
  // Paused by someone else since the card was drawn: the tap plays.
  w.mpd.commands.pause('1');
  await settle();
  await tap(ACTIONS.TOGGLE);
  assert.equal(w.mpd.state, 'play');

  const ack = await tap(ACTIONS.OPTIONS, {
    volume: 55,
    playlist: 'Morning jazz',
    random: true,
    repeat: 'all',
  });
  assert.equal(w.mpd.volume, 55);
  assert.equal(w.mpd.random, true);
  assert.equal(w.mpd.repeat, true);
  assert.deepEqual(
    w.mpd.queue.map((song) => song.file),
    ['Untagged/track07.mp3'],
  );
  assert.match(ack.data.message.en, /Morning jazz/);

  // Nothing changed in the form: nothing sent.
  const before = w.mpd.log.length;
  await tap(ACTIONS.OPTIONS, { volume: 55, playlist: KEEP_PLAYLIST, random: true, repeat: 'all' });
  assert.equal(
    w.mpd.log.filter(([name]) => name !== 'status' && name !== 'currentsong' && name !== 'idle')
      .length,
    w.mpd.log
      .slice(0, before)
      .filter(([name]) => name !== 'status' && name !== 'currentsong' && name !== 'idle').length,
  );
});

test('a Gladys older than 5.2.0 sends the form tap without values: it says so', async (t) => {
  const w = await world(t);
  const ack = await w.fake.widgetAction('player', ACTIONS.OPTIONS, {}, { settings: {} });
  assert.equal(ack.success, false);
  assert.match(ack.error, /5\.2\.0/);
});

test('the widget follows the player chosen in its settings, and says when it is gone', async (t) => {
  const w = await world(t, { servers: [new FakeMpd(), new FakeMpd({ volume: 77 })] });
  const second = await content(w, { device: deviceId(w.gladys, 2) });
  assert.equal(ofType(second, 'gauge')[0].value, 77);
  const gone = await content(w, { device: deviceId(w.gladys, 4) });
  assert.match(gone.components[0].text, /no longer in the configuration/);
});

test('an unreachable player is said, without buttons', async (t) => {
  const w = await world(t);
  await w.mpd.goOffline();
  await eventually(() => !w.hub.records.get(1).player.connected);
  const body = await content(w);
  assert.equal(ofType(body, 'button').length, 0);
  assert.equal(ofType(body, 'status')[0].items[0].value, 'does not answer');
});

test('no player configured: the widget says what to do', async (t) => {
  const w = await world(t, { servers: [] });
  const body = await content(w);
  assert.match(body.components[0].text, /Enter the address of your MPD player/);
});

test('a change on the player asks Gladys to refresh the widget, at most every 10 s', async (t) => {
  const w = await world(t);
  const nudges = () => w.fake.widgetRefreshes.length;
  const before = nudges();
  w.mpd.commands.setvol('20');
  await settle(100);
  w.mpd.commands.setvol('21');
  await settle(100);
  assert.ok(nudges() - before <= 1, `${nudges() - before} refreshes asked`);
});
