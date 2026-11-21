/** Render a flight's reel to a video: a short vertical film of the flight
 * from just behind the balloon (src/lib/reel/scene.ts), for sharing.
 *
 *   npm run reel                      the featured flight, whole, 15 s
 *   npm run reel -- PT02              a named flight
 *   npm run reel -- PT02 --hours 24   only its first 24 hours
 *   npm run reel -- --seconds 20      a longer film (30 at most reads well)
 *   npm run reel -- --units metric    km and m; imperial without
 *   npm run reel -- --cta "kr4ogh-pico.vercel.app"   a closing line
 *   npm run reel -- --no-live         the committed track, no wspr.live
 *   npm run reel -- --no-lights       no town lights on the night side
 *   npm run reel -- --stills 2,7,14   PNGs at those seconds, no video
 *   npm run reel -- --preview         serve the page and leave it up, to
 *                                     watch it play in a browser
 *
 * Writes reels/<callsign>-<flight>[-<hours>h].mp4, 1080x1920 at 30 frames
 * a second, H.264, which is what Instagram and the rest take as is.
 *
 * It works a frame at a time: the page is asked for the frame at an
 * instant, answers when every tile of it has loaded, and is photographed.
 * So the film is the same on any machine and at any connection speed; a
 * slow one only takes longer. Needs the system Chrome, like browser-check,
 * and ffmpeg on the path for the video.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const valued = new Set(["hours", "seconds", "units", "cta", "stills", "out", "fps"]);
const flightArg = args.find((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]?.slice(2)));
const fps = Number(option("fps") ?? 30);
const WIDTH = 1080;
const HEIGHT = 1920;

/** Answers /reel-data.json with a flight as the site's build reads it:
 * flights.toml through lib/config.ts and the committed track through
 * lib/flights.ts, spoofed fixes set aside and speeds resolved. */
const flightData = {
  name: "reel-data",
  configureServer(server) {
    server.middlewares.use("/reel-data.json", async (req, res) => {
      try {
        const flights = await server.ssrLoadModule("/src/lib/flights.ts");
        const wanted = new URL(req.url, "http://x").searchParams.get("flight");
        const meta = wanted
          ? flights.allFlights().find((f) => f.flight_id === wanted)
          : flights.featuredFlight();
        if (!meta) throw new Error(`flights.toml has no flight ${wanted ?? "to feature"}`);
        const { track, ghosts, spoofed } = flights.flightData(meta);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ meta, track, ghosts, spoofed }));
      } catch (e) {
        res.statusCode = 500;
        res.end(String(e?.message ?? e));
      }
    });
  },
};

/** The picture of the Earth at night the reel lights its towns from. NASA
 * draws it to order, some twenty seconds each time, which is too long and
 * too uncertain to ask of every render; it never changes, so it is fetched
 * once and kept. A render that wants it and cannot have it stops, since a
 * film with its nights quietly left dark is not the film that was asked
 * for; --no-lights asks for that one. */
const lightsFile = join(root, "node_modules/.cache/pico-reel/night-lights.jpg");
async function nightLights() {
  if (existsSync(lightsFile) && statSync(lightsFile).size > 100000) return;
  const { LIGHTS_URL } = await server.ssrLoadModule("/src/lib/reel/sources.ts");
  process.stdout.write("fetching the night lights from NASA GIBS, once (about 20 s)... ");
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(LIGHTS_URL, { signal: AbortSignal.timeout(120000) });
      const body = Buffer.from(await res.arrayBuffer());
      if (!res.ok || !res.headers.get("content-type")?.startsWith("image/")) {
        throw new Error(`NASA GIBS answered ${res.status} ${res.headers.get("content-type")}`);
      }
      mkdirSync(dirname(lightsFile), { recursive: true });
      writeFileSync(lightsFile, body);
      console.log("done");
      return;
    } catch (e) {
      if (attempt === 2) {
        console.log("failed");
        throw new Error(`could not fetch the night lights (${e.message}); `
          + "try again, or render without them: --no-lights");
      }
    }
  }
}
const lightsRoute = {
  name: "reel-lights",
  configureServer(s) {
    s.middlewares.use("/reel-lights.jpg", (_req, res) => {
      res.setHeader("content-type", "image/jpeg");
      res.end(readFileSync(lightsFile));
    });
  },
};

const server = await createServer({
  root,
  configFile: false,
  logLevel: "warn",
  appType: "mpa",
  plugins: [flightData, lightsRoute],
  optimizeDeps: { include: ["maplibre-gl"] },
  server: { port: 4331, strictPort: false, host: "127.0.0.1" },
});
await server.listen();
const origin = server.resolvedUrls.local[0].replace(/\/$/, "");

const query = new URLSearchParams();
if (flightArg) query.set("flight", flightArg);
for (const k of ["hours", "seconds", "units", "cta"]) if (option(k)) query.set(k, option(k));
if (flag("no-live")) query.set("live", "0");
if (flag("no-lights")) query.set("lights", "0");
else {
  try {
    await nightLights();
  } catch (e) {
    console.error(e.message);
    await server.close();
    process.exit(1);
  }
}
const pageUrl = `${origin}/dev/reel/?${query}`;

if (flag("preview")) {
  console.log(`playing at ${pageUrl}\nCtrl-C to stop`);
  await new Promise(() => {});
}

const browser = await chromium.launch({
  channel: "chrome", headless: true,
  args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=metal"],
});
let failed = false;
try {
  // Half size at twice the density: 1080x1920 of pixels, with the page
  // laid out at the size of a phone.
  const page = await browser.newPage({
    viewport: { width: WIDTH / 2, height: HEIGHT / 2 }, deviceScaleFactor: 2,
  });
  page.on("pageerror", (e) => console.error(`page error: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") console.error(`console: ${m.text()}`); });
  await page.goto(`${pageUrl}&play=0`);
  const info = await page.evaluate(async () => {
    const reel = await window.reelReady;
    return { ...window.reelInfo, seconds: reel.seconds };
  });
  console.log(`${info.flight}: ${info.fixes} fixes to ${info.last} UTC (${info.source})`);
  if (!flag("no-lights") && !info.lights) throw new Error("the page did not load the night lights");

  const shoot = async (t) => {
    await page.evaluate((s) => window.reel.seek(s), t);
    return page.screenshot({ type: "png" });
  };
  const name = `${info.flight.replace(/\s+/g, "-")}${option("hours") ? `-${option("hours")}h` : ""}`;
  const outDir = join(root, "reels");
  mkdirSync(outDir, { recursive: true });

  if (option("stills")) {
    for (const t of option("stills").split(",").map(Number)) {
      const file = join(outDir, `${name}-${String(t).replace(".", "_")}s.png`);
      writeFileSync(file, await shoot(t));
      console.log(`wrote ${file}`);
    }
  } else {
    const out = option("out") ? resolve(option("out")) : join(outDir, `${name}.mp4`);
    const ffmpeg = spawn("ffmpeg", [
      "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
      "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p",
      "-vf", `scale=${WIDTH}:${HEIGHT}:flags=lanczos`,
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
      "-movflags", "+faststart", out,
    ], { stdio: ["pipe", "inherit", "inherit"] });
    const finished = new Promise((ok, no) => {
      ffmpeg.on("error", no);
      ffmpeg.on("close", (code) => (code === 0 ? ok() : no(new Error(`ffmpeg exited ${code}`))));
    });
    const frames = Math.round(info.seconds * fps);
    const started = Date.now();
    for (let i = 0; i < frames; i++) {
      const png = await shoot(i / fps);
      if (!ffmpeg.stdin.write(png)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
      if (i % fps === 0) {
        process.stdout.write(`\r${i}/${frames} frames, ${Math.round((Date.now() - started) / 1000)} s`);
      }
    }
    ffmpeg.stdin.end();
    await finished;
    console.log(`\rwrote ${out} (${info.seconds} s, ${frames} frames)`);
  }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
