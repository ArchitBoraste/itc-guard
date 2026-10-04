import { Icon } from './Icon.jsx';

const TONES = new Set(['ok', 'warn', 'bad', 'info', 'neutral', 'muted', 'bad-solid']);

// A status label. Colour carries the status and the text says it too, so a chip
// is never colour alone (README principle 7).
export function Chip({ tone = 'muted', icon = null, pill = false, children, title, testId, ...rest }) {
  const toneClass = TONES.has(tone) ? `chip-${tone}` : 'chip-muted';
  return (
    <span
      className={`chip ${toneClass}${pill ? ' is-pill' : ''}`}
      title={title}
      data-testid={testId}
      data-tone={tone}
      {...rest}
    >
      {icon ? <Icon name={icon} size={12} strokeWidth={2.2} /> : null}
      {children}
    </span>
  );
}
