import { RealtimeSection } from '../../components/RealtimeSection'
import { ScenarioSection } from '../scenario-outlook/ScenarioSection'

// "하이닉스 종목" group — realtime prices + technical scenario outlook move as
// one draggable unit, pinned to the top of the dashboard by default.
export function HynixGroupSection() {
  return (
    <div className="hynix-group">
      <RealtimeSection />
      <div style={{ height: 16 }} />
      <ScenarioSection />
    </div>
  )
}
