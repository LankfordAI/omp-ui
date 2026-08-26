import { describe, expect, it } from "vitest";
import { loginPage } from "./login-page";

describe("loginPage", () => {
  it("serves the password form without an alert", () => {
    const page = loginPage(null);
    expect(page).toContain("<!doctype html>");
    expect(page).toContain('<form method="post" action="/login">');
    expect(page).toContain('name="password"');
    expect(page).not.toContain('role="alert"');
  });

  it("renders the error as an escaped alert", () => {
    const page = loginPage("<script>alert(1)</script>");
    expect(page).toContain('role="alert"');
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).not.toContain("<script>alert(1)</script>");
  });
});
