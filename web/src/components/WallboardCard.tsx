// web/src/components/WallboardCard.tsx
import React from "react";
import { VOLUNTEER_DUTY_NAME, VOLUNTEER_DUTY_REASON } from "../../../server/config/policy";

type Props = {
  assigneeName: string;
  labels?: string[];
  color?: "yellow" | "red" | "none";
  onReplaceVolunteer?: () => void;
  canReplace?: boolean;
};

export default function WallboardCard({ assigneeName, labels, color, onReplaceVolunteer, canReplace }: Props) {
  const isVolunteer = assigneeName === VOLUNTEER_DUTY_NAME;

  return (
    <div className={`card ${color === "yellow" ? "ring-2 ring-yellow-400" : ""}`}>
      <div className="card-title">
        {assigneeName}
      </div>
      {labels && labels.length > 0 && (
        <div className="labels">
          {labels.map((l, i) => (
            <span key={i} className="chip">{l}</span>
          ))}
          {isVolunteer && <span className="chip">{VOLUNTEER_DUTY_REASON}</span>}
        </div>
      )}
      {isVolunteer && canReplace && (
        <button className="btn" onClick={onReplaceVolunteer}>Replace with member…</button>
      )}
    </div>
  );
}