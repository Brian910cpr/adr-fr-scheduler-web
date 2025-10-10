// server/assign/assigner.ts
// Core assignment engine hooks with Volunteer Duty placeholder logic

import {
  VOLUNTEER_DUTY_ID,
  VOLUNTEER_DUTY_NAME,
  VOLUNTEER_DUTY_REASON,
  VOLUNTEER_DUTY_SCORE,
  isWeekendDriver
} from "../config/policy";

export type Role = "Member" | "Supervisor" | "Admin";

export interface Slot {
  id: string;
  position: string;
  startTime: Date;
  endTime: Date;
}

export interface Member {
  id: string;
  displayName: string;
  isPlaceholder?: boolean;
  active?: boolean;
}

export interface Actor {
  id: string;
  role: Role;
}

export interface Candidate {
  memberId: string;
  score: number;
  reason?: string;
  isPlaceholder?: boolean;
}

// Plug your existing baseScore logic here
function baseScore(slot: Slot, member: Member): number {
  // placeholder example scoring; real system likely more complex
  let score = 0;
  // ... your normal factors
  return score;
}

export function candidateList(slot: Slot, members: Member[]): Candidate[] {
  if (isWeekendDriver(slot)) {
    return [{
      memberId: VOLUNTEER_DUTY_ID,
      score: VOLUNTEER_DUTY_SCORE,
      reason: VOLUNTEER_DUTY_REASON,
      isPlaceholder: true
    }];
  }

  return members
    .filter(m => m.active !== false && !m.isPlaceholder)
    .map(m => ({
      memberId: m.id,
      score: baseScore(slot, m)
    }))
    .sort((a,b) => b.score - a.score);
}

export function canAssign(slot: Slot, actor: Actor, memberId: string): boolean {
  if (isWeekendDriver(slot)) {
    if (memberId === VOLUNTEER_DUTY_ID) return true; // always allowed
    return actor.role === "Supervisor" || actor.role === "Admin";
  }
  return true;
}

// Simple audit event stub (replace with your logger/event bus)
export function auditReplaceVolunteerDuty(slotId: string, oldAssignee: string, newAssignee: string, actorId: string) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    type: "ASSIGNMENT_REPLACED",
    slotId, oldAssignee, newAssignee, actorId, ts: new Date().toISOString()
  }));
}