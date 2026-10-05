import Link from "next/link";
import { FiArrowLeft } from "react-icons/fi";
import Brand from "../brand/Brand";
import Eyebrow from "../eyebrow/Eyebrow";
import type { Portal } from "../types";
import "./marketing-panel.css";

export default function MarketingPanel({ portal }: { portal: Portal }) {
  const isChurch = portal === "church";
  const isZonal = portal === "zonal";

  return (
    <section className="auth-story" aria-label="About ZoneStream">
      <div className="story-rings" aria-hidden="true" />
      <div className="story-top">
        <Brand />
        <Link className="back-link" href="/">
          <FiArrowLeft size={16} aria-hidden="true" />
          <span>Back to selection</span>
        </Link>
      </div>

      <div className="story-message">
        <Eyebrow>{isChurch ? "CHURCH PORTAL" : isZonal ? "ZONAL CHURCH PORTAL" : "INDIVIDUAL PORTAL"}</Eyebrow>
        <h1>
          {isChurch ? (
            <>Your church.<br /><span>Your connection.</span></>
          ) : isZonal ? (
            <>One zone.<br /><span>Connected.</span></>
          ) : (
            <>Every service.<br /><span>Closer to you.</span></>
          )}
        </h1>
        <p>
          {isChurch
            ? "Use the unique 10-digit access code issued to your church by the Zonal Church."
            : isZonal
              ? "Manage church access and bring the services of Nigeria South South Zone 1 online."
              : "Experience the presence, teaching, and connection of your zone from wherever you are."}
        </p>
      </div>

      <footer className="story-footer">
        <span className="eyebrow-rule" aria-hidden="true" />
        <span>Nigeria South South Zone 1</span>
      </footer>
    </section>
  );
}
