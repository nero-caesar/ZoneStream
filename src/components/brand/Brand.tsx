import Image from "next/image";
import "./brand.css";

export default function Brand() {
  return (
    <div className="brand">
      <Image
        src="/logo.png"
        alt="ZoneStream"
        width={1906}
        height={825}
        sizes="220px"
        className="brand-image"
        priority
      />
    </div>
  );
}
