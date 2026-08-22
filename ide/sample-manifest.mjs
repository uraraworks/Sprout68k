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
  { id: 'hello', path: 'samples/hello.c', source: helloSource },
  { id: 'shapes', path: 'samples/shapes.c', source: shapesSource },
  { id: 'keyboard-input', path: 'samples/keyboard-input.c', source: keyboardInputSource },
  { id: 'move', path: 'samples/move.c', source: moveSource },
  { id: 'catch', path: 'samples/catch.c', source: catchSource },
  { id: 'breakout', path: 'samples/breakout/block.c', source: breakoutSource },
  { id: 'stars', path: 'samples/stars.c', source: starsSource },
  { id: 'life', path: 'samples/life.c', source: lifeSource },
];

/** 紹介ページ(samples.html)の「エディタで開く」から来た id を引く。 */
export function findSampleById(id) {
  return SAMPLE_FILES.find((sample) => sample.id === id) ?? null;
}

export async function loadSample(sample) {
  if (typeof sample.source !== 'string') throw new Error(`${sample.path}: サンプル本文がありません`);
  return sample.source;
}
