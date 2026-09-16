import * as assert from "node:assert/strict";
import * as vscode from "vscode";

suite("extension smoke", () => {
  test("is installed in the test host and activates", async () => {
    const ext = vscode.extensions.getExtension("zekaizer.codeonly");
    assert.ok(ext, "extension not found in test host");
    await ext.activate();
    assert.equal(ext.isActive, true);
  });
});
