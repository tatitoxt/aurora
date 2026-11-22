import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VideoBackdrop } from "../VideoBackdrop";

const embedOrigin = "https://www.youtube.com";

function sendPlayerMessage(
  iframe: HTMLIFrameElement,
  origin: string,
  source: MessageEventSource | null,
  data: unknown,
) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin,
        source,
        data: JSON.stringify(data),
      }),
    );
  });
}

describe("VideoBackdrop YouTube embed readiness", () => {
  it("stops startup seeks after the trusted player starts", () => {
    vi.useFakeTimers();
    const { container, unmount } = render(
      <VideoBackdrop url={`${embedOrigin}/embed/test?enablejsapi=1`} posMs={0} playing audible />,
    );
    const iframe = container.querySelector("iframe")!;
    const post = vi.spyOn(iframe.contentWindow!, "postMessage");
    fireEvent.load(iframe);
    const commands = () => post.mock.calls.map(([payload]) => JSON.parse(String(payload)).func);
    expect(commands()).toContain("seekTo");
    expect(commands()).not.toContain("unMute");
    sendPlayerMessage(iframe, embedOrigin, iframe.contentWindow, { event: "onStateChange", info: 1 });
    post.mockClear();
    act(() => vi.advanceTimersByTime(4000));
    expect(commands()).not.toContain("seekTo");
    unmount();
    post.mockRestore();
    vi.useRealTimers();
  });

  it("resets a direct video's readiness on URL changes and playback errors", () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const { container, rerender } = render(
      <VideoBackdrop url="https://example.com/first.mp4" posMs={0} playing={false} />,
    );
    const first = container.querySelector("video")!;
    fireEvent.canPlay(first);
    expect(first).toHaveClass("kbg__video--ready");
    fireEvent.error(first);
    expect(first).not.toHaveClass("kbg__video--ready");
    fireEvent.canPlay(first);
    rerender(<VideoBackdrop url="https://example.com/second.mp4" posMs={0} playing={false} />);
    expect(container.querySelector("video")).not.toHaveClass("kbg__video--ready");
    pause.mockRestore();
  });

  it("only reveals a trusted playing embed and hides it on error", () => {
    const { container } = render(
      <VideoBackdrop
        url={`${embedOrigin}/embed/test?enablejsapi=1`}
        posMs={0}
        playing={false}
      />,
    );
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    if (!iframe) throw new Error("Expected embed iframe");

    sendPlayerMessage(iframe, embedOrigin, window, {
      event: "onStateChange",
      info: 1,
    });
    expect(iframe).not.toHaveClass("kbg__video--ready");
    expect(iframe).toHaveStyle({ opacity: "0" });

    sendPlayerMessage(iframe, "https://attacker.example", iframe.contentWindow, {
      event: "onStateChange",
      info: 1,
    });
    expect(iframe).not.toHaveClass("kbg__video--ready");
    expect(iframe).toHaveStyle({ opacity: "0" });

    sendPlayerMessage(iframe, embedOrigin, iframe.contentWindow, {
      event: "onStateChange",
      info: 1,
    });
    expect(iframe).toHaveClass("kbg__video--ready");

    sendPlayerMessage(iframe, embedOrigin, iframe.contentWindow, {
      event: "onError",
      info: 150,
    });
    expect(iframe).not.toHaveClass("kbg__video--ready");
    expect(iframe).toHaveStyle({ opacity: "0" });
  });
});
