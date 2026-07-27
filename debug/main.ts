/**
 * Milestone 4 tuning harness — an ugly, playable board over the sim.
 *
 * The point of this file is that it computes almost nothing. Every number on
 * screen comes out of `src/`; the DOM here only reads state and paints it. That
 * is not tidiness, it is the check: anything the harness has to work out for
 * itself is something the sim should have exposed, and Milestone 5's renderer
 * would have to reinvent.
 *
 * `debug/` is outside the purity rule, so Math.random and Date.now are fine
 * here — they seed runs, and nothing else.
 */
import { DEFAULT_CONFIG as cfg, isLongSoak, roundTarget } from "../src/config";
import { TILE_COLOURS, type BoardEvent, type Pos } from "../src/board";
import { CHARMS, type CharmId } from "../src/charms";
import { blissOf } from "../src/scoring";
import { chooseCharm, currentRoundScore, newRun, playMove, type RunState } from "../src/run";
import { legalMoves, pickMove, simulateRun, summarise, type Policy, type RunSummary } from "./bot";

// ── tile palette. Board art is Milestone 5; these are labels with a fill. ──
const TILE_FILL = ["#f2c14e", "#e58bb0", "#7fc4dd", "#98a3a8", "#7cbf6a"];
const TILE_CHAR = ["Y", "P", "B", "S", "L"];

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

let state: RunState = newRun(cfg, 20260726);
let selected: Pos | null = null;
let botRng = 1;
let policy: Policy = "random";
let timer: number | null = null;
let autoMs = -1;

// ───────────────────────────────────────────────────────────── logging

function log(text: string, cls = ""): void {
  const el = $("log");
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  el.appendChild(line);
  while (el.childElementCount > 300) el.firstElementChild?.remove();
  el.scrollTop = el.scrollHeight;
}

/** Summarise a move's event stream — the tuning signal, not a play-by-play. */
function logEvents(events: readonly BoardEvent[]): void {
  let cleared = 0;
  let depth = 0;
  const sizes: number[] = [];
  for (const e of events) {
    if (e.type === "cascadeStep") {
      cleared += e.cleared;
      depth = Math.max(depth, e.depth);
    } else if (e.type === "tilesCleared") sizes.push(e.size);
    else if (e.type === "shuffled") log("board was stuck — reshuffled", "b");
    else if (e.type === "cascadeAborted") log(`CASCADE GUARD TRIPPED at ${e.depth}`, "b");
  }
  const big = sizes.filter((s) => s >= 4);
  log(
    `move ${state.movesUsed}: ${cleared} tiles, ${depth} step${depth === 1 ? "" : "s"}` +
      (big.length ? `, ${big.length} match-${Math.max(...big)}+` : ""),
  );
}

// ───────────────────────────────────────────────────────────── painting

function paintBoard(): void {
  const board = $("board");
  const b = state.board;
  board.style.gridTemplateColumns = `repeat(${b.cols}, 46px)`;
  $("boardwrap").className = state.phase === "playing" ? "" : "locked";

  // Rebuild only when the grid size changes; otherwise repaint in place so
  // clicking does not fight the DOM.
  if (board.childElementCount !== b.grid.length) {
    board.replaceChildren();
    for (let i = 0; i < b.grid.length; i++) {
      const cell = document.createElement("button");
      cell.className = "tile";
      cell.dataset["i"] = String(i);
      board.appendChild(cell);
    }
  }

  for (let i = 0; i < b.grid.length; i++) {
    const cell = board.children[i] as HTMLButtonElement | undefined;
    if (!cell) continue;
    const tile = b.grid[i] ?? 0;
    cell.style.background = TILE_FILL[tile] ?? "#fff";
    cell.textContent = TILE_CHAR[tile] ?? "?";
    cell.title = TILE_COLOURS[tile] ?? "";
    const col = i % b.cols;
    const row = Math.floor(i / b.cols);
    cell.className =
      "tile" + (selected && selected.col === col && selected.row === row ? " sel" : "");
    cell.disabled = state.phase !== "playing";
  }
}

function paintReadouts(): void {
  const target = roundTarget(cfg, state.round);
  const score = currentRoundScore(cfg, state);
  const warmth = state.score.warmth;
  // Live bliss is what has landed so far. End-of-round charms (Patient Soak,
  // Risky Bather, Compound Warmth) only pay when the round is settled, so the
  // two are shown side by side — the gap IS the effect of those charms.
  const liveBliss = blissOf(state.score);
  const endBliss = warmth > 0 ? score / warmth : liveBliss;

  const n = (x: number): string => Math.round(x).toLocaleString("en-GB");
  $("score").textContent = n(score);
  $("target").textContent = n(target);
  $("warmth").textContent = n(warmth);
  $("bliss").textContent = liveBliss.toFixed(2);
  $("blissend").textContent = endBliss.toFixed(2);
  $("moves").textContent = `${state.moveBudget - state.movesUsed} / ${state.moveBudget}`;
  $("round").textContent = String(state.round);
  $("soak").textContent = isLongSoak(cfg, state.round) ? "YES — boss round" : "no";
  $("roundhead").textContent =
    `Round ${state.round}${isLongSoak(cfg, state.round) ? " — LONG SOAK" : ""}`;

  const pct = Math.min(100, (score / target) * 100);
  $("progress").style.width = `${pct}%`;
  $("progress").style.background = pct >= 100 ? "#6cc08b" : pct > 60 ? "#e8c15a" : "#e4695c";
  $("progresstext").textContent = `${n(score)} / ${n(target)}  (${pct.toFixed(0)}%)`;

  $("total").textContent = n(state.totalScore);
  $("cleared").textContent = String(state.rounds.filter((r) => r.cleared).length);
  $("charmcount").textContent = String(state.charms.length);

  const owned = $("owned");
  owned.replaceChildren();
  for (const id of state.charms) {
    const li = document.createElement("li");
    li.innerHTML = `<b>${CHARMS[id].name}</b> — ${CHARMS[id].text}`;
    owned.appendChild(li);
  }
}

function paintPhase(): void {
  const drafting = state.phase === "drafting";
  $("draftpanel").style.display = drafting ? "" : "none";
  $("overpanel").style.display = state.phase === "over" ? "" : "none";

  if (drafting) {
    const box = $("draft");
    box.replaceChildren();
    for (const id of state.offer ?? []) {
      const charm = CHARMS[id];
      const btn = document.createElement("button");
      btn.className = "charm";
      btn.innerHTML = `<b>${charm.name}</b> <em>${charm.text}</em>`;
      btn.onclick = () => take(id);
      box.appendChild(btn);
    }
  }

  if (state.phase === "over") {
    stopAuto();
    const cleared = state.round - 1;
    $("overtext").innerHTML =
      `Died on <b>round ${state.round}</b>${isLongSoak(cfg, state.round) ? " (a Long Soak)" : ""}.<br>` +
      `Cleared ${cleared} round${cleared === 1 ? "" : "s"} · ` +
      `total score ${Math.round(state.totalScore).toLocaleString("en-GB")} · ` +
      `${state.charms.length} charms.<br>` +
      `Seed <b>${state.seed}</b> — put it in the box to replay this exact run.`;
  }
}

const paint = (): void => {
  paintBoard();
  paintReadouts();
  paintPhase();
};

// ───────────────────────────────────────────────────────────── actions

function attempt(a: Pos, b: Pos): void {
  const played = playMove(cfg, state, a, b);
  if (!played) {
    $("hint").textContent = "No match there — the move was refused, not spent.";
    return;
  }
  const before = state.round;
  state = played.state;
  logEvents(played.events);
  if (state.phase === "drafting") {
    log(`round ${before} cleared — ${Math.round(state.totalScore).toLocaleString("en-GB")} total`, "g");
  } else if (state.phase === "over") {
    log(`run over on round ${state.round}`, "b");
  }
  $("hint").textContent = "Click a tile, then an adjacent one.";
  paint();
}

function onTileClick(i: number): void {
  if (state.phase !== "playing") return;
  const pos = { col: i % state.board.cols, row: Math.floor(i / state.board.cols) };
  if (!selected) {
    selected = pos;
  } else if (selected.col === pos.col && selected.row === pos.row) {
    selected = null;
  } else if (Math.abs(selected.col - pos.col) + Math.abs(selected.row - pos.row) === 1) {
    const from = selected;
    selected = null;
    attempt(from, pos);
    return;
  } else {
    selected = pos; // not adjacent: treat as a fresh selection
  }
  paint();
}

function take(id: CharmId): void {
  state = chooseCharm(cfg, state, id);
  log(`drafted ${CHARMS[id].name}`, "k");
  paint();
}

function botMove(): boolean {
  if (state.phase === "drafting") {
    const offer = state.offer ?? [];
    if (offer.length === 0) return false;
    const idx = Math.abs(botRng) % offer.length;
    botRng = (botRng * 1103515245 + 12345) | 0;
    take(offer[idx]!);
    return true;
  }
  if (state.phase !== "playing") return false;
  const picked = pickMove(cfg, state, policy, botRng);
  botRng = picked.rngState;
  if (!picked.move) return false;
  attempt(picked.move[0], picked.move[1]);
  return true;
}

function stopAuto(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  autoMs = -1;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".spd")) {
    b.classList.toggle("on", b.dataset["ms"] === "-1");
  }
}

function setSpeed(ms: number): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  autoMs = ms;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".spd")) {
    b.classList.toggle("on", Number(b.dataset["ms"]) === ms);
  }
  if (ms < 0) return;
  if (ms === 0) {
    // MAX: burst per frame so a whole run resolves in a second or two without
    // locking the tab.
    const burst = (): void => {
      if (autoMs !== 0) return;
      for (let i = 0; i < 40 && state.phase !== "over"; i++) if (!botMove()) break;
      if (state.phase === "over") return stopAuto();
      requestAnimationFrame(burst);
    };
    requestAnimationFrame(burst);
    return;
  }
  timer = window.setInterval(() => {
    if (!botMove() || state.phase === "over") stopAuto();
  }, ms);
}

function skipRound(): void {
  const round = state.round;
  for (let i = 0; i < 500 && state.round === round && state.phase === "playing"; i++) {
    if (!botMove()) break;
  }
  paint();
}

function skipRun(): void {
  for (let i = 0; i < 5000 && state.phase !== "over"; i++) if (!botMove()) break;
  paint();
}

function start(seed: number): void {
  stopAuto();
  state = newRun(cfg, seed);
  selected = null;
  botRng = (seed ^ 0x5f356495) | 0;
  $("seed").setAttribute("value", String(seed));
  ($("seed") as HTMLInputElement).value = String(seed);
  $("log").replaceChildren();
  log(`new run — seed ${seed}, target ${Math.round(roundTarget(cfg, 1)).toLocaleString("en-GB")}`, "k");
  paint();
}

// ───────────────────────────────────────────────────────────── batch

function runBatch(n: number): void {
  stopAuto();
  const started = performance.now();
  $("stats").textContent = `running ${n} ${policy} runs…`;
  // Yield once so the "running" message paints before we block.
  setTimeout(() => {
    const summaries: RunSummary[] = [];
    for (let i = 0; i < n; i++) {
      summaries.push(simulateRun(cfg, 1000 + i, policy, (i * 7919) | 0));
    }
    const stats = summarise(summaries, policy);
    const took = ((performance.now() - started) / 1000).toFixed(1);

    const rounds = [...stats.wallHistogram.keys()].sort((a, b) => a - b);
    const hist = rounds
      .map((r) => {
        const count = stats.wallHistogram.get(r) ?? 0;
        const pct = (count / stats.runs) * 100;
        const bar = "#".repeat(Math.round(pct / 2));
        return `  r${String(r).padStart(2)} ${String(count).padStart(4)} ${pct.toFixed(0).padStart(3)}% ${bar}`;
      })
      .join("\n");

    const table = stats.perRound
      .map(
        (p) =>
          `  ${String(p.round).padStart(2)}${isLongSoak(cfg, p.round) ? "*" : " "}` +
          ` ${String(p.reached).padStart(4)} ${String(p.cleared).padStart(4)}` +
          ` ${p.medianMovesToClear.toFixed(0).padStart(6)}` +
          ` ${p.medianScoreRatio.toFixed(2).padStart(7)}`,
      )
      .join("\n");

    $("stats").textContent =
      `${stats.runs} runs · ${policy} · ${took}s\n` +
      `median wall: round ${stats.medianWall}   mean ${stats.meanWall.toFixed(1)}\n` +
      `median score: ${Math.round(stats.medianScore).toLocaleString("en-GB")}\n` +
      `mean charms:  ${stats.meanCharms.toFixed(1)}\n` +
      `\nWHERE RUNS DIE (* = Long Soak)\n${hist}\n` +
      `\nPER ROUND\n  rd reach clrd  moves  score/T\n${table}\n` +
      `\nmoves-to-clear climbing round over round means\ncharms are losing to the target curve.`;
  }, 0);
}

// ───────────────────────────────────────────────────────────── wiring

$("board").addEventListener("click", (e) => {
  const cell = (e.target as HTMLElement).closest<HTMLButtonElement>(".tile");
  const i = cell?.dataset["i"];
  if (i !== undefined) onTileClick(Number(i));
});

$("newrun").onclick = () => start(Number(($("seed") as HTMLInputElement).value) || 0);
$("replay").onclick = () => start(state.seed);
$("randomseed").onclick = () => start(Math.floor(Math.random() * 2 ** 31));
$("again").onclick = () => start(Math.floor(Math.random() * 2 ** 31));
$("step").onclick = () => {
  botMove();
  paint();
};
$("skipround").onclick = skipRound;
$("skiprun").onclick = skipRun;

for (const b of document.querySelectorAll<HTMLButtonElement>(".spd")) {
  b.onclick = () => setSpeed(Number(b.dataset["ms"]));
}
for (const b of document.querySelectorAll<HTMLButtonElement>(".pol")) {
  b.onclick = () => {
    policy = (b.dataset["p"] as Policy) ?? "random";
    for (const o of document.querySelectorAll<HTMLButtonElement>(".pol")) {
      o.classList.toggle("on", o.dataset["p"] === policy);
    }
    $("polnote").textContent =
      policy === "greedy"
        ? "greedy: plays the highest-scoring move. Slower — batches take a while."
        : "random: a floor well below a human. Fast.";
  };
}
for (const b of document.querySelectorAll<HTMLButtonElement>(".batch")) {
  b.onclick = () => runBatch(Number(b.dataset["n"]));
}

document.addEventListener("keydown", (e) => {
  if (e.key === " ") {
    e.preventDefault();
    botMove();
    paint();
  }
  if (e.key === "Escape") {
    selected = null;
    paint();
  }
});

// Show the hint the first time a board would otherwise look unplayable.
if (legalMoves(state.board).length === 0) log("dealt board had no legal move", "b");

for (const b of document.querySelectorAll<HTMLButtonElement>(".pol")) {
  b.classList.toggle("on", b.dataset["p"] === policy);
}
stopAuto();
start(20260726);
