// The save model the engine client keeps (js/platform/store.js): the browser
// build's checksummed cloud document (the foreign game:<slug> slot) reads back
// through migrateSave, and two devices' saves merge without losing progress.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateSave, mergeSaves } from '../js/platform/store.js';

const old = { version: 1, journey: { unlocked: 5, passed: { j01: 900, j02: 1100 }, crowns: {} }, lessonsDone: { 'lesson-1': true }, challengesDone: {},
  daily: { '2026-10-01': 1200 }, achievements: { first_finish: 5 }, stats: { races: 9, finishes: 6, qualifies: 4, showsWon: 0, bestStreak: 2 },
  settings: { palette: 'tritanopia', camera: 'far', music: 0.2 }, updatedAt: 100, checksum: 'abcd1234' };

test('the browser build\'s checksummed document migrates (checksum dropped, defaults filled)', () => {
  const d = migrateSave(JSON.parse(JSON.stringify(old)));
  assert.equal(d.checksum, undefined);
  assert.equal(d.journey.unlocked, 5);
  assert.equal(d.settings.palette, 'tritanopia');
  assert.equal(d.settings.cameraShake, true);
});
test('merging keeps both sides\' progress', () => {
  const mine = migrateSave({ journey: { unlocked: 2, passed: { j01: 1000 }, crowns: {} }, lessonsDone: { 'lesson-2': true }, daily: { '2026-10-02': 800 },
    achievements: { first_finish: 9, long_haul: 20 }, stats: { races: 3, finishes: 50, qualifies: 1, showsWon: 1, bestStreak: 1 }, updatedAt: 200 });
  const m = mergeSaves(old, mine);
  assert.equal(m.journey.unlocked, 5);
  assert.deepEqual(m.journey.passed, { j01: 1000, j02: 1100 });
  assert.deepEqual(Object.keys(m.lessonsDone).sort(), ['lesson-1', 'lesson-2']);
  assert.equal(m.achievements.first_finish, 5);
  assert.equal(m.achievements.long_haul, 20);
  assert.equal(m.stats.races, 9);
  assert.equal(m.stats.finishes, 50);
  assert.equal(Object.keys(m.daily).length, 2);
});
