// Supabase connection for the leaderboard and the feedback form.
//
// The single most important property of this module: EVERY export here is
// safe to call when Supabase isn't configured at all. Credentials arrive
// through Vite env vars, which means a fresh clone with no .env file — or
// a preview deploy where someone forgot to set them — still runs the game
// perfectly, just without a leaderboard. Nothing in this file may ever
// throw into the game loop.
//
// Both values below are PUBLIC by design. The anon key is meant to ship to
// browsers; what actually protects the data is row-level security in
// supabase/schema.sql (insert-only feedback, immutable leaderboard rows),
// not secrecy of this key. The service_role key must never appear here.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isBackendConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// How long to wait before giving up on a request. Without this the
// browser's own default applies, which for an unreachable host can mean
// twenty-plus seconds of a spinner going nowhere — measured, not guessed:
// a request to a non-existent Supabase project sat on "Loading…" for ~25s
// before failing. None of these calls is worth that wait; a leaderboard
// that says "couldn't load" after eight seconds is a far better outcome
// than one that looks hung.
const REQUEST_TIMEOUT_MS = 8000;

function fetchWithTimeout(input, init = {}) {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  // supabase-js supplies its own signal when a caller uses .abortSignal(),
  // so combine rather than clobber. AbortSignal.any is widely supported
  // but recent enough to be worth a fallback: on a browser without it the
  // request simply keeps the caller's signal and loses the timeout, which
  // is exactly the old behaviour — degraded, never broken.
  const signal =
    init.signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([init.signal, timeoutSignal])
      : init.signal || timeoutSignal;
  return fetch(input, { ...init, signal });
}

// `auth: { persistSession: false }` because this game has no accounts —
// every request is anonymous. Without it the client writes an auth session
// into localStorage for no reason.
const supabase = isBackendConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: fetchWithTimeout },
    })
  : null;

// Raw failures here are things like "TypeError: Failed to fetch" or
// "signal timed out" — accurate, and meaningless to a player. Translate
// the two that actually happen in practice (offline, and the timeout
// above) and pass anything else through, since an unexpected message is
// more useful than a generic one when someone reports a problem.
function describeError(err) {
  if (err?.name === "TimeoutError") return "The server took too long to respond.";
  if (err?.name === "AbortError") return "The request was cancelled.";
  if (err instanceof TypeError) return "Couldn't reach the server — check your connection.";
  return describeMessage(err?.message);
}

// supabase-js does NOT throw on a network failure — it catches internally
// and hands the failure back as a normal { error } result whose message is
// the stringified original ("TypeError: Failed to fetch", "signal timed
// out", …). Verified in the browser against an unreachable project, which
// is exactly how a player with no connection would experience it. So the
// same translation has to run over returned errors, not only over thrown
// ones, or the raw text leaks straight to the screen.
function describeMessage(message) {
  const text = String(message || "");
  if (!text) return "Something went wrong.";
  if (/timed out|TimeoutError/i.test(text)) return "The server took too long to respond.";
  if (/Failed to fetch|NetworkError|Load failed|ERR_/i.test(text)) {
    return "Couldn't reach the server — check your connection.";
  }
  return text;
}

export const LEADERBOARD_PAGE_SIZE = 25;
export const MAX_NAME_LENGTH = 24;
export const MAX_FEEDBACK_LENGTH = 2000;
export const MAX_CONTACT_LENGTH = 200;

// The name a player last submitted under, so they don't retype it every
// run. Kept in its own key rather than inside the save, because it should
// survive "Reset Game" (wiping your progress isn't asking to forget your
// own name) and it isn't part of a run's state.
const PLAYER_NAME_KEY = "defend-the-city-player-name";

export function loadPlayerName() {
  try {
    return localStorage.getItem(PLAYER_NAME_KEY) || "";
  } catch {
    return "";
  }
}

export function savePlayerName(name) {
  try {
    localStorage.setItem(PLAYER_NAME_KEY, name);
  } catch {
    // Private browsing / storage disabled. Harmless — the player just
    // retypes their name next time.
  }
}

// Mirrors the CHECK constraints in schema.sql. Trimming and clamping here
// means the common cases (trailing whitespace, an over-long name pasted
// in) are fixed silently on the client instead of coming back as a
// database error the player can't act on.
function sanitizeText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

// Every function below returns the same { ok, error } shape rather than
// throwing, so call sites in the game UI stay a plain if/else and a
// network failure can never propagate into the render loop.
export async function submitScore({ playerName, score, levelReached }) {
  if (!supabase) return { ok: false, error: "Leaderboard isn't set up yet." };

  const name = sanitizeText(playerName, MAX_NAME_LENGTH);
  if (!name) return { ok: false, error: "Please enter a name." };

  // Score is a float internally (gold interest compounds fractionally and
  // score is summed alongside it), but the column is an integer — floor
  // it the same way every on-screen score display already does, so what
  // gets submitted is exactly the number the player saw.
  const row = {
    player_name: name,
    score: Math.max(0, Math.floor(score)),
    level_reached: Math.max(1, Math.floor(levelReached)),
  };

  try {
    const { error } = await supabase.from("leaderboard").insert(row);
    if (error) return { ok: false, error: describeMessage(error.message) };
    savePlayerName(name);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

export async function fetchTopScores(limit = LEADERBOARD_PAGE_SIZE) {
  if (!supabase) return { ok: false, error: "Leaderboard isn't set up yet.", rows: [] };

  try {
    const { data, error } = await supabase
      .from("leaderboard")
      .select("player_name, score, level_reached, created_at")
      // Ties break by who got there first — a player who matched an
      // existing score doesn't leapfrog the person who set it.
      .order("score", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) return { ok: false, error: describeMessage(error.message), rows: [] };
    return { ok: true, rows: data || [] };
  } catch (err) {
    return { ok: false, error: describeError(err), rows: [] };
  }
}

export async function submitFeedback({ message, contact, levelReached, score }) {
  if (!supabase) return { ok: false, error: "Feedback isn't set up yet." };

  const text = sanitizeText(message, MAX_FEEDBACK_LENGTH);
  if (!text) return { ok: false, error: "Please write something first." };

  try {
    const { error } = await supabase.from("feedback").insert({
      message: text,
      contact: sanitizeText(contact, MAX_CONTACT_LENGTH) || null,
      // Attached automatically so a report arrives with the run it's
      // about, rather than needing the player to describe where they were.
      level_reached: Number.isFinite(levelReached) ? Math.floor(levelReached) : null,
      score: Number.isFinite(score) ? Math.floor(score) : null,
      user_agent: navigator.userAgent.slice(0, 500),
    });
    if (error) return { ok: false, error: describeMessage(error.message) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}
