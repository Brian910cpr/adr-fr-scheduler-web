// web/src/utils/scheduleUtils.ts
import { isWeekendDriver } from "../../../server/config/policy";

export function displayLabelForSlot(slot: { position: string; startTime: Date }): string | null {
  if (isWeekendDriver(slot)) return "Volunteer Duty (policy placeholder)";
  return null;
}