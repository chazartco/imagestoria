/**
 * Reads a .cube file: a 3D lookup table as text, the common way to hand a color grade from one program to another.
 * The result is what develop2 in src/shared/develop.js takes: `size` points a side and size*size*size*3 values
 * from 0 to 1, red changing fastest. Every way the file can be wrong gets its own sentence.
 */
export const MAX_CUBE_SIZE = 65;

export class CubeError extends Error {}

export function parseCube(text: string): { size: number; data: Float32Array; title: string } {
  if (text.includes('\u0000')) throw new CubeError('That is not a .cube file. A .cube file is plain text.');
  let size = 0, title = '', n = 0, line = 0, data: Float32Array | null = null;
  const lo = [0, 0, 0], hi = [1, 1, 1];
  const three = (parts: string[], what: string, at: number) => {
    const v = parts.map(Number);
    if (parts.length !== 3 || v.some((x) => !Number.isFinite(x))) throw new CubeError(`Line ${at} should be ${what}: three numbers. It reads "${parts.join(' ').slice(0, 40)}".`);
    return v as [number, number, number];
  };
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    line++;
    const s = rawLine.trim();
    if (!s || s.startsWith('#')) continue;
    const parts = s.split(/\s+/), key = parts[0]!.toUpperCase();
    if (/^[A-Z_]/.test(key)) {
      if (data && n > 0) throw new CubeError(`Line ${line} has a setting (${parts[0]}) after the table has started. Settings belong at the top of the file.`);
      if (key === 'TITLE') title = s.slice(5).trim().replace(/^"(.*)"$/, '$1').slice(0, 80);
      else if (key === 'LUT_1D_SIZE') throw new CubeError('That file holds a 1D table. Only 3D tables (LUT_3D_SIZE) can be used as a look.');
      else if (key === 'LUT_3D_SIZE') {
        size = Number(parts[1]);
        if (parts.length !== 2 || !Number.isInteger(size) || size < 2) throw new CubeError(`Line ${line} should give the size of the table as one whole number of 2 or more.`);
        if (size > MAX_CUBE_SIZE) throw new CubeError(`That table has ${size} points a side. The largest this app takes is ${MAX_CUBE_SIZE}.`);
        data = new Float32Array(size * size * size * 3);
      } else if (key === 'DOMAIN_MIN') lo.splice(0, 3, ...three(parts.slice(1), 'the lowest input', line));
      else if (key === 'DOMAIN_MAX') hi.splice(0, 3, ...three(parts.slice(1), 'the highest input', line));
      else if (key === 'LUT_3D_INPUT_RANGE') { const a = Number(parts[1]), b = Number(parts[2]); if (parts.length !== 3 || !Number.isFinite(a) || !Number.isFinite(b)) throw new CubeError(`Line ${line} should give the input range as two numbers.`); lo.fill(a); hi.fill(b); }
      else throw new CubeError(`Line ${line} starts with "${parts[0]!.slice(0, 30)}", which is not part of a .cube file.`);
      continue;
    }
    if (!data) throw new CubeError('That file has no LUT_3D_SIZE line before its numbers, so it cannot be read as a 3D table.');
    const v = three(parts, 'a color', line);
    if (n >= size * size * size) throw new CubeError(`That file has more colors than a table of ${size} points a side holds (${size * size * size}).`);
    data[n * 3] = v[0]; data[n * 3 + 1] = v[1]; data[n * 3 + 2] = v[2]; n++;
  }
  if (!data) throw new CubeError(text.trim() ? 'That file has no LUT_3D_SIZE line, so it cannot be read as a 3D table.' : 'That file is empty.');
  if (n !== size * size * size) throw new CubeError(`That file says ${size} points a side, which needs ${size * size * size} colors, and it has ${n}. It may have been cut short.`);
  for (let k = 0; k < 3; k++) if (!(hi[k]! > lo[k]!)) throw new CubeError('The input range in that file runs backward or has no width (DOMAIN_MIN and DOMAIN_MAX).');
  // Output goes to the screen as 0 to 1. A table made for a wider range is brought into it, and stray values are held at the ends.
  const wide = lo.some((v) => v !== 0) || hi.some((v) => v !== 1);
  for (let i = 0; i < data.length; i++) { let v = data[i]!; if (wide) v = (v - lo[i % 3]!) / (hi[i % 3]! - lo[i % 3]!); data[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  return { size, data, title };
}
