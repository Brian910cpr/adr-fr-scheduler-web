// server/notifications/templates/volunteerDuty.ts

export function volunteerDutyAutoAssign(slotISO: string) {
  return {
    subject: "Driver weekend slot auto-set to Volunteer Duty",
    body: `A Driver shift starting ${slotISO} was auto-assigned to "Volunteer Duty" per policy. Supervisors may replace it to fill.`
  };
}

export function volunteerDutyReplaced(slotISO: string, memberName: string) {
  return {
    subject: "Volunteer Duty replaced with member",
    body: `The Volunteer Duty placeholder for the Driver shift at ${slotISO} was replaced by ${memberName}.`
  };
}