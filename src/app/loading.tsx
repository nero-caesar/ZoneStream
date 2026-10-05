import Brand from "../components/brand/Brand";
import MakerSignature from "../components/maker-signature/MakerSignature";
import "./loading.css";

export default function Loading() {
  return (
    <main className="zone-loading-screen" role="status" aria-live="polite">
      <div className="zone-loading-main">
        <Brand />
        <span className="zone-loading-indicator" aria-hidden="true" />
        <p>Loading ZoneStream</p>
      </div>
      <MakerSignature variant="full" />
    </main>
  );
}
