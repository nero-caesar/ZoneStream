import Link from "next/link";
import { FiChevronRight } from "react-icons/fi";
import type { IconType } from "react-icons";
import "./portal-card.css";

type PortalCardProps = {
  href: string;
  title: string;
  description: string;
  kind: "individual" | "church";
  icon: IconType;
};

export default function PortalCard({ href, title, description, kind, icon: Icon }: PortalCardProps) {
  return (
    <Link className={`portal-card portal-card-${kind}`} href={href}>
      <span className="portal-icon"><Icon size={25} aria-hidden="true" /></span>
      <span className="portal-card-copy">
        <span className="portal-title">{title}</span>
        <span className="portal-description">{description}</span>
      </span>
      <FiChevronRight className="portal-chevron" size={21} aria-hidden="true" />
    </Link>
  );
}
