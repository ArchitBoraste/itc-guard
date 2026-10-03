// Paths to the live demo's sample files (fixtures/demo/, committed), named the
// way the generator names them.
import { join } from 'node:path';
import { FIXTURES_DIR } from './fixtures.js';
import { imsFileName, registerFileName, twoBFileName } from '../../../tools/demo-timeline.js';

export const DEMO_DIR = join(FIXTURES_DIR, 'demo');

export const demoRegister = (periodKey) => join(DEMO_DIR, periodKey, registerFileName(periodKey));
export const demoIms = (periodKey, date) => join(DEMO_DIR, periodKey, imsFileName(periodKey, date));
export const demoTwoB = (periodKey) => join(DEMO_DIR, periodKey, twoBFileName(periodKey));
