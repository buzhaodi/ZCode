/**
 * 修改 ELF64 共享库的 LOAD 段对齐从 0x1000 (4KB) 到 0x4000 (16KB)。
 *
 * Android 15 的 16KB 页内核会拒绝 p_align < 16384 的 .so 文件。
 * nodejs-mobile 的预编译 libnode.so 用 4KB 对齐，需要补丁为 16KB。
 *
 * 原理：ELF64 的 program header 中 p_align 字段在偏移 48 处（每个 header 56 字节）。
 * 只修改 LOAD 类型的 segment 的 p_align。
 */
import { readFileSync, writeFileSync } from "node:fs";

const ELF64_EHDR_SIZE = 64;
const ELF64_PHDR_SIZE = 56;
const PT_LOAD = 1;
const P_ALIGN_OFFSET = 48; // p_align 在 program header 中的字节偏移
const OLD_ALIGN = 0x1000;  // 4KB
const NEW_ALIGN = 0x4000;  // 16KB

function patchElfAlignment(filePath) {
  const buf = readFileSync(filePath);

  // 验证 ELF 魔数
  if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    throw new Error(`${filePath}: not an ELF file`);
  }

  // 检查 ELF 类 (1=32bit, 2=64bit)
  if (buf[4] !== 2) {
    throw new Error(`${filePath}: not ELF64 (class=${buf[4]})`);
  }

  // 读取 e_phoff (program header table offset) — 在 ELF64 header 偏移 32 处，8字节
  const e_phoff = Number(buf.readBigUInt64LE(32));
  // 读取 e_phnum (program header count) — 在 ELF64 header 偏移 56 处，2字节
  const e_phnum = buf.readUInt16LE(56);
  // 读取 e_phentsize — 在 ELF64 header 偏移 54 处，2字节
  const e_phentsize = buf.readUInt16LE(54);

  console.log(`  e_phoff=${e_phoff}, e_phnum=${e_phnum}, e_phentsize=${e_phentsize}`);

  let patched = 0;
  for (let i = 0; i < e_phnum; i++) {
    const phdrOffset = e_phoff + i * e_phentsize;
    const p_type = buf.readUInt32LE(phdrOffset); // 偏移 0: p_type

    if (p_type !== PT_LOAD) continue;

    // p_align 在偏移 48 处，8字节
    const p_align_offset = phdrOffset + P_ALIGN_OFFSET;
    const p_align = Number(buf.readBigUInt64LE(p_align_offset));

    if (p_align === OLD_ALIGN) {
      buf.writeBigUInt64LE(BigInt(NEW_ALIGN), p_align_offset);
      patched++;
      console.log(`  LOAD[${i}]: p_align ${p_align.toString(16)} → ${NEW_ALIGN.toString(16)}`);
    } else if (p_align === NEW_ALIGN) {
      console.log(`  LOAD[${i}]: p_align already ${NEW_ALIGN.toString(16)}`);
    } else {
      console.log(`  LOAD[${i}]: p_align ${p_align.toString(16)} (unexpected, skipping)`);
    }
  }

  writeFileSync(filePath, buf);
  console.log(`  Patched ${patched} LOAD segments in ${filePath}`);
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: node patch-elf-align.mjs <file.so> [file2.so ...]");
  process.exit(1);
}

for (const file of files) {
  console.log(`Patching ${file}...`);
  try {
    patchElfAlignment(file);
  } catch (e) {
    console.error(`  ERROR: ${e.message}`);
  }
}
