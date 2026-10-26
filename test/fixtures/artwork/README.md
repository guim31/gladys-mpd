# JPEG files for the artwork decoder

One synthetic 99 × 75 image (a Mandelbrot set over two gradients: sizes that are not a multiple of
the 8 or 16 px blocks), encoded on 25/10/2026 in the variants `src/artwork-resize.js` has to read:

- with Pillow 9.0 (libjpeg 8): `baseline-420.jpg`, `baseline-422.jpg`, `baseline-444.jpg`,
  `progressive-420.jpg`, `progressive-444.jpg`, `gray.jpg`, `gray-progressive.jpg`, `cmyk.jpg`
  (Adobe, inverted CMYK);
- with `cjpeg` of libjpeg-turbo (Debian 13): `restart.jpg` (restart markers every 3 MCUs),
  `restart-progressive.jpg` and `restart-progressive-422.jpg` (every row), `baseline-12.jpg`
  (1 × 2 sampling), and `arithmetic.jpg` (arithmetic coding, which the decoder refuses).

`test/artwork-resize.test.js` compares the decoder with jpeg-js on each of them.
