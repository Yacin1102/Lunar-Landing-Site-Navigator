import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("mission dashboard", () => {
  it("renders a loading state before prepared data arrives", () => {
    render(<App />);
    expect(screen.getByText("Loading mission data…")).toBeTruthy();
  });
});
