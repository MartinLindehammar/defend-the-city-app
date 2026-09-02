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
const POSTHOG_HOST_RAW = import.meta.env.VITE_POSTHOG_HOST;
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

// Guards a mistake that really happened on the first production deploy:
// this was set to the literal string "EU Cloud" — the label shown in the
// PostHog dashboard — rather than a URL. posthog-js treats a non-absolute
// api_host as a path RELATIVE TO THE CURRENT SITE, so every event was
// POSTed to `https://<the game>/EU%20Cloud/…` and quietly 405'd. Nothing
// threw, nothing logged, and the result was total silence in PostHog that
// looked exactly like "no players yet".
//
// Returns a normalised origin, or null meaning "configured, but not
// usable" — which the caller turns into a loud console error rather than
// a silent fallback to the wrong region.
export function resolvePostHogHost(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return DEFAULT_POSTHOG_HOST;
  // Whitespace is never valid in a host and is the signature of a pasted
  // label ("EU Cloud"), so reject it before URL parsing gets creative.
  if (/\s/.test(value)) return null;
  // A bare hostname ("eu.i.posthog.com") is a reasonable thing to type and
  // harmless to normalise, unlike the case above.
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // A host with no dot is a path fragment, not a domain.
    if (!url.hostname.includes(".")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const POSTHOG_HOST = resolvePostHogHost(POSTHOG_HOST_RAW);

let enabled = false;

export function initAnalytics() {
  if (!POSTHOG_KEY) return;
  if (POSTHOG_HOST === null) {
    // Deliberately console.error, not warn, and deliberately NOT a silent
    // fallback to the default region: sending a project's events to the
    // wrong cloud is just as invisible as sending them nowhere. Better to
    // stay off and say exactly what to fix.
    console.error(
      `[analytics] VITE_POSTHOG_HOST is not a valid URL (received ${JSON.stringify(POSTHOG_HOST_RAW)}). ` +
        "Analytics is disabled. Set it to https://eu.i.posthog.com (EU projects) or " +
        "https://us.i.posthog.com (US projects), then redeploy."
    );
    return;
  }
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
