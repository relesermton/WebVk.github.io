/**
 * demo/main.js — an animated triangle driven entirely through the
 * vulkan.h-shaped JS API (src/webvk.js), presented the WebVk way:
 *
 *   wasm-gc rasterizer → linear memory → <canvas> blit
 *     → canvas.captureStream() → loopback RTCPeerConnection → <video>
 *
 * Turbo mode (on by default): frames are pushed explicitly with
 * requestFrame() after each blit, and several simulation steps run per
 * rAF tick. Together with one framebuffer per swapchain image (see
 * src/scene.mjs) this removes the alternating unrendered-image blink.
 */

import { WebVk, VkStat } from './webvk.js';
import { TriangleScene } from './scene.mjs';

const W = 128;
const H = 128;

const $ = (id) => document.getElementById(id);
const statsEl = $('stats');
const errEl = $('err');

function fail(e) {
  errEl.textContent = `error: ${e.stack ?? e}`;
  console.error(e);
}

try {
  /* ------------------------------------------------------- load core */
  const wv = await WebVk.load(new URL('./webvk.wasm', import.meta.url));
  const scene = new TriangleScene(wv, { width: W, height: H });

  /* --------------------------------------------------------- viewport */
  const viewport = wv.createViewport({
    canvas: $('raw'),
    video: $('presented'),
    width: W,
    height: H,
    turbo: true, // deterministic frames — no blinking
    fps: 60,     // only used when turbo is switched off
  });
  await viewport.start();

  /* -------------------------------------------------------- main loop */
  let running = true;
  let turbo = true;
  let simTime = 0;
  let frames = 0;
  let lastFpsAt = performance.now();
  let fps = 0;

  function frame(now) {
    if (!running) return;
    const steps = turbo ? 4 : 1; // turbo = 4× animation speed per tick
    const dt = 1 / 60;
    try {
      for (let i = 0; i < steps; i++) {
        simTime += dt;
        const clear = [
          0.05 + 0.05 * Math.sin(simTime * 0.7),
          0.07 + 0.05 * Math.sin(simTime * 0.5 + 2),
          0.12 + 0.05 * Math.sin(simTime * 0.3 + 4),
          1,
        ];
        scene.render(simTime, clear);
      }
      scene.present(viewport); // blit once (turbo pushes exactly this frame)
    } catch (e) {
      fail(e);
      return;
    }

    frames++;
    if (now - lastFpsAt > 500) {
      fps = (frames * 1000) / (now - lastFpsAt);
      frames = 0;
      lastFpsAt = now;
    }
    const s = scene.stats();
    statsEl.innerHTML =
      `fps <b>${fps.toFixed(0)}</b>  turbo <b>${turbo ? 'ON' : 'off'}</b>  ` +
      `draws <b>${s.DRAW_CALLS}</b>  tris <b>${s.TRIANGLES}</b>  ` +
      `pixels <b>${s.PIXELS_SHADED}</b>  presents <b>${s.PRESENTS}</b>  ` +
      `cmds <b>${s.CMDS_EXECUTED}</b>  gc <b>${s.GC_OBJECTS}</b>  ` +
      `memTop <b>0x${s.MEM_TOP.toString(16)}</b>`;
    requestAnimationFrame(frame);
  }
  // render one frame immediately so the canvas (and therefore the
  // captureStream) has content before the first rAF tick
  frame(performance.now());

  const toggle = $('toggle');
  toggle.hidden = false;
  toggle.onclick = () => {
    running = !running;
    toggle.textContent = running ? 'pause' : 'resume';
    if (running) requestAnimationFrame(frame);
  };

  const turboBtn = $('turbo');
  turboBtn.hidden = false;
  turboBtn.onclick = async () => {
    turbo = !turbo;
    await viewport.setTurbo(turbo);
    turboBtn.textContent = turbo ? 'turbo: ON' : 'turbo: off';
    turboBtn.classList.toggle('on', turbo);
  };

  Object.assign(window, { webvk: { wv, scene, viewport, VkStat } });
} catch (e) {
  fail(e);
}
