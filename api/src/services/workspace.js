// Workspace-wide actions: things that change what every screen of one workspace
// shows at once.
import { reevaluateRuns } from './reconcile.js';
import { writeWorkspaceClock } from './workspaceClock.js';

// Moves the workspace's date (null: back to following today) and re-evaluates
// every reconciled period against it, so nothing on screen keeps describing the
// old day. Nothing is re-uploaded. -> { clock, reruns }
export async function changeWorkspaceClock(orgId, asOfDate) {
  const clock = await writeWorkspaceClock(orgId, asOfDate);
  const reruns = await reevaluateRuns(orgId);
  return { clock, reruns };
}
