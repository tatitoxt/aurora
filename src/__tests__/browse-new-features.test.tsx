import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ArtistView from "../pages/browse/ArtistView";
import type { CatalogSong } from "../bridge";

afterEach(cleanup);

const song = (artist: string, preview = true): CatalogSong => ({
  title: "Song",
  artist,
  album: "Alb",
  durationMs: 1000,
  artworkUrl: "",
  previewUrl: preview ? "https://x.test/p.mp3" : undefined,
});

describe("ArtistView new features", () => {
  const base = {
    arName: "Main Artist",
    arLocal: [],
    arLiked: [],
    arLoading: false,
    fail: () => {},
    playExternal: () => {},
    playLiked: () => {},
    goArtist: () => {},
  };

  it("renders preview button when previewUrl exists", () => {
    const songs = [song("Main Artist")];
    render(
      <ArtistView {...base} arSongs={songs} arGroups={[["", songs]]} />,
    );
    expect(screen.getAllByLabelText(/preview/i).length).toBeGreaterThan(0);
  });

  it("no preview button without previewUrl", () => {
    const songs = [song("Main Artist", false)];
    render(
      <ArtistView {...base} arSongs={songs} arGroups={[["", songs]]} />,
    );
    expect(screen.queryByLabelText(/preview/i)).toBeNull();
  });

  it("related artists chips appear for collaborators and navigate", () => {
    const songs = [
      song("Main Artist feat. Collab One", false),
      song("Main Artist & Collab Two", false),
    ];
    const visited: string[] = [];
    render(
      <ArtistView
        {...base}
        goArtist={(n) => visited.push(n)}
        arSongs={songs}
        arGroups={[["", songs]]}
      />,
    );
    const chip = screen.queryByText("Collab One");
    expect(chip).not.toBeNull();
    fireEvent.click(chip!);
    expect(visited).toContain("Collab One");
  });
});
