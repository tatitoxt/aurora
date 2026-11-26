import { LockSimple, Sparkle } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { bridge } from "./bridge";
import { branding } from "./branding";
import { useT } from "./i18n";

/** Paywall card shown where a premium-only surface would normally render.
 * Kept small and quiet: the free player remains usable around it. */
export default function PremiumLock({
  compact = false,
  className = "",
}: {
  compact?: boolean;
  className?: string;
}) {
  const t = useT();
  const nav = useNavigate();
  return (
    <div className={`premlock ${compact ? "premlock--compact" : ""} ${className}`}>
      <div className="premlock__icon" aria-hidden="true">
        <LockSimple size={compact ? 16 : 20} weight="fill" />
      </div>
      <div className="premlock__copy">
        <b>
          <Sparkle size={14} weight="fill" /> {t("prem.title")}
        </b>
        <span>{t("prem.copy")}</span>
      </div>
      <div className="premlock__actions">
        <button
          className="premlock__buy"
          onClick={() => void bridge.openUrl(branding.checkoutUrl)}
        >
          {t("prem.upgrade")}
        </button>
        {!compact && (
          <button className="premlock__key" onClick={() => nav("/settings")}>
            {t("prem.enterKey")}
          </button>
        )}
      </div>
    </div>
  );
}
