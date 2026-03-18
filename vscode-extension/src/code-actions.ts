import * as vscode from "vscode";

/**
 * Provides KCode-powered code actions (quick fixes, refactoring) in the editor.
 * These show up in the lightbulb menu when text is selected.
 */
export class KCodeCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.Refactor,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    _context: vscode.CodeActionContext,
    _token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    // Only show actions when there is a selection
    if (range.isEmpty) {
      return [];
    }

    const actions: vscode.CodeAction[] = [];

    // Explain code
    const explainAction = new vscode.CodeAction(
      "KCode: Explain this code",
      vscode.CodeActionKind.QuickFix
    );
    explainAction.command = {
      command: "kcode.explainCode",
      title: "Explain Selection",
    };
    actions.push(explainAction);

    // Fix code
    const fixAction = new vscode.CodeAction(
      "KCode: Fix this code",
      vscode.CodeActionKind.QuickFix
    );
    fixAction.command = {
      command: "kcode.fixCode",
      title: "Fix Selection",
    };
    actions.push(fixAction);

    // Refactor code
    const refactorAction = new vscode.CodeAction(
      "KCode: Refactor this code",
      vscode.CodeActionKind.Refactor
    );
    refactorAction.command = {
      command: "kcode.refactorCode",
      title: "Refactor Selection",
    };
    actions.push(refactorAction);

    // Generate tests
    const testAction = new vscode.CodeAction(
      "KCode: Generate tests",
      vscode.CodeActionKind.QuickFix
    );
    testAction.command = {
      command: "kcode.generateTests",
      title: "Generate Tests",
    };
    actions.push(testAction);

    return actions;
  }
}
