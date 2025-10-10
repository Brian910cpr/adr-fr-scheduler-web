// server/validators/fatigueValidator.ts
// 36-hour stretch validator: flags yellow and triggers notices

import { THIRTY_SIX_HOUR_REASON, contiguousStretchHours } from "../config/policy";

export interface ShiftRow {
  slotId: string;
  memberId: string;
  startTime: Date;
  endTime: Date;
  // presentation flags:
  color?: "yellow" | "red" | "none";
  labels?: string[];
}

export interface MemberShifts {
  memberId: string;
  shifts: ShiftRow[]; // must be sorted by startTime ascending
}

export interface Notice {
  to: "member" | "supervisor";
  memberId: string;
  slotId: string;
  subject: string;
  body: string;
}

export interface ValidationResult {
  updatedShifts: ShiftRow[];
  notices: Notice[];
}

export function validateThirtySixHourStretches(groups: MemberShifts[]): ValidationResult {
  const notices: Notice[] = [];
  const updated: ShiftRow[] = [];

  for (const g of groups) {
    for (let i=0; i<g.shifts.length; i++) {
      const hours = contiguousStretchHours(g.shifts.map(s => ({startTime: s.startTime, endTime: s.endTime})), i);
      if (hours >= 36) {
        const shift = g.shifts[i];
        shift.color = "yellow";
        shift.labels = Array.from(new Set([...(shift.labels||[]), THIRTY_SIX_HOUR_REASON]));

        notices.push({
          to: "member",
          memberId: g.memberId,
          slotId: shift.slotId,
          subject: "ShiftCommander: 36-hour stretch detected",
          body: `You appear scheduled for approximately ${Math.round(hours)} consecutive hours. Please confirm if this is intentional.`
        });
        notices.push({
          to: "supervisor",
          memberId: g.memberId,
          slotId: shift.slotId,
          subject: "Supervisor alert: 36-hour stretch",
          body: `Member ${g.memberId} has ~${Math.round(hours)} hours contiguous scheduling. Review and confirm intent.`
        });
      }
      updated.push(g.shifts[i]);
    }
  }

  return { updatedShifts: updated, notices };
}