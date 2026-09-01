# Defend The City

A single-player browser strategy game. A wave of raiders marches on your
city; you spend a Population budget placing defenders, then the battle
plays out automatically while you watch. Clear the level to earn Gold for
permanent upgrades — and to let the raiders evolve for the next one.

Built with [Three.js](https://threejs.org) and [Vite](https://vitejs.dev).
Plain JavaScript, no framework, no backend required to play.

## How the game works

Each level runs through four phases:

1. **Scouting** — see the incoming wave before you commit to anything.
2. **Placement** — spend Population on Knights, Archers, and Mages, placed
   anywhere on your side of the map.
3. **Battle** — fully automatic. No input; your placement is your strategy.
4. **Result** — clear the level and continue, or lose your defenders and
   watch the city take damage.

Terrain matters: high ground grants a damage bonus, and cliffs block melee
attacks entirely. City Health persists across the whole run and never
heals — when it hits zero, the run is over.

## Running it locally

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm run dev
```

Open the URL it prints (usually http://localhost:5173).

The game is fully playable with no configuration. The leaderboard,
feedback form, and analytics all switch themselves off when their
environment variables are absent — their buttons simply don't appear.

## Configuration

Copy `.env.example` to `.env.local` and fill in whichever services you
want. Every variable is optional.

| Variable | What it enables |
| --- | --- |
| `VITE_SUPABASE_URL` | Leaderboard + feedback form |
| `VITE_SUPABASE_ANON_KEY` | Leaderboard + feedback form |
| `VITE_POSTHOG_KEY` | Product analytics |
| `VITE_POSTHOG_HOST` | PostHog region (US default; set for EU) |

Anything prefixed `VITE_` is compiled into the browser bundle and is
therefore **public**. Only publishable keys belong there — Supabase's
`service_role` key must never appear in this repo.

### Supabase

Run [`supabase/schema.sql`](supabase/schema.sql) once in the Supabase
dashboard (SQL Editor → New query → paste → Run). It creates the
`leaderboard` and `feedback` tables with row-level security: the
leaderboard is publicly readable and insert-only, and feedback is
write-only, so no player can read another player's messages.

The game runs entirely in the browser, so scores are submitted on trust —
a determined person can post whatever they like. That's a deliberate
trade-off for a small leaderboard, and the schema comments say so plainly.

## Deployment

Hosted on Vercel as a static site. `vercel.json` pins the build command
and output directory; pushes to `main` deploy automatically once the repo
is connected. Set the environment variables above in the Vercel dashboard
under Settings → Environment Variables.

## Project structure

| Path | Purpose |
| --- | --- |
| `index.html` | Page shell and the whole UI overlay |
| `src/main.js` | Scene setup, placement, and the battle loop |
| `src/unit.js` | The `Unit` class, unit stats, damage and armor math |
| `src/tileTerrain.js` | Tile grid: elevation levels and tile kinds |
| `src/levelGenerator.js` | Procedural level generation and validation |
| `src/pathfinding.js` | A* plus string-pulling path smoothing |
| `src/meleeSlots.js` | Attack-slot geometry around a target |
| `src/progression.js` | Levels, Gold, upgrades, saves |
| `src/items.js` | Item drops and their combat effects |
| `src/backend.js` | Supabase leaderboard and feedback |
| `src/analytics.js` | PostHog events |
| `supabase/schema.sql` | Database tables and row-level security |

## Tests

Five suites run under plain Node, no browser needed:

```bash
node test-pathfinding.mjs && node test-generator.mjs && node test-melee-slots.mjs && node test-progression.mjs && node test-items.mjs
```

There is also a real headless-browser test that loads the game, places
units, and runs a battle — the only check that exercises actual runtime
bootstrap, and the one that has historically caught bugs the others miss.
It needs a dev server running on port 5199 in another terminal:

```bash
npm install --no-save puppeteer
npm run dev -- --port 5199 --host 127.0.0.1
node test-e2e.mjs
```

If Puppeteer can't find Chrome, point it at an existing install with
`PUPPETEER_EXECUTABLE_PATH`.

## Credits

Environment art from [Kenney](https://kenney.nl) (CC0).
