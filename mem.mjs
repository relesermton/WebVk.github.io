/**
 * src/mem.mjs — little-endian accessors over WebVk's linear memory.
 *
 * Adapted from the Wine-2021 archive's forge-launcher/Memory.TS (flat
 * guest memory: LE accessors, C strings, hex dumps) and re-pointed at a
 * WebAssembly.Memory instead of a bare Uint8Array: the wasm-gc core owns
 * the bytes, this class is the JS side's window onto them — Vk* struct
 * fields, vertex data, push constants, packed create-infos.
 *
 * Differences from Memory.TS:
 *   - no named rwx regions: wasm linear memory is one flat space and the
 *     core validates its own accesses; bounds are still checked here so a
 *     bad pointer throws instead of reading undefined
 *   - view re-creation on memory.grow (the old buffer detaches)
 *   - f32/f64 accessors added (VkGraphicsPipelineCreateInfo floats,
 *     push-constant MVP matrices)
 *
 * Run-time note: `viewF32`/`viewU8` return live views — they become
 * detached if the core grows memory afterwards, so re-fetch after any
 * call that can allocate (or use the copy helpers).
 */

/** Bounds violation — carries the faulting address (Memory.TS parity). */
export class MemoryFault extends Error {
  constructor(message, addr) {
    super(message);
    this.name = 'MemoryFault';
    /** @type {number} faulting address (uint32) — Memory.TS parity */
    this.addr = addr >>> 0;
  }
}

export class Mem {
  /** @param {WebAssembly.Memory} mem */
  constructor(mem) {
    this.mem = mem;
    this._buf = null;
    this._u8 = null;
    this._dv = null;
  }

  /** re-view after memory.grow detaches the previous buffer */
  _sync() {
    const buf = this.mem.buffer;
    if (buf !== this._buf) {
      this._buf = buf;
      this._u8 = new Uint8Array(buf);
      this._dv = new DataView(buf);
    }
  }

  /** live byte view (detached after a grow — re-fetch then) */
  get u8() {
    this._sync();
    return this._u8;
  }

  /** Memory.TS parity alias */
  get bytes() {
    return this.u8;
  }

  get size() {
    return this.mem.buffer.byteLength;
  }

  _idx(addr, len) {
    this._sync();
    const a = addr >>> 0;
    if (a + len > this._u8.length) {
      throw new MemoryFault(
        `access violation: ${len}B @0x${a.toString(16)} outside 0x0-0x${this._u8.length.toString(16)}`,
        a,
      );
    }
    return a;
  }

  /** public probe — throws the same fault a read/write would */
  check(addr, len, _need = 'read') {
    this._idx(addr, len);
  }

  /* ------------------------------------------------------- integers */

  read8(addr) {
    return this.u8[this._idx(addr, 1)];
  }

  write8(addr, v) {
    this.u8[this._idx(addr, 1)] = v & 0xff;
  }

  readU16(addr) {
    const i = this._idx(addr, 2);
    return this.u8[i] | (this.u8[i + 1] << 8);
  }

  write16(addr, v) {
    const i = this._idx(addr, 2);
    this.u8[i] = v & 0xff;
    this.u8[i + 1] = (v >>> 8) & 0xff;
  }

  read32(addr) {
    const i = this._idx(addr, 4);
    return (
      (this.u8[i] |
        (this.u8[i + 1] << 8) |
        (this.u8[i + 2] << 16) |
        (this.u8[i + 3] << 24))
    ) | 0;
  }

  write32(addr, v) {
    const i = this._idx(addr, 4);
    const x = v | 0;
    this.u8[i] = x & 0xff;
    this.u8[i + 1] = (x >>> 8) & 0xff;
    this.u8[i + 2] = (x >>> 16) & 0xff;
    this.u8[i + 3] = (x >>> 24) & 0xff;
  }

  readU32(addr) {
    return this.read32(addr) >>> 0;
  }

  /* ------------------------------------------------------- floats */

  // NOTE: _idx() calls _sync(), which may replace this._dv after a
  // memory.grow. Bind the DataView *after* computing the index — writing
  // `this._dv.setFloat32(this._idx(...))` evaluates `this._dv` first and
  // would use the detached view. (Caught by the 128x128 browser demo.)
  readF32(addr) {
    const i = this._idx(addr, 4);
    return this._dv.getFloat32(i, true);
  }

  writeF32(addr, v) {
    const i = this._idx(addr, 4);
    this._dv.setFloat32(i, v, true);
  }

  readF64(addr) {
    const i = this._idx(addr, 8);
    return this._dv.getFloat64(i, true);
  }

  writeF64(addr, v) {
    const i = this._idx(addr, 8);
    this._dv.setFloat64(i, v, true);
  }

  /* ------------------------------------------------------- blocks */

  readBytes(addr, len) {
    const i = this._idx(addr, len);
    return this.u8.slice(i, i + len);
  }

  writeBytes(addr, data) {
    const i = this._idx(addr, data.length);
    this.u8.set(data, i);
  }

  /** NUL-terminated C string; clamps at the end of the space */
  cstring(addr, max = 512) {
    let out = '';
    let a = addr >>> 0;
    const end = this.size;
    for (let n = 0; n < max && a < end; n++, a++) {
      const b = this.u8[a];
      if (b === 0) break;
      out += String.fromCharCode(b);
    }
    return out;
  }

  fill(addr, len, byte = 0) {
    const i = this._idx(addr, len);
    this.u8.fill(byte & 0xff, i, i + len);
  }

  /* ------------------------------------------------------- views */

  /** live f32 view — re-fetch after any call that can grow memory */
  viewF32(addr, count) {
    const i = this._idx(addr, count * 4);
    this._sync();
    return new Float32Array(this._buf, i, count);
  }

  /** live u32 view (RGBA8 pixel words) */
  viewU32(addr, count) {
    const i = this._idx(addr, count * 4);
    this._sync();
    return new Uint32Array(this._buf, i, count);
  }

  /* ------------------------------------------------------ debug */

  /** classic 16-byte hex + ASCII dump (Memory.TS parity) */
  hexdump(addr, len = 64) {
    const lines = [];
    let a = addr >>> 0;
    let left = len;
    const end = this.size;
    while (left > 0) {
      const n = Math.min(16, left, end - a);
      if (n <= 0) break;
      let hex = '';
      let ascii = '';
      for (let k = 0; k < n; k++) {
        const b = this.u8[a + k];
        hex += b.toString(16).padStart(2, '0') + (k === 7 ? '  ' : ' ');
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      }
      lines.push(`${a.toString(16).padStart(8, '0')}  ${hex.padEnd(49, ' ')} |${ascii}|`);
      a += n;
      left -= n;
    }
    return lines.join('\n');
  }
}

/* ------------------------------ LE helpers (Memory.TS parity) */

export const u16le = (b, o) => b[o] | (b[o + 1] << 8);
export const u32le = (b, o) =>
  ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0);
export const i32le = (b, o) => u32le(b, o) | 0;
export const putU32le = (b, o, v) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
};

export default { Mem, MemoryFault, u16le, u32le, i32le, putU32le };
