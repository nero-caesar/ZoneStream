import Image from "next/image";
import "./maker-signature.css";

export default function MakerSignature({
  variant = "compact",
  brand = "zenko",
}: {
  variant?: "compact" | "full";
  brand?: "zenko" | "zendot";
}) {
  const makerName = brand === "zendot" ? "Zendot Technologies" : "Zenko Technologies";

  return (
    <div className={`maker-signature maker-signature--${variant}`} role="img" aria-label={`Built by ${makerName}`}>
      <span className="maker-signature__coin" aria-hidden="true">
        <Image className="maker-signature__emblem-art" src="/zenko-technologies-emblem.png" alt="" width={1536} height={1024} sizes="110px" />
      </span>
      <span className="maker-signature__copy" aria-hidden="true">
        <span className="maker-signature__built-by">Built by</span>
        <span className="maker-signature__wordmark">
          <span>Z</span><span className="maker-signature__bar-e"><i /><i /><i /></span><span>{brand === "zendot" ? "NDOT" : "NKO"}</span>
        </span>
        <span className="maker-signature__technologies">TECHNOLOGIES</span>
      </span>
    </div>
  );
}
