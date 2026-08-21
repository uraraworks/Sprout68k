import helloSource from './samples/hello.c?raw';

export const SAMPLE_FILES = [
  { path: 'samples/hello.c', source: helloSource },
];

export async function loadSample(sample) {
  if (typeof sample.source !== 'string') throw new Error(`${sample.path}: サンプル本文がありません`);
  return sample.source;
}
