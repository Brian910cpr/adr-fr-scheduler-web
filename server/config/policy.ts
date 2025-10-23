// server/config/policy.ts
// Centralized policy constants for ShiftCommander / ADR-FR Scheduler

export const VOLUNTEER_DUTY_ID = "VOLUNTEER_DUTY";
export const VOLUNTEER_DUTY_NAME = "Volunteer Duty";
export const VOLUNTEER_DUTY_REASON = "Weekend Driver Restriction";
export const VOLUNTEER_DUTY_SCORE = 200; // Higher than any real max

export const THIRTY_SIX_HOUR_REASON = "36 hour Shift";

// Weekend Driver restriction windows: Sat AM/PM, Sun AM
export function isWeekendDriver(slot: { position: string; startTime: Date }) : boolean {
  const dow = slot.startTime.getDay(); // 0=Sun, 6=Sat
  const hour = slot.startTime.getHours();
  const isSat = (dow === 6);
  const isSun = (dow === 0);
  const isAM = (hour < 12);
  const isPM = (hour >= 12);
  return slot.position === "Driver" && ((isSat && (isAM || isPM)) || (isSun && isAM));
}

// Utility: compute contiguous stretch hours for a given member around a slot.
// Expects shifts sorted by startTime; returns total hours where there is no gap between shifts.
export function contiguousStretchHours(shifts: Array<{startTime: Date; endTime: Date}>, targetIndex: number): number {
  if (!shifts.length) return 0;
  let start = new Date(shifts[targetIndex].startTime);
  let end = new Date(shifts[targetIndex].endTime);

  // extend backward while previous ends exactly at current start
  for (let i = targetIndex - 1; i >= 0; i--) {
    const prev = shifts[i];
    if (prev.endTime.getTime() === start.getTime()) {
      start = new Date(prev.startTime);
    } else if (prev.endTime.getTime() > start.getTime()) {
      // overlap, merge
      start = new Date(Math.min(start.getTime(), prev.startTime.getTime()));
    } else {
      break;
    }
  }

  // extend forward while next starts exactly at current end
  for (let i = targetIndex + 1; i < shifts.length; i++) {
    const next = shifts[i];
    if (next.startTime.getTime() === end.getTime()) {
      end = new Date(next.endTime);
    } else if (next.startTime.getTime() < end.getTime()) {
      // overlap, merge
      end = new Date(Math.max(end.getTime(), next.endTime.getTime()));
    } else {
      break;
    }
  }

  return (end.getTime() - start.getTime()) / (1000 * 60 * 60);
}