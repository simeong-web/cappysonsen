/**
 * The only place in the client that touches `localStorage`.
 *
 * `src/` stays clock-free and storage-free (CLAUDE.md rule 1); it supplies the
 * keys, the envelope and the validators, and this file supplies the browser.
 * Every read goes through `save.ts`, so a corrupt or stale record degrades to
 * "no save" instead of throwing at a player.
 */
import { parseSave, serializeSave, type Validator } from "../src/save";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // private browsing, or storage disabled
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* quota or private mode — the run simply will not resume */
  }
}

export function load<T>(key: string, validate: Validator<T>): T | null {
  const raw = read(key);
  if (raw === null) return null;
  const env = parseSave(raw, validate);
  return env === null ? null : env.state;
}

export function save<T>(key: string, state: T, nowMs: number): void {
  write(key, serializeSave(state, nowMs));
}

export function clear(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Clipboard with a fallback: iOS Safari refuses `writeText` outside a gesture. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to the execCommand path below */
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    // Off-screen but still focusable — display:none would not be selectable.
    el.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(el);
    el.select();
    el.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    el.remove();
    return ok;
  } catch {
    return false;
  }
}
