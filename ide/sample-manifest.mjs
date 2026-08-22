import helloSource from './samples/hello.c?raw';
import keyboardInputSource from './samples/keyboard-input.c?raw';
import breakoutSource from '../samples/breakout/block.c?raw';

export const SAMPLE_FILES = [
  { path: 'samples/hello.c', source: helloSource },
  { path: 'samples/keyboard-input.c', source: keyboardInputSource },
  { path: 'samples/breakout/block.c', source: breakoutSource },
];

export async function loadSample(sample) {
  if (typeof sample.source !== 'string') throw new Error(`${sample.path}: サンプル本文がありません`);
  return sample.source;
}
