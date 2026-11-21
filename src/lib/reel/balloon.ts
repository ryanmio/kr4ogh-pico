/** The balloon, drawn on a 2D canvas: a clear mylar envelope and the
 * tracker hanging under it.
 *
 * It is a picture of the thing rather than a model of it. At the scale of
 * the reel a real balloon is a fraction of a pixel, so this is an icon the
 * size of a small country, and every part is drawn for what a viewer can
 * read at that size: the envelope slack at launch and round at float, two
 * blue solar panels either side of a green board, a copper wire above and
 * below.
 */

export interface BalloonLook {
  /** Radius of the full envelope, in canvas pixels. */
  radius: number;
  /** How full the envelope looks: 1/3 on the ground, 1 at float. */
  fill: number;
  /** Daylight on it, 0 at night to 1 at noon. */
  light: number;
  /** A slow swing of the payload, in radians. */
  sway: number;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

/** How full the envelope looks at an altitude. The gas takes up what the
 * air pressure lets it, and pressure halves about every 5.5 km, so most of
 * the filling happens in the last few kilometres of the climb. */
export function fillAt(altitudeM: number, floatM: number, groundM: number): number {
  const scaleM = 7600;
  const v = Math.exp(-Math.max(0, floatM - altitudeM) / scaleM);
  const v0 = Math.exp(-Math.max(0, floatM - groundM) / scaleM);
  const f = v0 < 1 ? (v - v0) / (1 - v0) : 1;
  return lerp(1 / 3, 1, Math.min(1, Math.max(0, f)));
}

/** Where the bottom of the wire is below the envelope's centre, in radii:
 * the scene starts the line to the ground there. */
export const WIRE_END = 4.0;

/** Draw the balloon with the centre of its envelope at (x, y). */
export function drawBalloon(
  ctx: CanvasRenderingContext2D, x: number, y: number, look: BalloonLook,
): void {
  const R = look.radius;
  const g = Math.min(1, Math.max(0, (look.fill - 1 / 3) / (2 / 3)));
  const light = look.light;
  // The outline: half a sphere when full, a dome over a slack cone when not.
  const W = lerp(0.66, 1, g) * R;
  const top = lerp(0.98, 1, g) * R;
  const eq = lerp(-0.36, 0, g) * R;
  const bottom = lerp(1.38, 1, g) * R;
  const k1 = lerp(0.42, 0.5523, g) * R;
  const cx2 = lerp(0.07, 0.5523, g) * R;
  const cy2 = bottom - lerp(0.62, 0, g) * R;
  const envelope = () => {
    ctx.beginPath();
    ctx.moveTo(0, -top);
    ctx.bezierCurveTo(0.5523 * W, -top, W, eq - 0.5523 * (top + eq), W, eq);
    ctx.bezierCurveTo(W, eq + k1, cx2, cy2, 0, bottom);
    ctx.bezierCurveTo(-cx2, cy2, -W, eq + k1, -W, eq);
    ctx.bezierCurveTo(-W, eq - 0.5523 * (top + eq), -0.5523 * W, -top, 0, -top);
    ctx.closePath();
  };

  ctx.save();
  ctx.translate(x, y);
  const dim = lerp(0.42, 1, light);

  // ---- the tracker, behind the envelope's lower edge ----
  const hang = bottom + 1.05 * R; // centre of the board
  ctx.save();
  ctx.translate(0, bottom);
  ctx.rotate(look.sway);
  ctx.translate(0, -bottom);
  const copper = `rgba(${Math.round(226 * dim)}, ${Math.round(140 * dim)}, ${Math.round(72 * dim)}, 0.95)`;
  ctx.lineCap = "round";
  ctx.strokeStyle = copper;
  ctx.lineWidth = Math.max(1.5, R * 0.028);
  ctx.beginPath();
  ctx.moveTo(0, bottom);
  ctx.lineTo(0, hang - 0.16 * R);
  ctx.moveTo(0, hang + 0.16 * R);
  ctx.quadraticCurveTo(0.05 * R, hang + 0.9 * R, -0.02 * R, WIRE_END * R);
  ctx.stroke();
  // Panels: two blue arrays out to the sides, seen a little from above.
  const panel = (dir: 1 | -1) => {
    const x0 = dir * 0.07 * R;
    const x1 = dir * 0.74 * R;
    const yTop = hang - 0.10 * R;
    const yBot = hang + 0.06 * R;
    const skew = 0.06 * R;
    ctx.beginPath();
    ctx.moveTo(x0, yTop);
    ctx.lineTo(x1, yTop - skew);
    ctx.lineTo(x1, yBot - skew);
    ctx.lineTo(x0, yBot);
    ctx.closePath();
    const grad = ctx.createLinearGradient(x0, yTop, x1, yBot);
    grad.addColorStop(0, `rgb(${Math.round(24 * dim)}, ${Math.round(64 * dim)}, ${Math.round(168 * dim)})`);
    grad.addColorStop(0.5, `rgb(${Math.round(58 * dim)}, ${Math.round(118 * dim)}, ${Math.round(232 * dim)})`);
    grad.addColorStop(1, `rgb(${Math.round(20 * dim)}, ${Math.round(52 * dim)}, ${Math.round(140 * dim)})`);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = `rgba(190, 215, 255, ${0.55 * dim})`;
    ctx.lineWidth = Math.max(0.75, R * 0.012);
    ctx.stroke();
    // Cell lines.
    ctx.beginPath();
    for (let c = 1; c < 4; c++) {
      const f = c / 4;
      const cx = lerp(x0, x1, f);
      ctx.moveTo(cx, yTop - skew * f);
      ctx.lineTo(cx, yBot - skew * f);
    }
    ctx.stroke();
  };
  panel(1);
  panel(-1);
  // The board, edge-on between them.
  ctx.fillStyle = `rgb(${Math.round(34 * dim)}, ${Math.round(150 * dim)}, ${Math.round(84 * dim)})`;
  ctx.strokeStyle = `rgba(160, 240, 190, ${0.6 * dim})`;
  ctx.lineWidth = Math.max(0.75, R * 0.012);
  ctx.beginPath();
  ctx.roundRect(-0.075 * R, hang - 0.17 * R, 0.15 * R, 0.34 * R, 0.02 * R);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // ---- the envelope ----
  // A halo first, so it stands off the ground whatever is under it.
  ctx.save();
  ctx.shadowColor = `rgba(200, 235, 255, ${0.55 * dim})`;
  ctx.shadowBlur = R * 0.5;
  envelope();
  ctx.fillStyle = `rgba(200, 232, 255, ${0.10 * dim})`;
  ctx.fill();
  ctx.restore();

  ctx.save();
  envelope();
  ctx.clip();
  // Clear film: nearly nothing in the middle, bright where it turns edge-on.
  const body = ctx.createRadialGradient(-0.1 * W, eq - 0.1 * R, 0.1 * R, 0, eq, 1.25 * R);
  body.addColorStop(0, `rgba(215, 240, 255, ${0.10 * dim})`);
  body.addColorStop(0.62, `rgba(190, 225, 250, ${0.20 * dim})`);
  body.addColorStop(0.88, `rgba(225, 242, 255, ${0.46 * dim})`);
  body.addColorStop(1, `rgba(255, 255, 255, ${0.75 * dim})`);
  ctx.fillStyle = body;
  ctx.fillRect(-R * 1.2, -R * 1.2, R * 2.4, R * 3);
  // The ground reflected in the lower half, the way mylar picks it up.
  const under = ctx.createLinearGradient(0, eq, 0, bottom);
  under.addColorStop(0, "rgba(120, 190, 255, 0)");
  under.addColorStop(1, `rgba(90, 170, 255, ${0.22 * dim})`);
  ctx.fillStyle = under;
  ctx.fillRect(-R * 1.2, eq, R * 2.4, bottom - eq);
  // Seams, pole to pole.
  ctx.strokeStyle = `rgba(255, 255, 255, ${0.22 * dim})`;
  ctx.lineWidth = Math.max(0.75, R * 0.013);
  for (const f of [-0.62, -0.22, 0.22, 0.62]) {
    ctx.beginPath();
    ctx.moveTo(0, -top);
    ctx.bezierCurveTo(f * 1.33 * W, -top * 0.6 + eq * 0.4, f * 1.33 * W * lerp(0.5, 1, g),
      lerp(cy2, bottom * 0.6, g), 0, bottom);
    ctx.stroke();
  }
  // The sun on it.
  const shine = ctx.createRadialGradient(-0.36 * W, eq - 0.42 * top, 0, -0.36 * W, eq - 0.42 * top, 0.55 * W);
  shine.addColorStop(0, `rgba(255, 255, 255, ${0.85 * light + 0.12})`);
  shine.addColorStop(0.3, `rgba(255, 255, 255, ${0.30 * light + 0.05})`);
  shine.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = shine;
  ctx.fillRect(-R * 1.2, -R * 1.2, R * 2.4, R * 3);
  ctx.restore();

  // Rim, and a second glint low on the far side.
  envelope();
  ctx.strokeStyle = `rgba(255, 255, 255, ${0.82 * dim})`;
  ctx.lineWidth = Math.max(1, R * 0.03);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(0.42 * W, eq + 0.36 * (bottom - eq) * lerp(0.5, 1, g), 0.05 * R, 0.16 * R, -0.5, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255, 255, 255, ${0.35 * dim})`;
  ctx.fill();
  ctx.restore();
}
