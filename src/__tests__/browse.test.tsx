/** Component smoke + behavior tests for the extracted browse modules.
    The bridge falls back to its browser mock outside Tauri, which is
    exactly what jsdom provides. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { render, screen, fireEvent } from "@testing-library/react";
import DlgModal from "../pages/browse/DlgModal";
import CtxMenu from "../pages/browse/CtxMenu";
import Rail from "../pages/browse/Rail";

afterEach(cleanup);

describe("DlgModal", () => {
  it("submits the typed name on Enter", () => {
    const submit = vi.fn();
    render(
      <DlgModal
        dlg={{ kind: "create" }}
        setDlg={() => {}}
        dlgName="mixtape"
        setDlgName={() => {}}
        submitDlg={submit}
      />,
    );
    const input = screen.getByLabelText(/playlist name/i);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submit).toHaveBeenCalled();
  });

  it("rename dialog renders input and cancel", () => {
    render(
      <DlgModal
        dlg={{ kind: "rename", path: "/x.m3u", name: "mixtape" }}
        setDlg={() => {}}
        dlgName=""
        setDlgName={() => {}}
        submitDlg={() => {}}
      />,
    );
    const cancel = screen.getAllByRole("button")[0];
    expect(cancel).toHaveTextContent(/cancel/i);
  });
});

describe("CtxMenu", () => {
  const base = {
    playlists: [{ path: "/p/a.m3u", name: "A" }],
    plTracks: [],
    queue: { items: [], currentIndex: null },
    sel: new Set<number>(),
    go: () => {},
    playPlTrack: () => {},
    removePlTrack: () => {},
    removeSelected: () => {},
    setDlg: () => {},
    setDlgName: () => {},
    flash: () => {},
    fail: () => {},
    deletePlaylistNow: () => {},
  };

  it("offers add-to-playlist for local queue rows", () => {
    render(
      <CtxMenu
        {...base}
        ctx={{ x: 10, y: 10, kind: "queue", index: 0 }}
        setCtx={() => {}}
        queue={{
          items: [
            {
              path: "/music/a.mp3",
              track: {
                id: "1", title: "T", artist: "A", album: "", durationMs: 1000,
                artworkUrl: "", path: "/music/a.mp3",
              } as never,
            },
          ],
          currentIndex: null,
        }}
      />,
    );
    expect(screen.getByText(/add to playlist/i)).toBeInTheDocument();
  });

  it("hides add-to-playlist for remote streams", () => {
    render(
      <CtxMenu
        {...base}
        ctx={{ x: 10, y: 10, kind: "queue", index: 0 }}
        setCtx={() => {}}
        queue={{
          items: [
            {
              path: "remote:spotify:abc",
              track: {
                id: "1", title: "T", artist: "A", album: "", durationMs: 1000,
                artworkUrl: "", path: "remote:spotify:abc",
              } as never,
            },
          ],
          currentIndex: null,
        }}
      />,
    );
    expect(screen.queryByText(/add to playlist/i)).not.toBeInTheDocument();
  });
});

describe("Rail drop guard", () => {
  it("ignores remote: payloads dropped on a playlist", () => {
    const addSpy = vi.fn();
    render(
      <Rail
        view="home"
        q=""
        setQ={() => {}}
        go={() => {}}
        railSearchRef={{ current: null }}
        liked={[]}
        queue={{ items: [], currentIndex: null }}
        playlists={[{ path: "/p/a.m3u", name: "A" }]}
        openPlaylist={() => {}}
        plDrop={null}
        setPlDrop={() => {}}
        setCtx={() => {}}
        setDlg={() => {}}
        setDlgName={() => {}}
        setPlTracks={() => {}}
        flash={addSpy}
        fail={() => {}}
      />,
    );
    const plBtn = screen.getByText("A").closest("button")!;
    const data = {
      getData: () => "remote:spotify:xyz",
      types: ["application/x-noctbeat-track"],
    } as unknown as DataTransfer;
    fireEvent.drop(plBtn, { dataTransfer: data });
    // flash only fires when the backend reports n > 0 — a rejected
    // payload must never reach it
    expect(addSpy).not.toHaveBeenCalled();
  });
});
