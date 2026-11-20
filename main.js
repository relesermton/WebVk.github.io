/**
 * playground/main.js — live controls on top of the same WebVk scene as
 * demo/. Everything is plain DOM + the public API; no bundler, no server
 * code, all URLs relative so this directory can be dropped onto any
 * static host alongside dist/, src/ and demo/.
 */

import { WebVk, VkStat } from '../src/webvk.js';
import { TriangleScene } from '../src/scene.mjs';

const $ = (id) => document.getElementById(id);
const statsEl = $('stats');
const errEl = $('err');
const fail = (e) => { errEl.textContent = `error: ${e.stack ?? e}`; console.error(e); };

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
  1,
];

const DEFAULTS = {
  speed: 1, scale: 0.5, cull: '2', depth: true, blend: true,
  clear: '#101826', colors: ['#ff3333', '#33ff33', '#4d66ff'],
};

try {
  const wv = await WebVk.load(new URL('../dist/webvk.wasm', import.meta.url));
  const scene = new TriangleScene(wv, { width: 128, height: 128 });

  const viewport = wv.createViewport({
    canvas: $('raw'), video: $('presented'),
    width: 128, height: 128,
    turbo: true, fps: 60,
  });
  await viewport.start();

  let running = true;
  let turbo = true;
  let simTime = 0;
  let frames = 0;
  let lastFpsAt = performance.now();
  let fps = 0;
  let clearRgb = hexToRgb(DEFAULTS.clear);

  const clearHex = $('clear');
  const colorInputs = [$('c0'), $('c1'), $('c2')];

  function applyOptions() {
    scene.setOptions({
      speed: Number($('speed').value),
      scaleX: Number($('scale').value),
      cullMode: Number($('cull').value),
      depthTest: $('depth').checked,
      blend: $('blend').checked,
      colors: colorInputs.map((el) => hexToRgb(el.value)),
    });
    clearRgb = hexToRgb(clearHex.value);
    $('speed-v').textContent = Number($('speed').value).toFixed(2);
    $('scale-v').textContent = Number($('scale').value).toFixed(2);
  }

  for (const id of ['speed', 'scale', 'cull', 'depth', 'blend', 'clear']) {
    $(id).addEventListener('input', applyOptions);
  }
  colorInputs.forEach((el) => el.addEventListener('input', applyOptions));
  applyOptions();

  function frame(now) {
    if (!running) return;
    const steps = turbo ? 4 : 1;
    try {
      for (let i = 0; i < steps; i++) {
        simTime += 1 / 60;
        scene.render(simTime, clearRgb);
      }
      scene.present(viewport);
    } catch (e) { fail(e); return; }

    frames++;
    if (now - lastFpsAt > 500) {
      fps = (frames * 1000) / (now - lastFpsAt);
      frames = 0;
      lastFpsAt = now;
    }
    const s = scene.stats();
    statsEl.innerHTML =
      `fps <b>${fps.toFixed(0)}</b>  turbo <b>${turbo ? 'ON' : 'off'}</b>  ` +
      `draws <b>${s.DRAW_CALLS}</b>  pixels <b>${s.PIXELS_SHADED}</b>  ` +
      `presents <b>${s.PRESENTS}</b>  gc <b>${s.GC_OBJECTS}</b>  ` +
      `alive <b>${s.OBJECTS_ALIVE}</b>`;
    requestAnimationFrame(frame);
  }
  frame(performance.now());

  $('turbo').onclick = async () => {
    turbo = !turbo;
    await viewport.setTurbo(turbo);
    $('turbo').textContent = turbo ? 'turbo: ON' : 'turbo: off';
    $('turbo').classList.toggle('on', turbo);
  };
  $('toggle').onclick = () => {
    running = !running;
    $('toggle').textContent = running ? 'pause' : 'resume';
    if (running) requestAnimationFrame(frame);
  };
  $('reset').onclick = () => {
    $('speed').value = DEFAULTS.speed;
    $('scale').value = DEFAULTS.scale;
    $('cull').value = DEFAULTS.cull;
    $('depth').checked = DEFAULTS.depth;
    $('blend').checked = DEFAULTS.blend;
    clearHex.value = DEFAULTS.clear;
    colorInputs.forEach((el, i) => { el.value = DEFAULTS.colors[i]; });
    simTime = 0;
    applyOptions();
  };

  Object.assign(window, { webvk: { wv, scene, viewport, VkStat } });
} catch (e) {
  fail(e);
}
