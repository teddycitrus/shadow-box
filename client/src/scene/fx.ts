import * as THREE from 'three';

/** Procedural canvas textures and shaders shared by hit sparks, the screen flash and the arena. */

const cache = new Map<string, THREE.CanvasTexture>();

function canvasTexture(key: string, size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, h = size): THREE.CanvasTexture {
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = h;
  draw(c.getContext('2d')!, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, tex);
  return tex;
}

/** Seeded random so textures look the same on every load. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Spiky impact star, white with a soft falloff; tinted by the material. */
export function starburstTexture(): THREE.CanvasTexture {
  return canvasTexture('star', 256, (g, s) => {
    const r = rng(7);
    const c = s / 2;
    for (const [outer, inner, alpha, spikes] of [[0.5, 0.16, 0.55, 14], [0.4, 0.12, 1, 10]] as const) {
      g.beginPath();
      for (let i = 0; i < spikes * 2; i++) {
        const a = (i / (spikes * 2)) * Math.PI * 2 + r() * 0.12;
        const rad = (i % 2 === 0 ? outer * (0.7 + r() * 0.3) : inner * (0.8 + r() * 0.4)) * s;
        g.lineTo(c + Math.cos(a) * rad, c + Math.sin(a) * rad);
      }
      g.closePath();
      const grad = g.createRadialGradient(c, c, 0, c, c, outer * s);
      grad.addColorStop(0, `rgba(255,255,255,${alpha})`);
      grad.addColorStop(0.35, `rgba(255,255,255,${alpha * 0.9})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fill();
    }
  });
}

/** Round soft glow for cores and particles. */
export function glowTexture(): THREE.CanvasTexture {
  return canvasTexture('glow', 128, (g, s) => {
    const c = s / 2;
    const grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.18)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });
}

/** Thin shock ring. */
export function ringTexture(): THREE.CanvasTexture {
  return canvasTexture('ring', 256, (g, s) => {
    const c = s / 2;
    const grad = g.createRadialGradient(c, c, s * 0.4, c, c, s * 0.5);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.65, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });
}

/** Guard spark: a hexagonal shield outline with a bright arc, for blocked punches. */
export function guardTexture(): THREE.CanvasTexture {
  return canvasTexture('guard', 256, (g, s) => {
    const c = s / 2;
    g.lineJoin = 'round';
    for (const [rad, w, a] of [[0.42, 18, 0.25], [0.42, 7, 1], [0.3, 4, 0.6]] as const) {
      g.beginPath();
      for (let i = 0; i <= 6; i++) {
        const t = (i / 6) * Math.PI * 2 + Math.PI / 6;
        g.lineTo(c + Math.cos(t) * rad * s, c + Math.sin(t) * rad * s);
      }
      g.strokeStyle = `rgba(255,255,255,${a})`;
      g.lineWidth = w;
      g.stroke();
    }
    const grad = g.createRadialGradient(c, c, 0, c, c, s * 0.4);
    grad.addColorStop(0, 'rgba(255,255,255,0.7)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });
}

/** Banner art: original abstract chevrons and discs on a corner colour. */
export function bannerTexture(base: string, accent: string, seed: number): THREE.CanvasTexture {
  return canvasTexture(`banner${seed}${base}`, 128, (g, w) => {
    const h = 512;
    const r = rng(seed);
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(0, 0, 10, h);
    g.fillRect(w - 10, 0, 10, h);
    g.fillStyle = accent;
    g.beginPath();
    g.arc(w / 2, 120, 38, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = base;
    g.beginPath();
    g.arc(w / 2 + 14 * (r() - 0.5), 120, 22, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = accent;
    for (let i = 0; i < 4; i++) {
      const y = 200 + i * 52;
      g.beginPath();
      g.moveTo(16, y);
      g.lineTo(w / 2, y + 30);
      g.lineTo(w - 16, y);
      g.lineTo(w - 16, y + 14);
      g.lineTo(w / 2, y + 44);
      g.lineTo(16, y + 14);
      g.closePath();
      g.globalAlpha = 1 - i * 0.2;
      g.fill();
    }
    g.globalAlpha = 1;
    g.fillStyle = '#ffffff';
    g.fillRect(24, 430, w - 48, 6);
    // Ragged bottom edge.
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.moveTo(0, h);
    g.lineTo(0, h - 30);
    g.lineTo(w / 2, h - 2);
    g.lineTo(w, h - 30);
    g.lineTo(w, h);
    g.fill();
    g.globalCompositeOperation = 'source-over';
  }, 512);
}

/** Centre-ring floor emblem: concentric rings, a stylised fist-star and the KW monogram. */
export function floorLogoTexture(): THREE.CanvasTexture {
  return canvasTexture('floorlogo', 1024, (g, s) => {
    const c = s / 2;
    g.clearRect(0, 0, s, s);
    const ring = (r: number, w: number, col: string) => {
      g.beginPath();
      g.arc(c, c, r, 0, Math.PI * 2);
      g.strokeStyle = col;
      g.lineWidth = w;
      g.stroke();
    };
    g.fillStyle = 'rgba(155,20,30,0.85)';
    g.beginPath();
    g.arc(c, c, s * 0.46, 0, Math.PI * 2);
    g.fill();
    ring(s * 0.46, 14, '#f5c542');
    ring(s * 0.4, 6, '#ffffff');
    g.fillStyle = '#12131a';
    g.beginPath();
    g.arc(c, c, s * 0.37, 0, Math.PI * 2);
    g.fill();
    // Eight-point star.
    g.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? s * 0.34 : s * 0.14;
      g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
    }
    g.closePath();
    g.fillStyle = '#c1121f';
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = '#f5c542';
    g.stroke();
    // Tick marks around the outer band.
    g.fillStyle = '#f5c542';
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      g.save();
      g.translate(c + Math.cos(a) * s * 0.43, c + Math.sin(a) * s * 0.43);
      g.rotate(a);
      g.fillRect(-10, -3, 20, 6);
      g.restore();
    }
    g.font = 'italic 900 210px Impact, "Arial Black", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 16;
    g.strokeStyle = '#12131a';
    g.strokeText('KW', c, c + 8);
    g.fillStyle = '#ffffff';
    g.fillText('KW', c, c + 8);
  });
}

/** Ring apron skirt with the game title repeated, red and blue halves. */
export function apronTexture(): THREE.CanvasTexture {
  const t = canvasTexture('apron', 1024, (g, w) => {
    const h = 128;
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#7a0c14');
    grad.addColorStop(0.5, '#1a1530');
    grad.addColorStop(1, '#0c2a7a');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#f5c542';
    g.fillRect(0, 0, w, 8);
    g.fillRect(0, h - 8, w, 8);
    g.font = 'italic 900 64px Impact, "Arial Black", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText('KEYBOARD  WARRIOR', w / 2, h / 2 + 2);
  }, 128);
  return t;
}

/** Three-band ramp for MeshToonMaterial. */
let toonRamp: THREE.DataTexture | null = null;
export function toonGradient(): THREE.DataTexture {
  if (toonRamp) return toonRamp;
  const steps = [60, 135, 215];
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  toonRamp = new THREE.DataTexture(data, steps.length, 1, THREE.RGBAFormat);
  toonRamp.minFilter = toonRamp.magFilter = THREE.NearestFilter;
  toonRamp.generateMipmaps = false;
  toonRamp.needsUpdate = true;
  return toonRamp;
}

/**
 * Inverted-hull outline: back faces pushed out along view-space normals by a constant world
 * thickness, so non-uniformly scaled limbs get an even line.
 */
export function outlineMaterial(thickness = 0.008, color = 0x07070c): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uT: { value: thickness }, uColor: { value: new THREE.Color(color) } },
    vertexShader: /* glsl */ `
      uniform float uT;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        mv.xyz += n * uT;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      void main() {
        gl_FragColor = vec4(uColor, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
  });
}

/** Camera-facing quad shader: object origin is the centre, position.xy is the offset. */
export const BILLBOARD_VERT = /* glsl */ `
  uniform float uScale;
  uniform float uRot;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float c = cos(uRot), s = sin(uRot);
    mv.xy += vec2(c * position.x - s * position.y, s * position.x + c * position.y) * uScale;
    gl_Position = projectionMatrix * mv;
  }`;

export function billboardMaterial(map: THREE.Texture, color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uScale: { value: 1 },
      uRot: { value: 0 },
      uOpacity: { value: 1 },
      uColor: { value: new THREE.Color(color) },
      uMap: { value: map },
    },
    vertexShader: BILLBOARD_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        vec4 t = texture2D(uMap, vUv);
        gl_FragColor = vec4(uColor * t.rgb * t.a * uOpacity, 1.0);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
}
