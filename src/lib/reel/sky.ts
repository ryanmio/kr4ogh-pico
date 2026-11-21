/** The reel's light: night, dusk, the air at the edge of the planet, the
 * sun and the stars, drawn over MapLibre's globe as one custom layer.
 *
 * The globe MapLibre draws is lit the same everywhere, at every hour. A
 * flight is not: the tracker runs on sunlight, so every flight is a
 * sequence of days and of nights it says nothing in, and the reel should
 * look like that. This is a single full-screen pass. For each pixel it
 * works out where the view ray meets the planet, and darkens the night
 * side, warms the terminator and hazes the limb; where the ray misses, it
 * draws the glow of the atmosphere, the sun, and stars behind it. Given a
 * picture of the Earth at night, it lights the towns on the dark side.
 *
 * It also reports the camera back to the scene (the matrix MapLibre
 * rendered with), which is how the balloon and its trail are drawn in
 * register with the ground.
 */
import type { CustomLayerInterface, CustomRenderMethodInput } from "maplibre-gl";
import type { Vec3 } from "./flightpath";

/** MapLibre's globe is a unit sphere with y through the pole and z through
 * 0N 0E; the flight path has z through the pole and x through 0N 0E. */
export const toGlobe = (v: Vec3): Vec3 => [v[1], v[2], v[0]];

export interface SkyState {
  /** Towards the sun, in the flight path's axes. */
  sun: Vec3;
  /** Thickness of the glow at the limb, in Earth radii. Wider than the
   * real air, in step with how far the balloon's height is drawn. */
  airDepth: number;
  /** Seconds into the reel, for the stars' twinkle. */
  time: number;
}

/** What the last frame was rendered with. */
export interface Camera {
  /** Globe space to clip space, column-major. */
  matrix: Float64Array;
  /** The eye, in globe space: Earth radii from the centre. */
  eye: Vec3;
}

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform vec3 u_eye;
uniform vec3 u_d00, u_d10, u_d01, u_d11;
uniform vec3 u_sun;
uniform float u_air;
uniform float u_sunUp;
uniform float u_time;
uniform int u_pass;
uniform sampler2D u_lights;
uniform float u_hasLights;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

// Stars: one, sometimes, in each cell of a grid the view ray passes
// through, pulled onto the sphere of directions so it is round from
// wherever it is seen.
vec3 stars(vec3 d) {
  const float N = 140.0;
  vec3 q = d * N;
  vec3 c = floor(q);
  float h = hash(c);
  if (h < 0.90) return vec3(0.0);
  vec3 at = c + 0.5 + (vec3(hash(c + 1.3), hash(c + 2.7), hash(c + 4.1)) - 0.5) * 0.7;
  at *= N / length(at);
  float r = length(q - at);
  float mag = pow((h - 0.90) / 0.10, 4.0);
  float twinkle = 0.80 + 0.20 * sin(u_time * 6.0 + h * 400.0);
  float core = 1.0 - smoothstep(0.0, 0.085 + 0.14 * mag, r);
  vec3 tint = mix(vec3(0.70, 0.82, 1.0), vec3(1.0, 0.90, 0.76), hash(c + 7.7));
  return tint * core * core * (0.38 + 1.6 * mag) * twinkle;
}

// The colour of lit air: blue by day, through gold to red where the sun
// is on the horizon of the place being looked at.
vec3 air(float sunHeight) {
  vec3 day = vec3(0.30, 0.56, 1.0);
  vec3 dusk = vec3(1.0, 0.42, 0.14);
  vec3 c = mix(dusk, day, smoothstep(-0.03, 0.13, sunHeight));
  return c * smoothstep(-0.20, 0.02, sunHeight);
}

void main() {
  vec3 ray = normalize(mix(mix(u_d00, u_d10, v_uv.x), mix(u_d01, u_d11, v_uv.x), v_uv.y));
  float b = dot(u_eye, ray);
  float c = dot(u_eye, u_eye) - 1.0;
  float disc = b * b - c;
  float toSun = max(dot(ray, u_sun), 0.0);
  // Glare, where the sun is in front of the lens and above the horizon.
  vec3 glare = vec3(1.0, 0.80, 0.56) * (pow(toSun, 7.0) * 0.20 + pow(toSun, 60.0) * 0.40) * u_sunUp;
  vec3 keep;
  vec3 plus;

  if (disc > 0.0 && -b - sqrt(disc) > 0.0) {
    vec3 p = u_eye + ray * (-b - sqrt(disc));
    float sunHeight = dot(p, u_sun);
    float day = smoothstep(-0.10, 0.14, sunHeight);
    // Night is moonlight: dim and blue, not black, so the sea and the
    // coast being crossed are still there.
    keep = mix(vec3(0.20, 0.30, 0.55), vec3(1.0), day);
    plus = vec3(0.008, 0.016, 0.038) * (1.0 - day);
    // The terminator, warm.
    float band = exp(-pow((sunHeight - 0.02) / 0.075, 2.0));
    keep *= mix(vec3(1.0), vec3(1.12, 0.86, 0.66), band);
    plus += vec3(0.30, 0.12, 0.03) * band * 0.10;
    // Towns, where it is dark.
    if (u_hasLights > 0.5) {
      float lon = atan(p.x, p.z);
      float lat = asin(clamp(p.y, -1.0, 1.0));
      vec3 lit = texture(u_lights, vec2(lon / 6.2831853 + 0.5, 0.5 - lat / 3.14159265)).rgb;
      float glow = max(dot(lit, vec3(0.30, 0.50, 0.20)) - 0.075, 0.0);
      plus += vec3(1.0, 0.78, 0.46) * pow(glow, 1.25) * 3.2 * (1.0 - smoothstep(-0.12, 0.02, sunHeight));
    }
    // Air between the eye and the ground, thickest at the limb.
    float graze = pow(1.0 - max(dot(p, -ray), 0.0), 5.0);
    keep *= 1.0 - 0.55 * graze;
    plus += air(sunHeight) * graze * 0.75 + vec3(0.03, 0.07, 0.13) * graze * (1.0 - day);
    plus += glare * (0.22 + 0.6 * graze);
  } else {
    // Past the planet: how close the ray comes to the ground decides how
    // much air it looks through.
    float along = max(-b, 0.0);
    vec3 nearest = u_eye + ray * along;
    float height = max(length(nearest) - 1.0, 0.0);
    float glow = exp(-height / u_air);
    float inner = exp(-height / (u_air * 0.28));
    float sunHeight = dot(normalize(nearest), u_sun);
    vec3 sky = air(sunHeight) * (glow * 0.55 + inner * 0.75);
    // By night the edge still shows: airglow, thin and green-blue.
    sky += vec3(0.05, 0.17, 0.20) * inner * (1.0 - smoothstep(-0.25, 0.0, sunHeight));
    sky += vec3(1.0, 0.70, 0.40) * pow(toSun, 24.0) * glow * 1.1 * smoothstep(-0.25, -0.02, sunHeight);
    float disk = smoothstep(0.999955, 0.99998, toSun);
    vec3 sun = (vec3(1.0, 0.97, 0.90) * disk * 3.0
      + vec3(1.0, 0.86, 0.66) * (pow(toSun, 2500.0) * 1.5 + pow(toSun, 250.0) * 0.6)) * u_sunUp;
    // The band of the galaxy, faintly, to give the dark some depth.
    vec3 pole = normalize(vec3(0.42, 0.55, -0.72));
    float galaxy = exp(-pow(dot(ray, pole) / 0.16, 2.0));
    vec3 space = vec3(0.010, 0.016, 0.036) + vec3(0.030, 0.034, 0.060) * galaxy;
    vec3 starry = stars(ray) + stars(ray.zxy * 1.37) * 0.6 * (0.5 + galaxy);
    keep = vec3(0.0);
    plus = space + starry * (1.0 - min(1.0, glow * 1.8)) + sky + sun + glare;
  }
  o = u_pass == 0 ? vec4(keep, 1.0) : vec4(plus, 1.0);
}`;

function invert(m: ArrayLike<number>): Float64Array | null {
  const a = Array.from(m) as number[];
  const inv = new Float64Array(16);
  inv[0] = a[5]! * a[10]! * a[15]! - a[5]! * a[11]! * a[14]! - a[9]! * a[6]! * a[15]! + a[9]! * a[7]! * a[14]! + a[13]! * a[6]! * a[11]! - a[13]! * a[7]! * a[10]!;
  inv[4] = -a[4]! * a[10]! * a[15]! + a[4]! * a[11]! * a[14]! + a[8]! * a[6]! * a[15]! - a[8]! * a[7]! * a[14]! - a[12]! * a[6]! * a[11]! + a[12]! * a[7]! * a[10]!;
  inv[8] = a[4]! * a[9]! * a[15]! - a[4]! * a[11]! * a[13]! - a[8]! * a[5]! * a[15]! + a[8]! * a[7]! * a[13]! + a[12]! * a[5]! * a[11]! - a[12]! * a[7]! * a[9]!;
  inv[12] = -a[4]! * a[9]! * a[14]! + a[4]! * a[10]! * a[13]! + a[8]! * a[5]! * a[14]! - a[8]! * a[6]! * a[13]! - a[12]! * a[5]! * a[10]! + a[12]! * a[6]! * a[9]!;
  inv[1] = -a[1]! * a[10]! * a[15]! + a[1]! * a[11]! * a[14]! + a[9]! * a[2]! * a[15]! - a[9]! * a[3]! * a[14]! - a[13]! * a[2]! * a[11]! + a[13]! * a[3]! * a[10]!;
  inv[5] = a[0]! * a[10]! * a[15]! - a[0]! * a[11]! * a[14]! - a[8]! * a[2]! * a[15]! + a[8]! * a[3]! * a[14]! + a[12]! * a[2]! * a[11]! - a[12]! * a[3]! * a[10]!;
  inv[9] = -a[0]! * a[9]! * a[15]! + a[0]! * a[11]! * a[13]! + a[8]! * a[1]! * a[15]! - a[8]! * a[3]! * a[13]! - a[12]! * a[1]! * a[11]! + a[12]! * a[3]! * a[9]!;
  inv[13] = a[0]! * a[9]! * a[14]! - a[0]! * a[10]! * a[13]! - a[8]! * a[1]! * a[14]! + a[8]! * a[2]! * a[13]! + a[12]! * a[1]! * a[10]! - a[12]! * a[2]! * a[9]!;
  inv[2] = a[1]! * a[6]! * a[15]! - a[1]! * a[7]! * a[14]! - a[5]! * a[2]! * a[15]! + a[5]! * a[3]! * a[14]! + a[13]! * a[2]! * a[7]! - a[13]! * a[3]! * a[6]!;
  inv[6] = -a[0]! * a[6]! * a[15]! + a[0]! * a[7]! * a[14]! + a[4]! * a[2]! * a[15]! - a[4]! * a[3]! * a[14]! - a[12]! * a[2]! * a[7]! + a[12]! * a[3]! * a[6]!;
  inv[10] = a[0]! * a[5]! * a[15]! - a[0]! * a[7]! * a[13]! - a[4]! * a[1]! * a[15]! + a[4]! * a[3]! * a[13]! + a[12]! * a[1]! * a[7]! - a[12]! * a[3]! * a[5]!;
  inv[14] = -a[0]! * a[5]! * a[14]! + a[0]! * a[6]! * a[13]! + a[4]! * a[1]! * a[14]! - a[4]! * a[2]! * a[13]! - a[12]! * a[1]! * a[6]! + a[12]! * a[2]! * a[5]!;
  inv[3] = -a[1]! * a[6]! * a[11]! + a[1]! * a[7]! * a[10]! + a[5]! * a[2]! * a[11]! - a[5]! * a[3]! * a[10]! - a[9]! * a[2]! * a[7]! + a[9]! * a[3]! * a[6]!;
  inv[7] = a[0]! * a[6]! * a[11]! - a[0]! * a[7]! * a[10]! - a[4]! * a[2]! * a[11]! + a[4]! * a[3]! * a[10]! + a[8]! * a[2]! * a[7]! - a[8]! * a[3]! * a[6]!;
  inv[11] = -a[0]! * a[5]! * a[11]! + a[0]! * a[7]! * a[9]! + a[4]! * a[1]! * a[11]! - a[4]! * a[3]! * a[9]! - a[8]! * a[1]! * a[7]! + a[8]! * a[3]! * a[5]!;
  inv[15] = a[0]! * a[5]! * a[10]! - a[0]! * a[6]! * a[9]! - a[4]! * a[1]! * a[10]! + a[4]! * a[2]! * a[9]! + a[8]! * a[1]! * a[6]! - a[8]! * a[2]! * a[5]!;
  const det = a[0]! * inv[0]! + a[1]! * inv[4]! + a[2]! * inv[8]! + a[3]! * inv[12]!;
  if (!det) return null;
  for (let i = 0; i < 16; i++) inv[i] = inv[i]! / det;
  return inv;
}

function apply(m: Float64Array, x: number, y: number, z: number, w: number): [number, number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]! * w,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]! * w,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]! * w,
    m[3]! * x + m[7]! * y + m[11]! * z + m[15]! * w,
  ];
}

/** The layer. `state` is read each frame; `onCamera` is called each frame
 * with what MapLibre rendered with, after the sky is drawn. */
export function skyLayer(
  state: () => SkyState, onCamera: (camera: Camera) => void, lights: TexImageSource | null = null,
): CustomLayerInterface {
  let program: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let lightsTex: WebGLTexture | null = null;
  const loc: Record<string, WebGLUniformLocation | null> = {};

  return {
    id: "reel-sky",
    type: "custom",
    renderingMode: "2d",
    onAdd(_map, gl: WebGL2RenderingContext) {
      const compile = (type: number, src: string) => {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
          throw new Error(`reel sky shader: ${gl.getShaderInfoLog(s)}`);
        }
        return s;
      };
      program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`reel sky program: ${gl.getProgramInfoLog(program)}`);
      }
      for (const name of ["u_eye", "u_d00", "u_d10", "u_d01", "u_d11", "u_sun", "u_air",
        "u_sunUp", "u_time", "u_pass", "u_lights", "u_hasLights"]) {
        loc[name] = gl.getUniformLocation(program, name);
      }
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const at = gl.getAttribLocation(program, "a_pos");
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      if (lights) {
        lightsTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, lightsTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, lights);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
    },
    render(gl: WebGL2RenderingContext | WebGLRenderingContext, args: CustomRenderMethodInput) {
      const g = gl as WebGL2RenderingContext;
      const matrix = Float64Array.from(args.defaultProjectionData.mainMatrix as ArrayLike<number>);
      const inv = invert(matrix);
      if (!inv || !program) return;
      // The eye is the one point every view ray passes through: what the
      // matrix sends to the centre of the screen at no depth at all.
      const e = apply(inv, 0, 0, 1, 0);
      const eye: Vec3 = [e[0] / e[3], e[1] / e[3], e[2] / e[3]];
      const corner = (x: number, y: number): Vec3 => {
        const p = apply(inv, x, y, 1, 1);
        return [p[0] / p[3] - eye[0], p[1] / p[3] - eye[1], p[2] / p[3] - eye[2]];
      };
      const s = state();
      const sun = toGlobe(s.sun);
      // How far the sun stands clear of the planet's edge as seen from the
      // eye, for the glare: none while the ground is in the way.
      const eyeLen = Math.hypot(eye[0], eye[1], eye[2]);
      const horizonDip = Math.acos(Math.min(1, 1 / eyeLen));
      const sunHeight = Math.asin(
        (eye[0] * sun[0] + eye[1] * sun[1] + eye[2] * sun[2]) / eyeLen) + horizonDip;
      const sunUp = Math.min(1, Math.max(0, sunHeight / 0.05));

      g.useProgram(program);
      g.uniform3fv(loc.u_eye!, eye);
      g.uniform3fv(loc.u_d00!, corner(-1, -1));
      g.uniform3fv(loc.u_d10!, corner(1, -1));
      g.uniform3fv(loc.u_d01!, corner(-1, 1));
      g.uniform3fv(loc.u_d11!, corner(1, 1));
      g.uniform3fv(loc.u_sun!, sun);
      g.uniform1f(loc.u_air!, s.airDepth);
      g.uniform1f(loc.u_sunUp!, sunUp);
      g.uniform1f(loc.u_time!, s.time);
      g.uniform1f(loc.u_hasLights!, lightsTex ? 1 : 0);
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, lightsTex);
      g.uniform1i(loc.u_lights!, 0);
      g.disable(g.DEPTH_TEST);
      g.disable(g.STENCIL_TEST);
      g.disable(g.CULL_FACE);
      g.enable(g.BLEND);
      g.bindVertexArray(vao);
      // Twice over: once to dim what MapLibre drew, in colour, and once
      // to add the light on top. One pass could only dim it grey.
      g.uniform1i(loc.u_pass!, 0);
      g.blendFuncSeparate(g.ZERO, g.SRC_COLOR, g.ZERO, g.ONE);
      g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
      g.uniform1i(loc.u_pass!, 1);
      g.blendFunc(g.ONE, g.ONE);
      g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
      g.bindVertexArray(null);
      g.bindTexture(g.TEXTURE_2D, null);
      onCamera({ matrix, eye });
    },
  };
}
