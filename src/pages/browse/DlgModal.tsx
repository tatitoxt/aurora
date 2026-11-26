import { useT } from "../../i18n";
import type { DlgState } from "./types";
import type { Dispatch, SetStateAction } from "react";

/** In-app Save/Create/Rename/Delete dialog — window.prompt/confirm
    are suppressed in automation and look alien anyway. Includes the
    focus trap and IME-safe Enter handling. */
export default function DlgModal({
  dlg,
  setDlg,
  dlgName,
  setDlgName,
  submitDlg,
}: {
  dlg: NonNullable<DlgState>;
  setDlg: Dispatch<SetStateAction<DlgState>>;
  dlgName: string;
  setDlgName: (s: string) => void;
  submitDlg: () => void;
}) {
  const t = useT();
  return (
  <span className="brw__dlg" onClick={() => setDlg(null)}>
    <span
      className="brw__dlgcard"
      role="dialog"
      aria-modal="true"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          setDlg(null);
          return;
        }
        if (e.key !== "Tab") return;
        /* Focus trap: Tab cycles through the card's own
           controls so focus can't fall behind the overlay. */
        const els = Array.from(
          e.currentTarget.querySelectorAll<HTMLElement>(
            "button, input",
          ),
        );
        if (els.length === 0) return;
        const first = els[0];
        const last = els[els.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        } else if (active && !els.includes(active)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }}
    >
      <span className="brw__dlgtitle">
        {dlg.kind === "save"
          ? t("lib.save")
          : dlg.kind === "create"
            ? t("lib.newPlaylist")
            : dlg.kind === "rename"
              ? t("lib.rename")
              : ""}
      </span>
      {(
        <input
          className="brw__dlginput"
          autoFocus
          value={dlgName}
          placeholder={t("lib.playlistName")}
          aria-label={t("lib.playlistName")}
          onChange={(e) => setDlgName(e.target.value)}
          onKeyDown={(e) => {
            /* Enter that confirms an IME candidate must not
               submit — the name hasn't reached dlgName yet. */
            if (e.key === "Enter" && !e.nativeEvent.isComposing)
              submitDlg();
          }}
        />
      )}
      <span className="brw__dlgbtns">
        <button
          className="brw__dlgbtn"
          /* Destructive dialogs focus Cancel: an Enter held through
             key repeat would otherwise submit the confirm the
             instant it gains focus. */
          onClick={() => setDlg(null)}
        >
          {t("brw.cancel")}
        </button>
        <button
          className={`brw__dlgbtn brw__dlgbtn--go ${""}`}
          onClick={submitDlg}
        >
          {dlg.kind === "save"
            ? t("lib.save")
            : dlg.kind === "create"
              ? t("lib.create")
              : dlg.kind === "rename"
                ? t("lib.rename")
                : t("lib.delete")}
        </button>
      </span>
    </span>
  </span>
);
}
