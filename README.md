# WebVk (WebVulkan)

A **Vulkan-shaped API in JavaScript** with a **wasm-gc core** — hand-assembled
to a `.wasm` binary with **zero npm dependencies** (no wabt, no binaryen, no
bundler). The core contains a **software rasterizer** that draws into linear
memory; presentation happens entirely on the JS side via a **WebRTC canvas
stream**.

```
 ┌────────────────────────────── JS (src/webvk.js) ─────────────────────────────┐
 │  vkCreateInstance / vkCmdDraw / vkQueueSubmit …   (vulkan.h recoded to .js) │
 │  Vk* handle classes · Vk* struct records · Vk* enums                        │
 │  Viewport: canvas → captureStream() → loopback RTCPeerConnection → video   │
 └───────────────────────────────────┬─────────────────────────────────────────┘
                                     │ i32 handles · i64 sizes · bytes in linear memory
 ┌───────────────────────────────────▼─────────────────────────────────────────┐
 │              wasm-gc core (src/core.mjs → dist/webvk.wasm)                  │
 │  gc heap: instances, devices, pipelines, command buffers + records          │
 │  linear memory: vertex buffers, attachments, staging                        │
 │  replay: beginRP → viewport/scissor → binds → push → draw → rasterize → RGBA8│
 └─────────────────────────────────────────────────────────────────────────────┘
```

## Running

```sh
node src/probe.mjs     # encoder regression (15 checks)
node src/build.mjs     # assemble dist/webvk.wasm + smoke test
node test/verify.mjs   # headless end-to-end: 48 checks + dist/triangle.png
node test/api.mjs      # same scene through the public JS API: 55 checks
node serve.mjs         # → http://localhost:8080/demo/
```

or all tests at once: `npm test` (npm is optional — every script is a plain
`node <file>` invocation).

To make the deploy bundle: `node src/package-static.mjs` (or `npm run pack`).
This writes **`Build/`** — a self-contained static site with every file at
the top level (no subfolders): `index.html`, `demo.html`, `playground.html`,
their `.js`, `webvk.wasm`, `webvk.js`, `scene.mjs`, `mem.mjs`, `README.md` and
`.nojekyll` (which makes GitHub Pages serve `.wasm` correctly). Upload the
*files inside* `Build/` as the root of your GitHub Pages repo.

The demo draws an animated, x-squeezed rotating triangle: the wasm-gc
rasterizer writes RGBA8 into linear memory, JS blits it to a `<canvas>`, and
the canvas stream is looped back over an `RTCPeerConnection` to a `<video>` —
WebVk's "swapchain presentation", with no presentation code in the core.

**Turbo mode** (on by default in both pages) pushes each frame explicitly
with `CanvasCaptureMediaStreamTrack.requestFrame()` instead of letting a
timer capture the canvas, and runs four simulation steps per animation tick.
Combined with **one framebuffer per swapchain image** (see `src/scene.mjs`)
this fixes the alternating unrendered-image "blink" that a single fixed
framebuffer produces once `vkQueuePresentKHR` starts flipping the index.

To host it: upload `dist/`, `src/`, `demo/` and `playground/` to any static
file host as-is — no build step and no server code. All URLs are relative;
serve `.wasm` as `application/wasm`. Locally, `node serve.mjs` does exactly
that at `http://localhost:8080/demo/` and `/playground/`.

## Layout

| path | what |
|---|---|
| `src/asm.mjs` | wasm encoder: sections, LEB128, instruction helpers, `compileWithReport` (maps V8 "offset N" → instruction name) |
| `src/core.mjs` | the module generator: types, globals, handle tables, every `wvk_*` export, the replay + rasterizer |
| `src/build.mjs` | fills function bodies one at a time, re-compiling after each — a failure is always attributed to function #N |
| `src/probe.mjs` | encoding regression tests for `asm.mjs` |
| `src/webvk.js` | public API: `vk*` functions, `Vk*` classes/enums, wasm loader, `Viewport` |
| `src/mem.mjs` | LE accessors over linear memory (adapted from Wine-2021 `Memory.TS`) |
| `test/verify.mjs` | raw `wvk_*` end-to-end test + PNG writer |
| `test/api.mjs` | the same scene through `src/webvk.js` |
| `demo/` | browser demo (animated triangle, WebRTC presentation, turbo toggle) |
| `playground/` | interactive playground — tweak pipeline state live (static-host friendly) |
| `serve.mjs` | zero-dep static file server |

## Design decisions

- **Handles are i32** (`0 == VK_NULL_HANDLE`); sizes cross as **i64**; floats
  cross as f32 parameters or bit-cast i32 in linear memory.
- **The wasm-gc heap is the object model** (structs/arrays for every Vulkan
  object); linear memory is for bulk bytes only.
- **Synchronous replay**: `vkQueueSubmit` executes the recorded list inline;
  `vkQueuePresentKHR` flips the swapchain index. There is no timeline — after
  submit, the frame is already in memory and the JS Viewport can blit it.
- **Presentation lives in JS** (by design): the core has no notion of a
  canvas, surface, or WebRTC. `Viewport.blit()` copies the current swapchain
  image (little-endian RGBA8 — exactly `ImageData` layout) into a canvas;
  `captureStream()` + a loopback `RTCPeerConnection` feed the `<video>`.
- **Near plane**: a triangle with any vertex at `w <= 0` is rejected whole.
- **Built-in shaders**: there is no shader compiler — `VkBuiltinShader`
  names the fixed vertex fetch / MVP transform and the perspective-correct
  interpolation the rasterizer performs; shader modules record stage + builtin.

## Exercises in wasm

`if/then/else` (opcode dispatch, scalar helpers), `i64` (allocation sizes,
`saturating truncation`), `f64` is available but the rasterizer is all `f32`,
`loop`/`br_if` (record growth, clear + scan loops), `export` (the whole
`wvk_*` surface + `memory`), `import` (`env.log` — declared **before** any
`defFunc`, since wasm function indices are `imports + funcsSoFar`), and the
GC proposal itself (`struct.new/get/set`, `array.new/get/set/len`, nullable
refs).
