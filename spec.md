# Tumble Circuit — Product and Game Specification

**Document status:** running specification of the game as shipped on the StarHermit engine (1.28.0, host API minor 30).  
**Game index:** 100  
**Genre:** Realtime obstacle race  
**Players:** 2–32 players as specified by playlist  
**Targets:** desktop browsers, mobile browsers, landscape and portrait where practical  
**Rendering direction:** `starhermit:scene` 3D arena with an immediate-mode `starhermit:ui` interface layer

## 1. Product vision

Tumble Circuit is a game in which players race through short obstacle courses, survive eliminations, and reach the final round. Its signature setting is a colorful sky arena of oversized kinetic obstacles. The product should feel immediately understandable, responsive within one input, and polished enough that the board or playfield itself is the visual hero. Sessions should begin quickly, make the next useful action obvious without solving the game for the player, and end with a clear explanation of score and progress.

The experience must be original. Do not copy names, layouts, characters, iconography, writing, audio, progression maps, or level data from an existing title. Use an original visual language, original procedural assets, and internally authored content.

### Design pillars

1. **Readable before spectacular:** legal actions, hazards, selection, ownership, and goals remain legible with effects disabled.
2. **One-input confidence:** every press, tap, drag, key, or pointer action gives immediate visual and sonic acknowledgment.
3. **Short path to play:** a returning player reaches the primary playfield in at most two deliberate actions.
4. **Fair mastery:** randomness is seeded and inspectable; outcomes never depend on hidden purchases or invisible stat boosts.
5. **Scalable beauty:** the same art direction survives low-power mobile hardware and high-resolution desktop displays.

## 2. Core game design

### Objective and rules contract

Race through short obstacle courses, survive eliminations, and reach the final round.

The rules engine must represent legal actions independently from rendering. It must expose legal-action queries, deterministic resolution, serializable state, a monotonically increasing turn/tick number, and a terminal-state reason. Tutorials and hints call the same legal-action API used by play rather than duplicating rules.

### Core loop

The repeated loop is: **run, jump, dive, recover, pass checkpoints, and qualify before the cutoff**. Input is locked only during the shortest non-interruptible resolution phase. Cosmetic animation may continue after the logical state is ready, but skip/fast-forward must settle every object into the exact deterministic end state.

### Scoring and victory

Authoritative checkpoints determine qualification; finals use finish order or survival time. Results show a component breakdown rather than one unexplained total. Store integers for score and simulation units; format values only in presentation. Ties use, in order: primary objective completion, fewer invalid actions, lower authoritative elapsed time, then stable session identifier.

### Modes

- **Learn:** interactive lessons introduce one rule at a time and require the player to perform the action.
- **Journey:** authored progression with gradually combined mechanics and periodic mastery stages.
- **Daily:** one shared seed and ruleset per UTC day, synchronized to platform time.
- **Practice:** selectable difficulty, restart, undo where rules permit, and no effect on competitive rating.
- **Challenge:** constrained goals such as move limits, speed targets, altered layouts, or restricted tools.
- **Show:** elimination rounds against AI racers (Quick Show 12, Grand Circuit 16) ending in a survival-arena final.
- **Hosted play:** not available. The browser build ran rooms only on its own dev server (custom `/ws`), never on StarHermit; the Modes card stays disabled with "not available on this platform", as it was on-platform.

### Difficulty and content generation

- Represent content as versioned data: identifier, seed, initial state, goals, allowed mechanics, par values, tutorial flags, and presentation theme.
- Run offline validators to prove basic legality, reachable goals, bounded duration, and absence of soft locks. Logic puzzles additionally require a unique or explicitly accepted solution class.
- Difficulty is measured from solution depth, branching factor, time pressure, motor precision, hidden information, and recovery options—not merely larger numbers.
- Introduce one new concept in isolation, combine it with one known concept, then test mastery before adding another.
- Daily seeds are immutable after publication. If content is defective, mark the day excluded from ranking rather than silently replacing it.
- Daily generation is validated before publication: from 2026-10-07 (`DAILY_REROLL_FROM`) each day's course must pass the offline probe bot, otherwise the generator deterministically re-rolls with a salted seed (`tumble-daily-<date>#k`, up to 8 candidates), so every client still gets the same course. Days before the cutoff keep their original derivation. This changed five not-yet-published 2027 dailies (01-08, 02-21, 05-25, 07-01, 09-02); every other day from 2026-09-07 to 2027-10-07 is unchanged. `npm test` checks every daily from 30 days back to 365 days ahead. Because acceptance depends on the bot and sim, any bot/sim change must keep already-published days unchanged.

### Game-state model

`boot → title → profile-ready → mode-select → preparing → tutorial/countdown → active ↔ paused/reconnecting → resolving → results → progression`.

Every transition has one owner and an explicit reason. Backgrounding pauses solo simulation. In hosted play, the authoritative clock continues where rules require it, while the returning client receives a fresh snapshot and a concise “while you were away” summary.

## 3. Interaction and user-interface design

### Information hierarchy

1. **Primary:** playfield, current objective, legal interaction target, and immediate danger or turn state.
2. **Secondary:** score/progress, remaining moves or time, opponent/party status where applicable.
3. **Tertiary:** settings, social controls, cosmetics, help, and history.

The Three.js canvas fills the game region but is never the only UI. Menus, text, forms, chat, settings, and assistive descriptions use semantic HTML over or beside the canvas. Maintain a single shared layout model so DOM labels align with projected Three.js targets.

### Responsive layouts

- **Wide desktop (≥1024 CSS px):** centered playfield, objective/progression rail on the left, contextual actions and social/status rail on the right. Maximum line length is 70 characters.
- **Compact desktop/tablet:** playfield remains central; secondary rails collapse into drawers. Pointer hover may preview but never be required.
- **Portrait mobile:** top safe-area status bar, square or perspective-fit playfield, bottom thumb-zone action tray, and sheet-based secondary panels. Never place critical controls under browser chrome or display cutouts.
- **Landscape mobile:** reserve a narrow status rail; preserve at least 44×44 CSS-pixel targets and 8-pixel separation.
- **Large screens (above 1600×1000):** the shared `ui-scale.js` sets `--ui-scale` (`min(w/1600, h/1000)`, max 2.5) and every DOM layer of the app (HUD, lesson banner, countdown, touch controls, screens, captions, toasts) is zoomed by it while the full-viewport 3D canvas stays unzoomed, so 2K–4K and ultrawide monitors show the 1600×1000 layout magnified. Screens open scrolled to their top.
- React to resize, orientation, device-pixel-ratio, safe-area insets, virtual keyboard, and visibility changes without losing input or restarting the round.

### Screens and overlays

- **Title/home:** Play is dominant; daily challenge, journey progress, and profile are one level below.
- **Mode setup:** show rules, expected duration, player count, assists, and whether the result is ranked before commitment.
- **Play HUD:** objective, progress, current actor/state, pause, and only context-relevant actions.
- **Pause/settings:** resume first; audio, graphics, controls, accessibility, help, and leave are clearly separated.
- **Results:** outcome headline, score breakdown, progress, achievements, comparison, replay/retry, and next recommended action.
- **Help:** visual rule cards generated from current control mappings and representative legal states.
- Lobby, roster, readiness, invitation, reconnect, result, and report states are first-class screens.

### Input

- Pointer/touch: raycast only against explicit interaction layers; use pointer capture for drags; cancel safely on lost capture.
- Touch: distinguish tap, drag, and camera gesture by distance/time thresholds; never require multi-touch for core play. During a round the runtime draws a movement stick (bottom left; bottom right with left-handed touch controls) and Jump / Dive buttons on the other side; the title shows touch instructions on touch devices. The lesson banner sits below the measured HUD and carries the instruction once (the HUD shows a short goal line).
- Keyboard: directional navigation among legal targets, confirm, cancel, pause, undo/hint where valid, and camera reset.
- Gamepad: focus navigation, primary/secondary actions, pause, and remappable axes/buttons.
- Prevent accidental double commits with action identifiers, not arbitrary long debounce timers. Provide visible drag origin, target preview, and invalid-action explanation.

### Accessibility

- Full keyboard operation and visible focus; DOM equivalents for canvas controls; headings and live regions for objective, turn, score, errors, and results.
- Color is reinforced by shape, texture, icon, or label. Include contrast-safe and common color-vision palettes.
- Reduced-motion mode removes camera swoops, shake, parallax, rapid particles, and large scaling while preserving event timing.
- Independent sliders for music, effects, ambience, and voice; captions/text cues for meaningful audio; no audio-only gameplay.
- Options for larger text, high contrast, left-handed controls, hold-versus-toggle, timing assistance, haptics off, and tutorial replay.
- Announce Three.js board state through a concise navigable model rather than describing every decorative object.

## 4. Visual and audio design

### Visual contract

The subject is the active playfield at near-tabletop to room scale, framed so state changes occupy most of the screen. The scene is a colorful sky arena of oversized kinetic obstacles. Use an authored camera, original procedural geometry, restrained environmental storytelling, and a deterministic visual seed. The no-post-processing baseline must still communicate hierarchy, depth, selection, and state.

### Scene (native/render.ts)

The arena is drawn on `starhermit:scene`, a port of the browser build's three.js r160 `js/render/scene.js`: the gradient sky dome (a WGSL `ShaderMaterial`; sun glow and drifting high haze when detailed), exponential fog, a hemisphere fill and the key sun whose PCF shadow box (bias −0.0004, normal bias 0.03) is fitted around the followed racer and snapped to whole texels; platform slabs (tiled tops, striped sides, raised rim trim), the finish pad, arena discs, movers with lane hints, spinners, pendulums, pistons, bumpers, weave walls, bounce pads, conveyor arrows, fan streams, checkpoint rings and the chequered finish gate; decor (jittered rock islands, cumulus clouds, stars, balloons, kites, aurora ribbons, light motes); racers (capsule body, face marker, grounded ring, name sprite) with squash and stretch; burst particles; the critically damped follow camera (Follow or Far) with optional shake; the title backdrop pans over Ridge Run. Engine minor 23 follows three r155+ light units and three's shadows, so the page's own light intensities and shadow values are used unchanged. Reflections use a `RoomEnvironment(renderer)` PMREM (sigma 0.04) given to each lit material as its own `envMap` at the old per-material `envMapIntensity` (r160 applied those to the scene environment; the engine, like r163+, does not); with reflections the hemisphere fill halves, as before. ACES tone mapping, exposure 1.05.

Post effects are the runtime's: GTAO (`renderer.ao`), bloom, a display-space colour grade with vignette and SMAA / FXAA / MSAA. **Difference:** the old bloom read a glow-only render (rings, gate, pads, sparkles, motes); the runtime's bloom has no per-object mask, so its threshold (1.25) sits above sunlit platforms instead; at minor 30 the bloom takes model "r160" at the page strength 0.4.

### Graphics tiers (native/quality.ts)

The runtime's quality tier picks the browser build's preset rows and budgets (`js/render/gfx.js`): Low (Lambert, no shadows, no post, MSAA, plain surfaces, static background), Balanced (Standard, 1024² shadows, bloom, grade, FXAA, reflections, detailed surfaces), High (Physical clear-coat, 2048², AO, SMAA), Ultra (4096², high AO, MSAA, 1.5× segments, 512 px textures). Burst sparks scale with the hardware level within a tier (≤ 2×). Auto, render scale, adaptive resolution, the frame-rate limit and readout are the runtime's Options; the old per-category overrides are not offered.

### Audio (native/audio.ts)

The authored one-shots (`sfx/*.opus`) per game event, the 2 s low-passed noise ambience bed at the theme's cutoff (looped on the music bus, the runtime has no ambience bus) and the seeded per-theme arpeggio music, rendered once per theme into clips and stepped on the fixed-step clock. The synthesized fallbacks played while a sample loaded are not ported. Volumes and mute are the runtime's Options. Captions ("♪ …", 1.4 s) follow the game's Captions setting.

## 5. Technical architecture

- `starhermit.txt`: `engine.entry=native/main.ts`, `engine.version=1.28.0`, `engine.minor=30`, capabilities `platform,storage,clipboard`; actions `left right forward back jump dive pause` with keyboard and gamepad defaults (left stick / D-pad run, South jumps, East/West dive, Start pauses).
- `js/rules`, `js/content`, `js/session/round.js`, `js/rules/show.js`, `js/platform/store.js`: the browser build's pure modules, shared with the node tests (only change: a JSON clone instead of `structuredClone` in `daily.js`).
- `native/main.ts`: round lifecycle — one 60 Hz rules tick per fixed step (deterministic), the 3-2-1 countdown, input sampled into the round each step, pause / resume / retry / leave, lessons, Journey, Daily, Practice, Challenges, Shows, results, achievements, leaderboard posting, announcements.
- `native/work.ts` + `native/work-worker.js`: a `starhermit:script` worker for the Daily's validated course (the offline probe bot, up to eight candidates) and the results screen's replay check (the round re-simulated); the panel shows "Preparing today's course…" / "Replay integrity: checking…" meanwhile. Without a worker the job runs on the game thread.
- `native/screens.ts` (UI), `native/style.ts` + `tools/ui-style.css` → `assets/ui-style.json` (`npm run css`), `native/i18n.ts`, `native/platform.ts`.

### Localization

All strings live in `js/ui/strings.js` (nine locales: en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT) and `js/ui/platformStrings.js`, in the runtime's interface language (Options › Language, else the account's or device's). A change shows on the next frame; the local racer's default name "You" and its name sprite relabel.

### Determinism and replay

Every course is seeded; the sim runs on fixed steps with deterministic math, identical natively, on the web and in node (the play scripts rely on it). Each round records a replay envelope; the results screen re-runs it on the worker and shows "Replay integrity: verified deterministic" (a local self-check, not a server validation).

## 6. StarHermit integration

- Save: `starhermit:storage` saves (schema 1) hold the browser build's progression document (journey, lessons, challenges, dailies, achievements, stats); conflicts merge with `mergeSaves`. The browser build's cloud slot (`game:<slug>`, the checksummed document) is read as the foreign save, merged in and replaced once; its palette / camera / shake / captions / left-handed values are adopted.
- Game options (engine settings, synced): colour palette, camera (follow / far), camera shake, captions, left-handed touch controls. The old settings-KV keys are adopted when unset, then removed. Volumes, graphics, language, reduced motion, high contrast and text size are the runtime's Options (Settings links them and key bindings).
- Signed in: the title shows "Playing as <name> · <sync state>", Invite a friend copies the invite link; guests see Sign in with StarHermit.
- Leaderboard: when signed in, every finished local round except lessons posts the player's total (≥ 0) through `score-script.js` (a practice session, range-checked 0–20,000, `high-score` board); results show the rank or "Score posted…" / "Score not posted…". Solo scores are range-checked only. The Daily's UTC day follows the platform clock (`serverNow`), falling back to the device.
- Hosted play: none (see Modes). No room or session other than the score post is used.

## 7. Controls

- Keyboard: W/↑ forward, S/↓ back (60 %), A/← D/→ steer, Space/K jump, Shift/L dive, Esc/P pause; all rebindable in Options.
- Gamepad: left stick / D-pad, South jump, East or West dive, Start pause.
- Touch: the runtime's movement stick plus Jump and Dive buttons during a round (mirrored for left-handed play); menus by tap. The scene itself takes no taps.

## 8. Checks (`npm test`)

- `tests/run.mjs`: rules, scoring, shows, replays, save merge and the content sweep (every course solvable, dailies −30…+365 days finishable).
- `tests/i18n.test.mjs`: nine locales, every key the client uses, content names. `tests/save.test.mjs`: old cloud document migration and merge.
- `tests/native.mjs`: `tsc`, `starhermit check .` with no warnings, the web index up to date, and the render-check play scripts in `tests/native/` (generated by `tools/gen-plays.mjs` from rhythms `tools/plan.mjs` finds with the real rules and the measured play-script timing): the five lessons (desktop), Journey 1–2 (phone 390×844@3), the Quick Show to its table (desktop), the Daily, a challenge with pause / Settings / Help, and Practice (landscape 844×390@3).
- `tools/browser-play.mjs` (`npm run test:browser`): the packaged loader in Chrome on the GPU at desktop, phone (DPR 3, touch stick) and landscape.
- `npm run package` regenerates `index.html` + `starhermit-files.json` after every change.

## Known limitations

- Hosted rooms are not available (dev-server only in the browser build).
- Bloom is threshold-based rather than glow-masked (see Scene).
- Guests' old browser localStorage progress cannot migrate; signed-in cloud saves do.
