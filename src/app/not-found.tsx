import Link from "next/link";
import Brand from "../components/brand/Brand";
import MakerSignature from "../components/maker-signature/MakerSignature";
import "./not-found.css";

export default function NotFound() {
  return (
    <main className="zone-not-found-screen">
      <div className="zone-not-found-main">
        <Brand />
        <span className="zone-not-found-code">404</span>
        <h1>This page could not be found</h1>
        <p>The link may be incorrect, or this page may have moved.</p>
        <Link className="zone-not-found-home" href="/">Return to ZoneStream</Link>
      </div>
      <MakerSignature variant="full" />
    </main>
  );
}
