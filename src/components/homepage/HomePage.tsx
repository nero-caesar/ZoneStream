import Link from "next/link";
import { FiHome, FiRadio, FiShield, FiUser } from "react-icons/fi";
import Brand from "../brand/Brand";
import Eyebrow from "../eyebrow/Eyebrow";
import PortalCard from "../portal-card/PortalCard";
import "./homepage.css";

export default function HomePage() {
  return (
    <main className="selection-page">
      <div className="selection-glow selection-glow-blue" aria-hidden="true" />
      <div className="selection-glow selection-glow-coral" aria-hidden="true" />
      <div className="selection-content">
        <header className="selection-header">
          <Brand />
          <div className="secure-label">
            <FiShield size={16} aria-hidden="true" />
            <span>Secure access</span>
          </div>
        </header>

        <section className="selection-hero" aria-labelledby="home-title">
          <Eyebrow>CE BAYELSA · NIGERIA SOUTH SOUTH ZONE 1</Eyebrow>
          <h1 id="home-title">
            Stay connected to
            <br />
            <span>the service.</span>
          </h1>
          <p className="selection-description">
            Your front-row connection to Zonal Headquarters.
            <br className="desktop-break" /> Choose how you would like to continue.
          </p>

          <div className="portal-options" aria-label="Choose a portal">
            <PortalCard
              href="/login-page-individual"
              kind="individual"
              title="Individual"
              description="Watch services and access ZoneStream content."
              icon={FiUser}
            />
            <PortalCard
              href="/login-page-church"
              kind="church"
              title="Church"
              description="Connect your church to Zonal Headquarters broadcasts."
              icon={FiHome}
            />
          </div>

          <div className="zone-status">
            <span className="status-indicator" aria-hidden="true" />
            <span>Zonal Headquarters is online</span>
            <span className="status-divider" aria-hidden="true" />
            <span>Serving churches across Bayelsa</span>
          </div>
        </section>

        <footer className="selection-footer">
          <span>© 2025 ZoneStream</span>
          <div className="selection-footer-links">
            <Link href="/stream/studio" className="selection-studio-link">
              <FiRadio aria-hidden="true" /> Zonal Church studio
            </Link>
            <span>Built for the zone, by the zone.</span>
          </div>
        </footer>
      </div>
    </main>
  );
}
