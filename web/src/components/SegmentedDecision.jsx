// Accept / Reject / Pending for one IMS record. The selected one is solid
// ok / bad / warn and aria-pressed; choosing it again clears the decision, which
// sends the record back to Not decided.
//
// Pending is refused by the portal on records it blocks, and it would reject the
// whole upload over one of them, so the button is never offered there.
const OPTIONS = [
  { action: 'ACCEPT', label: 'Accept', className: 'is-accept' },
  { action: 'REJECT', label: 'Reject', className: 'is-reject' },
  { action: 'PENDING', label: 'Pending', className: 'is-pending' }
];

export function SegmentedDecision({
  value = null,
  onChange,
  disabled = false,
  disabledReason = null,
  pendingBlocked = false,
  busy = false,
  label = 'Decision'
}) {
  return (
    <div className="segmented" role="group" aria-label={label} aria-busy={busy || undefined}>
      {OPTIONS.map((option) => {
        const blocked = option.action === 'PENDING' && pendingBlocked;
        const pressed = value === option.action;
        return (
          <button
            key={option.action}
            type="button"
            className={option.className}
            aria-pressed={pressed}
            disabled={disabled || busy || blocked}
            title={
              blocked
                ? 'The portal does not allow Pending on this record'
                : disabled
                  ? disabledReason ?? undefined
                  : pressed
                    ? `Clear ${option.label}`
                    : undefined
            }
            onClick={() => onChange(pressed ? null : option.action)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
