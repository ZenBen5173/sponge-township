/** GLSL for the water surface, rain streaks and the open-space overlay. */

const NOISE = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int k = 0; k < 4; k++){ s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return s; }
`;

const HOLES = /* glsl */ `
uniform vec4 uHoles[8];
uniform float uHoleRot[8];
uniform int uHoleN;
bool inHole(vec2 p){
  for (int k = 0; k < 8; k++){
    if (k >= uHoleN) break;
    vec4 r = uHoles[k];
    float c = cos(uHoleRot[k]); float s = sin(uHoleRot[k]);
    vec2 q = p - r.xy;
    vec2 u = vec2(q.x * c + q.y * s, -q.x * s + q.y * c);
    if (abs(u.x) < r.z && abs(u.y) < r.w) return true;
  }
  return false;
}
`;

export const waterVert = /* glsl */ `
attribute float depth;
attribute float ground;
attribute float speed;
attribute float other;
uniform int uMode;
varying float vDepth;
varying float vSpeed;
varying float vOther;
varying vec3 vWorld;
void main(){
  vDepth = depth; vSpeed = speed; vOther = other;
  float d = uMode == 2 ? max(depth, other) : depth;
  vec3 p = position;
  p.y = ground + (d > 0.004 ? d : -0.15);
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const waterFrag = /* glsl */ `
uniform float uTime;
uniform float uRain;
uniform vec3 uSun;
uniform float uLight;
uniform int uMode; // 0 realistic, 1 depth classes, 2 change vs. without
uniform float uHoleEnable;
varying float vDepth;
varying float vSpeed;
varying float vOther;
varying vec3 vWorld;
${NOISE}
${HOLES}
vec3 depthRamp(float d){
  vec3 c0 = vec3(0.86, 0.90, 1.00);
  vec3 c1 = vec3(0.36, 0.52, 0.97);
  vec3 c2 = vec3(0.24, 0.42, 0.96);
  vec3 c3 = vec3(0.12, 0.25, 0.69);
  vec3 c4 = vec3(0.07, 0.08, 0.20);
  if (d < 0.15) return mix(c0, c1, d / 0.15);
  if (d < 0.30) return mix(c1, c2, (d - 0.15) / 0.15);
  if (d < 0.60) return mix(c2, c3, (d - 0.30) / 0.30);
  return mix(c3, c4, clamp((d - 0.6) / 0.6, 0.0, 1.0));
}
vec3 diffRamp(float x){ // x = depth without − depth with (m): positive = design lowered the water
  vec3 good = vec3(0.18, 0.62, 0.30);
  vec3 neutral = vec3(0.80, 0.77, 0.70);
  vec3 bad = vec3(1.00, 0.35, 0.21);
  if (x > 0.0) return mix(neutral, good, smoothstep(0.0, 0.2, x));
  return mix(neutral, bad, smoothstep(0.0, 0.2, -x));
}
void main(){
  float d = uMode == 2 ? max(vDepth, vOther) : vDepth;
  if (d < 0.012) discard;
  if (uHoleEnable > 0.5 && inHole(vWorld.xz)) discard;
  vec3 V = normalize(cameraPosition - vWorld);
  float t = uTime;
  vec2 uv = vWorld.xz * 0.32;
  vec2 drift = vec2(t * 0.21, t * 0.13);
  float e = 0.12;
  float h0 = fbm(uv + drift);
  float hx = fbm(uv + vec2(e, 0.0) + drift);
  float hz = fbm(uv + vec2(0.0, e) + drift);
  float amp = 0.55 + uRain * 1.4;
  vec3 N = normalize(vec3((h0 - hx) * amp * 3.0, 1.0, (h0 - hz) * amp * 3.0));
  // rain rings
  if (uRain > 0.01) {
    vec2 g = vWorld.xz * 0.9;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    float ph = fract(t * 1.3 + hash12(id) * 7.0);
    float r = length(f - (vec2(hash12(id + 3.1), hash12(id + 7.7)) - 0.5) * 0.5);
    float ring = smoothstep(0.035, 0.0, abs(r - ph * 0.45)) * (1.0 - ph) * uRain;
    N = normalize(N + vec3(ring * 0.6, 0.0, ring * 0.6));
  }
  float fres = 0.03 + 0.97 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  // floodwater: silty teal, darker and bluer with depth (kept readable against sandy ground)
  vec3 shallow = vec3(0.42, 0.58, 0.60);
  vec3 deep = vec3(0.06, 0.25, 0.36);
  vec3 base = mix(shallow, deep, smoothstep(0.02, 0.6, d));
  if (uMode == 1) base = depthRamp(d);
  if (uMode == 2) base = diffRamp(vOther - vDepth);
  vec3 sky = mix(vec3(0.42, 0.50, 0.58), vec3(0.80, 0.86, 0.92), clamp(N.y, 0.0, 1.0)) * uLight;
  vec3 H = normalize(normalize(uSun) + V);
  float spec = pow(max(dot(N, H), 0.0), 140.0) * 1.6 * uLight;
  vec3 col = mix(base * (0.6 + 0.4 * uLight), sky, fres * (uMode == 0 ? 0.55 : 0.2)) + spec;
  // caustic shimmer so even still water reads as water from far away
  if (uMode == 0) col += vec3(0.05, 0.08, 0.09) * smoothstep(0.55, 0.9, fbm(vWorld.xz * 0.6 + vec2(t * 0.35, -t * 0.25)));
  float foam = smoothstep(0.7, 1.9, vSpeed) * smoothstep(0.45, 0.8, vnoise(vWorld.xz * 1.4 + vec2(t * 0.9, t * 0.4)));
  foam += (1.0 - smoothstep(0.012, 0.045, d)) * 0.45;
  if (uMode == 0) col = mix(col, vec3(0.88, 0.94, 0.95), clamp(foam, 0.0, 0.75));
  float a = smoothstep(0.012, 0.06, d) * mix(0.78, 0.96, smoothstep(0.05, 0.5, d));
  if (uMode != 0) a = smoothstep(0.012, 0.035, d) * 0.9;
  gl_FragColor = vec4(col, a);
}
`;

export const rainVert = /* glsl */ `
attribute vec3 seed;
attribute float tip;
uniform float uTime;
uniform vec3 uCenter;
uniform float uSpread;
uniform float uHeight;
varying float vTip;
void main(){
  float fall = 9.0;
  float y = mod(seed.y * uHeight - uTime * fall, uHeight);
  vec3 p = uCenter + vec3((seed.x - 0.5) * uSpread, y, (seed.z - 0.5) * uSpread);
  p += vec3(0.9, 1.6, 0.4) * tip; // streak towards where the drop came from (wind-blown)
  vTip = tip;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

export const rainFrag = /* glsl */ `
uniform float uOpacity;
varying float vTip;
void main(){ gl_FragColor = vec4(0.82, 0.88, 0.95, uOpacity * (0.25 + 0.75 * vTip)); }
`;

export const overlayVert = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main(){
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const overlayFrag = /* glsl */ `
uniform sampler2D uMask;
uniform vec2 uTexel;
uniform float uActive;
uniform float uTime;
uniform float uHoleEnable;
varying vec2 vUv;
varying vec3 vWorld;
${HOLES}
float idAt(vec2 uv){ return floor(texture2D(uMask, uv).r * 255.0 + 0.5); }
void main(){
  float id = idAt(vUv);
  if (id < 0.5) discard;
  if (uHoleEnable > 0.5 && inHole(vWorld.xz)) discard;
  float edge = 0.0;
  edge += step(0.5, abs(idAt(vUv + vec2(uTexel.x, 0.0)) - id));
  edge += step(0.5, abs(idAt(vUv - vec2(uTexel.x, 0.0)) - id));
  edge += step(0.5, abs(idAt(vUv + vec2(0.0, uTexel.y)) - id));
  edge += step(0.5, abs(idAt(vUv - vec2(0.0, uTexel.y)) - id));
  edge = clamp(edge, 0.0, 1.0);
  bool isActive = abs(id - uActive) < 0.5;
  vec3 col = isActive ? vec3(1.0, 0.35, 0.21) : vec3(1.0, 0.85, 0.30);
  float sweep = smoothstep(0.0, 1.0, 1.0 - abs(fract((vWorld.x + vWorld.z) * 0.004 - uTime * 0.18) - 0.5) * 6.0);
  float a = (isActive ? 0.30 : 0.16) + edge * 0.75 + sweep * 0.12;
  gl_FragColor = vec4(col + sweep * 0.15, a);
}
`;

export const terrainHoleChunk = HOLES;
