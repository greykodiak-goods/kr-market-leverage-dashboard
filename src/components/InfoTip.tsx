import * as Popover from '@radix-ui/react-popover'

// Single shared info control for every metric ⓘ. Implemented as a Popover so a
// TAP/CLICK toggles it — this fixes the mobile bug where a hover/focus Tooltip
// closed itself on the same tap. Behavior:
//   - mobile: tap to open (stays open), tap outside or the ⓘ again to close
//   - desktop: click to open/close (hover-based tooltips vanished on touch)
//   - keyboard: focus + Enter/Space toggles, Esc closes
//   - portalled with collision padding so it never clips inside a card
export function InfoTip({ text, label = '지표 설명' }: { text: string; label?: string }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="info-tip" aria-label={label}>
          ⓘ
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="info-tip-content" sideOffset={6} collisionPadding={12} side="top">
          {text}
          <Popover.Arrow className="info-tip-arrow" width={11} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
