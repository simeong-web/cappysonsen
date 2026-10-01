/**
 * Clipboard with a fallback: iOS Safari refuses `writeText` outside a gesture.
 *
 * Moved out of the old `storage.ts` when that file's localStorage half was
 * deleted; this half had nothing to do with storage and came along unchanged.
 *
 * Inside the platform's iframe, `navigator.clipboard` additionally needs the
 * host to grant `clipboard-write`. When it does not, the `execCommand` path
 * below is what runs, and when that is refused too the share button says
 * "Copy failed" rather than pretending.
 */
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
