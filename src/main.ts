/**
 * Cappy's Onsen — entry point.
 *
 * Deliberately thin: hand control to the host, and start the game when the host
 * says so, with whatever it has saved for this player. Everything else lives in
 * `game/` (the Pixi client), `sim/` (the rules) and `platform/` (the host
 * contract).
 */
import { bootWithHost } from "./platform/host";
import { startClient, setMuted } from "./game/client";

bootWithHost(startClient, setMuted);
