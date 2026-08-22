import helloSource from './samples/hello.c?raw';
import shapesSource from './samples/shapes.c?raw';
import keyboardInputSource from './samples/keyboard-input.c?raw';
import moveSource from './samples/move.c?raw';
import catchSource from './samples/catch.c?raw';
import breakoutSource from '../samples/breakout/block.c?raw';
import starsSource from './samples/stars.c?raw';
import lifeSource from './samples/life.c?raw';

/* 学習の順に並べる。前半は1本ごとに覚えることが1つずつ増える階段、
 * 後半(stars / life)は「見て楽しい作品」。 */
export const SAMPLE_FILES = [
  { path: 'samples/hello.c', source: helloSource },
  { path: 'samples/shapes.c', source: shapesSource },
  { path: 'samples/keyboard-input.c', source: keyboardInputSource },
  { path: 'samples/move.c', source: moveSource },
  { path: 'samples/catch.c', source: catchSource },
  { path: 'samples/breakout/block.c', source: breakoutSource },
  { path: 'samples/stars.c', source: starsSource },
  { path: 'samples/life.c', source: lifeSource },
];

export async function loadSample(sample) {
  if (typeof sample.source !== 'string') throw new Error(`${sample.path}: サンプル本文がありません`);
  return sample.source;
}
