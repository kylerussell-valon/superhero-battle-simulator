import type { RenderSettings } from '../render/pipeline'

/**
 * Agent-friendly debug overlay. Two jobs:
 *  1. a dense live telemetry readout (frame times, draw calls, chunk pipeline,
 *     destruction counters) so progress is visible without a profiler
 *  2. live tuning sliders for the render pipeline, so look/perf tradeoffs can be
 *     dialled in and captured from screenshots
 */

export interface DebugPanel {
  root: HTMLElement
  setVisible(v: boolean): void
  toggle(): void
  update(lines: string[]): void
  onSettings: ((s: RenderSettings) => void) | null
}

interface SliderSpec {
  key: keyof RenderSettings
  label: string
  min: number
  max: number
  step: number
}

const SLIDERS: SliderSpec[] = [
  { key: 'renderScale', label: 'internal res', min: 0.35, max: 1, step: 0.01 },
  { key: 'quantization', label: 'colour steps', min: 0, max: 64, step: 1 },
  { key: 'dither', label: 'dither', min: 0, max: 2, step: 0.05 },
  { key: 'vignette', label: 'vignette', min: 0, max: 0.8, step: 0.01 },
  { key: 'scanlines', label: 'scanlines', min: 0, max: 0.3, step: 0.01 },
  { key: 'bloom', label: 'bloom', min: 0, max: 1.2, step: 0.01 },
  { key: 'saturation', label: 'saturation', min: 0.5, max: 1.8, step: 0.01 },
  { key: 'aberration', label: 'aberration', min: 0, max: 1.5, step: 0.01 },
  { key: 'grain', label: 'grain', min: 0, max: 0.15, step: 0.005 },
  { key: 'grade', label: 'grade', min: 0, max: 1, step: 0.01 },
]

export function createDebugPanel(settings: RenderSettings, onScaleChange: () => void): DebugPanel {
  const root = document.createElement('div')
  root.style.cssText = `
    position:fixed; left:8px; top:8px; z-index:20; width:290px;
    font:11px/1.35 ui-monospace, Menlo, monospace; color:#cfe3ff;
    background:linear-gradient(180deg, rgba(8,14,28,0.82), rgba(6,10,20,0.72));
    border:1px solid #2f4a86; padding:8px 10px; letter-spacing:0.02em;
    backdrop-filter:blur(3px); pointer-events:auto;
  `
  const title = document.createElement('div')
  title.textContent = 'SBS // telemetry'
  title.style.cssText = 'color:#ffe066;letter-spacing:0.16em;margin-bottom:6px;font-size:10px;'

  const pre = document.createElement('pre')
  pre.style.cssText = 'margin:0;white-space:pre;font:inherit;color:#a9c7ef;'

  const tuning = document.createElement('details')
  tuning.style.cssText = 'margin-top:8px;border-top:1px solid #24406f;padding-top:6px;'
  const summary = document.createElement('summary')
  summary.textContent = 'render tuning'
  summary.style.cssText = 'cursor:pointer;color:#8fb2d4;font-size:10px;letter-spacing:0.12em;'
  tuning.appendChild(summary)

  const panel = { root, setVisible, toggle, update, onSettings: null as DebugPanel['onSettings'] }

  for (const s of SLIDERS) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:3px 0;'
    const label = document.createElement('span')
    label.textContent = s.label
    label.style.cssText = 'flex:0 0 96px;color:#8fb2d4;'
    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(s.min)
    input.max = String(s.max)
    input.step = String(s.step)
    input.value = String(settings[s.key])
    input.style.cssText = 'flex:1;height:12px;accent-color:#5f8dd6;'
    const val = document.createElement('span')
    val.textContent = input.value
    val.style.cssText = 'flex:0 0 34px;text-align:right;color:#dfe8ff;'
    input.addEventListener('input', () => {
      const v = Number(input.value)
      ;(settings[s.key] as number) = v
      val.textContent = String(v)
      panel.onSettings?.(settings)
      if (s.key === 'renderScale') onScaleChange()
    })
    row.append(label, input, val)
    tuning.appendChild(row)
  }

  root.append(title, pre, tuning)
  document.body.appendChild(root)

  function setVisible(v: boolean): void {
    root.style.display = v ? 'block' : 'none'
  }
  function toggle(): void {
    setVisible(root.style.display === 'none')
  }
  function update(lines: string[]): void {
    if (root.style.display === 'none') return
    pre.textContent = lines.join('\n')
  }
  return panel
}
