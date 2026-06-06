import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import App from "./App";
import { SpacetimeDBProvider } from "spacetimedb/react";
import { DbConnection } from "./module_bindings";

// Lightweight render smoke test. It does not require a live SpacetimeDB:
// before a connection is established the app renders the "Connecting…" state.
// A full multiplayer flow is covered manually against a local server for now.
describe("App", () => {
  it("renders the connecting state before a connection is active", () => {
    const connectionBuilder = DbConnection.builder()
      .withUri("ws://localhost:3000")
      .withDatabaseName("chess-race");

    render(
      <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
        <App />
      </SpacetimeDBProvider>,
    );

    expect(screen.getByText(/Chess Race/i)).toBeInTheDocument();
    expect(screen.getByText(/Connecting/i)).toBeInTheDocument();
  });
});
