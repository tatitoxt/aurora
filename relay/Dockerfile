# Noctbeat listen-along relay — tiny room store for WAN sessions.
# Build context: the repo root (workspace members must all be present).
FROM rust:1-slim AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock branding.json ./
COPY crates ./crates
COPY src-tauri/Cargo.toml src-tauri/build.rs src-tauri/tauri.conf.json ./src-tauri/
COPY src-tauri/src ./src-tauri/src
RUN cargo build --release -p noctbeat-relay

FROM debian:bookworm-slim
RUN useradd -r -u 10001 relay
COPY --from=build /app/target/release/noctbeat-relay /usr/local/bin/noctbeat-relay
USER relay
ENV PORT=8787
EXPOSE 8787
CMD ["noctbeat-relay"]
