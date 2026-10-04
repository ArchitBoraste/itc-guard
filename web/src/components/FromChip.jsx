import { monthOf } from '../lib/calendar.js';
import { Chip } from './Chip.jsx';

// "From August": an earlier period's document arriving in the one on screen.
export function FromChip({ taxPeriod }) {
  return <Chip tone="info">From {monthOf(taxPeriod)}</Chip>;
}
