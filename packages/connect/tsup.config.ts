import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', desk: 'src/desk.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  splitting: false,
  treeshake: true,
});
