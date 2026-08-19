"use strict";

/**
 * A standalone, scrubbable view of one harness run.
 *
 * WHY THIS EXISTS RATHER THAN THE 3D VIEW. Watching the fight in the browser is the obvious
 * answer and it does not work: the browser's RNG stream, its input timing and its renderer all
 * differ from the harness, so the same seed is a different fight - it dies around t1300 where the
 * harness dies around t1900. Every attempt to align the three fixed one and broke another.
 *
 * So the run records itself and is drawn back. These are the exact numbers the report is built
 * from, one frame per tick. Nothing is simulated here, so there is nothing to diverge.
 *
 * Self-contained on purpose - the data is inlined, so it opens straight from the file system with
 * no server and no build step.
 */

export interface ReplayFrame {
  t: number;
  px: number;
  py: number;
  hp: number;
  sx: number | null;
  sd: boolean;
  shp: number;
  mobs: { n: string; x: number; y: number; t: boolean }[];
  s: string;
}

export function buildReplayHtml(
  seed: number,
  frames: ReplayFrame[],
  hits: { tick: number; from: string; damage: number }[],
  setTicks: number[],
): string {
  const unique = setTicks.filter((tick, index, all) => all.indexOf(tick) === index);
  const data = JSON.stringify({ seed, frames, hits, setTicks: unique });
  const parts: string[] = [];

  parts.push("<!doctype html>");
  parts.push('<html><head><meta charset="utf-8"><title>Zuk replay - seed ' + seed + "</title>");
  parts.push("<style>");
  parts.push(":root { color-scheme: dark; }");
  parts.push("body { margin:0; background:#14110f; color:#e8e2da;");
  parts.push("  font:13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }");
  parts.push("header { padding:10px 14px; border-bottom:1px solid #3a322c; display:flex;");
  parts.push("  gap:14px; align-items:center; flex-wrap:wrap; }");
  parts.push("canvas { display:block; width:100%; height:auto; }");
  parts.push("#wrap { padding:12px 14px; }");
  parts.push("#scrub { flex:1 1 320px; min-width:240px; }");
  parts.push("button, select { background:#2a2320; color:#e8e2da; border:1px solid #4b403a;");
  parts.push("  padding:5px 10px; border-radius:4px; cursor:pointer; font:inherit; }");
  parts.push(".k { color:#a89a8c; }");
  parts.push("#state { padding:6px 14px 4px; color:#ffcf8f; min-height:1.5em; }");
  parts.push("#events { padding:0 14px 12px; color:#ff8f6f; min-height:1.5em; }");
  parts.push(".legend { padding:0 14px 16px; color:#a89a8c; }");
  parts.push(".legend b { color:#e8e2da; font-weight:600; }");
  parts.push("</style></head><body>");
  parts.push("<header>");
  parts.push('<button id="play">play</button>');
  parts.push('<span class="k">tick</span> <b id="tick"></b>');
  parts.push('<input id="scrub" type="range" min="0" value="0">');
  parts.push('<span class="k">speed</span>');
  parts.push('<select id="speed"><option>1</option><option selected>4</option>');
  parts.push("<option>10</option><option>30</option></select>");
  parts.push('<span class="k">jump</span> <select id="jump"></select>');
  parts.push("</header>");
  parts.push('<div id="wrap"><canvas id="c" width="1160" height="440"></canvas></div>');
  parts.push('<div id="state"></div><div id="events"></div>');
  parts.push('<div class="legend">');
  parts.push('<b style="color:#6fa8ff">blue</b> player &nbsp;');
  parts.push('<b style="color:#ffd166">gold</b> shield cover (dark column = trailing tile) &nbsp;');
  parts.push('<b style="color:#ff6f6f">red</b> mager &nbsp;');
  parts.push('<b style="color:#8fff9f">green</b> ranger &nbsp;');
  parts.push('<b style="color:#b083ff">purple</b> jad &nbsp;');
  parts.push('<b style="color:#ff8f6f">orange</b> healer &nbsp;');
  parts.push("hollow = still on the shield, filled = tagged. Arrow keys step a tick.");
  parts.push("</div>");
  parts.push("<script>");
  parts.push("var DATA = " + data + ";");
  parts.push("var F = DATA.frames, C = document.getElementById('c'), X = C.getContext('2d');");
  parts.push("var MINX = 8, MAXX = 42, MINY = 4, MAXY = 26;");
  parts.push("var S = Math.floor(C.width / (MAXX - MINX + 1));");
  parts.push("function gx(x) { return (x - MINX) * S; }");
  parts.push("function gy(y) { return (MAXY - y) * S; }");
  parts.push("function colour(n) {");
  parts.push("  if (n.indexOf('Zek') >= 0) return '#ff6f6f';");
  parts.push("  if (n.indexOf('Xil') >= 0) return '#8fff9f';");
  parts.push("  if (n.indexOf('Jad') >= 0) return '#b083ff';");
  parts.push("  if (n.indexOf('MejJak') >= 0 || n.indexOf('HurKot') >= 0) return '#ff8f6f';");
  parts.push("  return '#8c8c8c';");
  parts.push("}");
  parts.push("var i = 0, playing = false, timer = null;");
  parts.push("function draw() {");
  parts.push("  var f = F[i]; if (!f) return;");
  parts.push("  X.fillStyle = '#14110f'; X.fillRect(0, 0, C.width, C.height);");
  parts.push("  X.strokeStyle = '#241f1b'; X.lineWidth = 1;");
  parts.push("  for (var x = MINX; x <= MAXX; x++) {");
  parts.push("    X.beginPath(); X.moveTo(gx(x), 0); X.lineTo(gx(x), C.height); X.stroke(); }");
  parts.push("  for (var y = MINY; y <= MAXY; y++) {");
  parts.push("    X.beginPath(); X.moveTo(0, gy(y)); X.lineTo(C.width, gy(y)); X.stroke(); }");
  parts.push("  X.fillStyle = 'rgba(216,160,255,0.10)';");
  parts.push("  X.fillRect(gx(22), gy(8), S * 7, S * 7);");
  parts.push("  if (f.sx !== null) {");
  parts.push("    var trail = f.sd ? f.sx : f.sx + 4;");
  parts.push("    for (var sxx = f.sx; sxx < f.sx + 5; sxx++) {");
  parts.push("      X.fillStyle = sxx === trail ? 'rgba(255,209,102,0.09)' : 'rgba(255,209,102,0.26)';");
  parts.push("      X.fillRect(gx(sxx), gy(16), S, (16 - MINY + 1) * S); }");
  parts.push("    X.fillStyle = '#ffd166'; X.font = '11px monospace';");
  parts.push("    X.fillText((f.sd ? 'E' : 'W') + ' ' + f.shp + 'hp', gx(f.sx), gy(17) - 4); }");
  parts.push("  X.strokeStyle = '#5a4a3a'; X.setLineDash([3, 3]);");
  parts.push("  X.strokeRect(gx(20) + 1, gy(21) + 1, S - 2, S - 2);");
  parts.push("  X.strokeRect(gx(29) + 1, gy(21) + 1, S - 2, S - 2);");
  parts.push("  X.setLineDash([]);");
  parts.push("  for (var m = 0; m < f.mobs.length; m++) {");
  parts.push("    var mob = f.mobs[m];");
  parts.push("    if (mob.n.indexOf('Zuk') >= 0) continue;");
  parts.push("    X.beginPath();");
  parts.push("    X.arc(gx(mob.x) + S / 2, gy(mob.y) + S / 2, S * 0.38, 0, 7);");
  parts.push("    if (mob.t) { X.fillStyle = colour(mob.n); X.fill(); }");
  parts.push("    else { X.strokeStyle = colour(mob.n); X.lineWidth = 2; X.stroke(); }");
  parts.push("    var d = Math.max(Math.abs(mob.x - f.px), Math.abs(mob.y - f.py));");
  parts.push("    X.fillStyle = colour(mob.n); X.font = '10px monospace';");
  parts.push("    X.fillText('d' + d, gx(mob.x) - 2, gy(mob.y) - 3); }");
  parts.push("  X.fillStyle = '#6fa8ff';");
  parts.push("  X.fillRect(gx(f.px) + S * 0.2, gy(f.py) + S * 0.2, S * 0.6, S * 0.6);");
  parts.push("  document.getElementById('tick').textContent = f.t;");
  parts.push("  document.getElementById('state').textContent =");
  parts.push("    'player ' + f.px + ',' + f.py + '  hp ' + f.hp + '   |   ' + f.s;");
  parts.push("  var near = [];");
  parts.push("  for (var h = 0; h < DATA.hits.length; h++) {");
  parts.push("    if (DATA.hits[h].tick === f.t) {");
  parts.push("      near.push('SHIELD HIT  ' + DATA.hits[h].from + '  ' + DATA.hits[h].damage); } }");
  parts.push("  document.getElementById('events').textContent = near.join('    ');");
  parts.push("}");
  parts.push("var scrub = document.getElementById('scrub');");
  parts.push("scrub.max = F.length - 1;");
  parts.push("scrub.oninput = function () { i = +scrub.value; draw(); };");
  parts.push("function stop() { playing = false; if (timer) clearInterval(timer);");
  parts.push("  document.getElementById('play').textContent = 'play'; }");
  parts.push("document.getElementById('play').onclick = function () {");
  parts.push("  if (playing) { stop(); return; }");
  parts.push("  playing = true; this.textContent = 'pause';");
  parts.push("  timer = setInterval(function () {");
  parts.push("    i = Math.min(F.length - 1, i + 1); scrub.value = i; draw();");
  parts.push("    if (i === F.length - 1) stop();");
  parts.push("  }, 600 / +document.getElementById('speed').value); };");
  parts.push("document.getElementById('speed').onchange = function () { if (playing) { stop(); ");
  parts.push("  document.getElementById('play').click(); } };");
  parts.push("var jump = document.getElementById('jump');");
  parts.push("var opts = ['<option value=\"\">-</option>'];");
  parts.push("for (var q = 0; q < DATA.setTicks.length; q++) {");
  parts.push("  opts.push('<option value=\"' + DATA.setTicks[q] + '\">set ' + (q + 1) +");
  parts.push("    ' @ t' + DATA.setTicks[q] + '</option>'); }");
  parts.push("jump.innerHTML = opts.join('');");
  parts.push("jump.onchange = function () {");
  parts.push("  var t = +jump.value; if (!t) return;");
  parts.push("  for (var n = 0; n < F.length; n++) {");
  parts.push("    if (F[n].t >= t - 6) { i = n; scrub.value = i; draw(); return; } } };");
  parts.push("document.onkeydown = function (e) {");
  parts.push("  if (e.key === 'ArrowRight') { i = Math.min(F.length - 1, i + 1); scrub.value = i; draw(); }");
  parts.push("  if (e.key === 'ArrowLeft') { i = Math.max(0, i - 1); scrub.value = i; draw(); } };");
  parts.push("draw();");
  parts.push("</script></body></html>");

  return parts.join("\n");
}
