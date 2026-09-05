/**
 * @file src/components/ui/comet-card.tsx
 * @description 3D tilt interactive card surface.
 */
import { useState, useRef, type MouseEvent, type ReactNode } from 'react'

export function CometCard({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [transform, setTransform] = useState('')

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    if (!cardRef.current) return
    const rect = cardRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const centerX = rect.width / 2
    const centerY = rect.height / 2

    const rotateX = ((y - centerY) / centerY) * -8
    const rotateY = ((x - centerX) / centerX) * 8

    setTransform(`perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`)
  }

  const handleMouseLeave = () => {
    setTransform('perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)')
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: decorative pointer-tilt effect; no action, no keyboard interaction applies.
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{ transform, transition: 'transform 0.15s ease-out' }}
      className={`relative overflow-hidden transition-all ${className}`}
    >
      {children}
    </div>
  )
}
