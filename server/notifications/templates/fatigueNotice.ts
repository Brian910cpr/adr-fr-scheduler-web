// server/notifications/templates/fatigueNotice.ts

export function fatigueMember(hours: number) {
  return {
    subject: "36-hour stretch detected",
    body: `You appear scheduled for ~${Math.round(hours)} consecutive hours. Please confirm if this was intentional.`
  };
}

export function fatigueSupervisor(memberDisplay: string, hours: number) {
  return {
    subject: "Supervisor alert: 36-hour stretch",
    body: `Member ${memberDisplay} is scheduled for ~${Math.round(hours)} consecutive hours. Please review and confirm intent.`
  };
}