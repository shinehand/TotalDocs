import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const wasmPath = resolve(root, 'lib/generated/totaldocs_engine.wasm');
const wasmBytes = readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const e = instance.exports;

function encode({ width, height, margins, blocks }) {
  const bytes = new Uint8Array(4 + (8 + blocks.length * 6) * 4);
  bytes.set([0x54, 0x44, 0x4c, 0x4d], 0);
  const view = new DataView(bytes.buffer);
  let offset = 4;
  const u32 = value => {
    view.setUint32(offset, Number(value) >>> 0, true);
    offset += 4;
  };
  u32(1);
  u32(width);
  u32(height);
  u32(margins.top);
  u32(margins.right);
  u32(margins.bottom);
  u32(margins.left);
  u32(blocks.length);
  blocks.forEach(block => {
    u32(block.kind);
    u32(block.width);
    u32(block.height);
    u32(block.minHeight || 1);
    u32(block.flags || 0);
    u32(block.sourceIndex);
  });
  return bytes;
}

function layout(payload) {
  const input = encode(payload);
  assert.ok(input.length <= e.td_input_capacity(), 'fixture must fit wasm input buffer');
  const ptr = e.td_input_ptr();
  new Uint8Array(e.memory.buffer, ptr, input.length).set(input);
  const code = e.td_layout(input.length);
  assert.equal(code, 0, `td_layout failed with lastError=${e.td_last_error()}`);
  const outPtr = e.td_output_ptr();
  const outLen = e.td_output_len();
  const json = new TextDecoder().decode(new Uint8Array(e.memory.buffer, outPtr, outLen));
  return JSON.parse(json);
}

const simple = layout({
  width: 800,
  height: 1000,
  margins: { top: 100, right: 100, bottom: 100, left: 100 },
  blocks: [
    { kind: 1, width: 600, height: 500, sourceIndex: 0 },
    { kind: 1, width: 600, height: 400, sourceIndex: 1 },
  ],
});
assert.equal(simple.pageCount, 2);
assert.equal(simple.pages[0].boxes[0].sourceIndex, 0);
assert.equal(simple.pages[1].boxes[0].sourceIndex, 1);

const tall = layout({
  width: 800,
  height: 1000,
  margins: { top: 100, right: 100, bottom: 100, left: 100 },
  blocks: [
    { kind: 2, width: 600, height: 1800, sourceIndex: 7, flags: 3 },
  ],
});
assert.equal(tall.pageCount, 3);
assert.equal(tall.diagnostics.splitBlocks, 1);
assert.equal(tall.pages[0].boxes[0].fragmentCount, 3);
assert.equal(tall.pages[2].boxes[0].sourceStart, 1600);

console.log('TotalDocs engine smoke test passed');
