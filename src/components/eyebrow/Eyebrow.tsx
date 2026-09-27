import type { ReactNode } from "react";
import "./eyebrow.css";

export default function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="eyebrow">
      <span className="eyebrow-rule" />
      <span>{children}</span>
    </div>
  );
}
