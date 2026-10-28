// Every string key used in markup (data-i18n*) and code (t('…')) exists in all
// nine locales with the same {placeholders} as US English, every locale has
// exactly the US English keys, and every content name (stages, themes,
// arenas, show courses, shows, lessons and their steps, challenges,
// mechanics, achievements) is translated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { STRINGS } from '../js/ui/strings.js';
import { JOURNEY, LESSONS, CHALLENGES, SHOWS, ARENAS, SHOW_COURSES } from '../js/content/stages.js';
import { ACHIEVEMENTS } from '../js/content/achievements.js';

const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const root = new URL('../', import.meta.url);
// The client's code: native/*.ts (keys as t("key") calls, plus keys passed through helpers and lookup tables).
const code = readdirSync(new URL('native/', root)).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(new URL('native/' + f, root), 'utf8')).join('\n');
const en = STRINGS['en-US'];
const used = new Set();
for (const m of code.matchAll(/\bt\("([A-Za-z0-9]+)"/g)) used.add(m[1]);
for (const m of code.matchAll(/"([a-z][A-Za-z0-9]+)"/g)) if (typeof en[m[1]] === 'string') used.add(m[1]);
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('ships the nine locales', () => assert.deepEqual(Object.keys(STRINGS).sort(), [...LOCALES].sort()));
test('every locale has exactly the US English keys', () => {
  for (const loc of LOCALES) assert.deepEqual(Object.keys(STRINGS[loc]).sort(), Object.keys(en).sort(), loc);
});
test('found the keys in markup and code', () => assert.ok(used.size > 150, String(used.size)));
for (const loc of LOCALES) {
  test(`${loc}: every used key, matching placeholders`, () => {
    const L = STRINGS[loc];
    assert.deepEqual([...used].filter((k) => typeof L[k] !== 'string'), []);
    for (const k of Object.keys(en)) if (typeof en[k] === 'string') assert.equal(vars(L[k]), vars(en[k]), `${loc}.${k}`);
  });
  test(`${loc}: every content name`, () => {
    const L = STRINGS[loc];
    for (const s of JOURNEY) assert.ok(L.stages[s.id], `stage ${s.id}`);
    for (const id of new Set(JOURNEY.map((s) => s.theme))) assert.ok(L.themes[id], `theme ${id}`);
    for (const a of ARENAS) assert.ok(L.arenas[a.id], `arena ${a.id}`);
    for (const c of SHOW_COURSES) assert.ok(L.showCourses[c.id], `show course ${c.id}`);
    for (const s of SHOWS) assert.ok(L.shows[s.id], `show ${s.id}`);
    for (const l of LESSONS) {
      assert.ok(L.lessons[l.id] && L.lessonText[l.id], `lesson ${l.id}`);
      for (const st of l.steps) assert.equal(vars(L.lessonText[l.id + '.' + st.id]), vars(st.text), `step ${l.id}.${st.id}`);
    }
    for (const c of CHALLENGES) assert.ok(L.challenges[c.id] && L.challengeDesc[c.id], `challenge ${c.id}`);
    for (const s of JOURNEY) for (const m of s.mechanics) assert.ok(L.mechanics[m], `mechanic ${m}`);
    for (const k of Object.keys(ACHIEVEMENTS)) assert.equal(L.achievements[k]?.length, 2, `achievement ${k}`);
  });
}
test('English content strings match the authored data', () => {
  for (const s of JOURNEY) assert.equal(en.stages[s.id], s.name);
  for (const l of LESSONS) {
    assert.equal(en.lessons[l.id], l.title);
    assert.equal(en.lessonText[l.id], l.intro);
    for (const st of l.steps) assert.equal(en.lessonText[l.id + '.' + st.id], st.text);
  }
  for (const c of CHALLENGES) assert.deepEqual([en.challenges[c.id], en.challengeDesc[c.id]], [c.name, c.desc]);
  for (const [k, a] of Object.entries(ACHIEVEMENTS)) assert.deepEqual(en.achievements[k], [a.name, a.desc]);
});
test('non-English locales are translated', () => {
  for (const loc of LOCALES.filter((l) => !l.startsWith('en'))) {
    const same = [...used].filter((k) => STRINGS[loc][k] === en[k]);
    assert.ok(same.length < 15, `${loc}: ${same.join(', ')}`);
  }
});
