import * as Tooltip from '@radix-ui/react-tooltip'

// Accessible info tooltip: hover + keyboard focus + touch tap (tap focuses the
// button, which opens the Radix tooltip). Rendered in a portal with collision
// avoidance so it never gets clipped by the card.
export function InfoTip({ text, label = '지표 설명' }: { text: string; label?: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button type="button" className="info-tip" aria-label={label}>
          ⓘ
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="info-tip-content" sideOffset={6} collisionPadding={12} side="top">
          {text}
          <Tooltip.Arrow className="info-tip-arrow" width={11} height={6} />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
