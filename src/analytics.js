// PostHog product analytics.
//
// Same contract as backend.js: every export is safe to call when the
// project key isn't set. Without a key this module is a no-op — the game
// runs identically, which is what makes local development and preview
// deploys work without anyone needing credentials.
//
// Deliberately anonymous. This game has no accounts, and nothing
// identifying is ever passed to `track` — only gameplay facts (which
// level, which upgrade, what score). Read the call sites in main.js as the
// definitive list of what leaves the browser.
import posthog from "posthog-js";

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY;
// Defaults to PostHog's US cloud. EU projects must set this explicitly to
// https://eu.i.posthog.com — events silently go nowhere against the wrong
// region, so it's an env var rather than a guess.
const POSTHOG_HOST = import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com";

let enabled = false;

export function initAnalytics() {
  if (!POSTHOG_KEY) return;
  try {
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      // Honour the browser's Do Not Track setting. Costs nothing here —
      // this is a game, not a funnel that depends on complete coverage.
      respect_dnt: true,
      // No logins exist, so every player is anonymous. Creating a person
      // profile per anonymous visitor inflates billing for data that
      // can never be tied to anyone anyway; events still arrive and
      // aggregate normally.
      person_profiles: "identified_only",
      capture_pageview: true,
      // The game is one long-lived page — a player can spend an hour on
      // a single load — so autocapture of every click would be noisy and
      // low-signal next to the explicit events below.
      autocapture: false,
    });
    enabled = true;
  } catch (err) {
    // Analytics failing must never take the game down with it.
    console.warn("Analytics unavailable.", err);
  }
}

export function track(event, properties = {}) {
  if (!enabled) return;
  try {
    posthog.capture(event, properties);
  } catch {
    // Deliberately silent: a dropped analytics event is not worth a
    // console error on every subsequent call during a battle.
  }
}

// Named event constants rather than bare strings at each call site, so a
// typo becomes an undefined import (caught at build) instead of a
// silently-separate event name that splits a chart in two.
export const EVENTS = {
  LEVEL_STARTED: "level_started",
  LEVEL_COMPLETED: "level_completed",
  RUN_ENDED: "run_ended",
  UPGRADE_PURCHASED: "upgrade_purchased",
  POPULATION_PURCHASED: "population_purchased",
  SCORE_SUBMITTED: "score_submitted",
  LEADERBOARD_OPENED: "leaderboard_opened",
  FEEDBACK_SUBMITTED: "feedback_submitted",
  PROGRESS_RESET: "progress_reset",
};
