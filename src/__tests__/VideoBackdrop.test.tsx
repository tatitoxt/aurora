import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
